import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AiGatewayEngine, type GatewayPolicy, type ModelProvider } from '@assurapay/agent-runtime';
import type { RequestContext } from '@assurapay/shared';
import { createGovernedAnalysisGateway, parseAnalysisFindings } from './governed-analysis';

/**
 * Contract analysis is governed, and cannot quietly stop being governed.
 *
 * The AI convergence audit measured one reachable AI path in this product and found it ungoverned:
 * `POST /api/v1/contract-analysis` reached `deterministicAnalysisGateway`, which inherits no model
 * allowlist, rate limit, timeout, cost ceiling or telemetry. These assertions are in two halves.
 *
 * The first half proves the governance is really inherited rather than reimplemented — each bound is
 * asserted through the adapter, so a refactor that stopped routing through `AiGatewayEngine` would
 * fail here rather than pass quietly with the bounds gone.
 *
 * The second half is a ratchet on the composition itself. A unit test can only prove the adapter
 * governs what it is handed; it cannot prove the application still hands it the reachable route.
 * That is the exact gap the audit found, so it is closed by reading the composition root.
 */

const POLICY: GatewayPolicy = {
  allowedModels: ['sandbox'],
  maxRequestsPerMinute: 2,
  maxCostMinorPerInvocation: 100,
  retries: 0,
};

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    actorUserId: 'user-analyst',
    sessionId: 'session-1',
    identityAssuranceLevel: 'IAL2_VERIFIED',
    activeWorkspaceId: 'workspace-1',
    tenantId: 'tenant-1',
    memberships: ['workspace-1'],
    correlationId: 'corr-1',
    ...overrides,
  };
}

const input = {
  contentReference: 'secure://workspace-1/abc',
  contentHash: 'a'.repeat(64),
  profileKey: 'nigeria-services-v1',
};

/** A provider that answers with whatever it is told to, so the bounds can be probed. */
function provider(
  output: unknown,
  extra: Partial<{ costMinor: number; delayMs: number; id: string }> = {},
): ModelProvider {
  return {
    id: extra.id ?? 'fake',
    async invoke() {
      if (extra.delayMs) await new Promise((resolve) => setTimeout(resolve, extra.delayMs));
      return { output, inputTokens: 1, outputTokens: 1, costMinor: extra.costMinor ?? 0 };
    },
  };
}

const FINDING = {
  type: 'MISSING_PAYMENT_TRIGGER',
  severity: 'HIGH',
  title: 'Payment trigger not explicit',
  confidence: 0.9,
  sourceReferences: [{ documentVersionId: 'v1', section: 'Payment' }],
};

function gateway(provider: ModelProvider, policy: GatewayPolicy = POLICY) {
  return createGovernedAnalysisGateway(new AiGatewayEngine([provider], policy), {
    model: 'sandbox',
    promptVersion: 'contract-analysis/1',
  });
}

describe('analysis inherits the gateway’s bounds rather than reimplementing them', () => {
  it('refuses a model the policy does not allow', async () => {
    // The bound that matters most: a deployment cannot analyse against an unapproved model.
    const ai = new AiGatewayEngine([provider({ findings: [] })], POLICY);
    const unapproved = createGovernedAnalysisGateway(ai, {
      model: 'gpt-whatever',
      promptVersion: 'contract-analysis/1',
    });
    await expect(unapproved.analyze(context(), input)).rejects.toThrow('MODEL_NOT_ALLOWED');
  });

  it('applies the per-tenant rate limit, and applies it per tenant', async () => {
    const governed = gateway(provider({ findings: [] }));
    await governed.analyze(context(), input);
    await governed.analyze(context(), input);
    await expect(governed.analyze(context(), input)).rejects.toThrow('AI_RATE_LIMIT_EXCEEDED');

    // A second tenant has its own allowance — one tenant cannot exhaust another's.
    await expect(
      governed.analyze(context({ tenantId: 'tenant-2', activeWorkspaceId: 'workspace-2', memberships: ['workspace-2'] }), input),
    ).resolves.toBeDefined();
  });

  it('applies the cost ceiling', async () => {
    const governed = gateway(provider({ findings: [] }, { costMinor: 101 }));
    await expect(governed.analyze(context(), input)).rejects.toThrow('AI_COST_LIMIT_EXCEEDED');
  });

  it('applies the timeout', async () => {
    const governed = createGovernedAnalysisGateway(
      new AiGatewayEngine([provider({ findings: [] }, { delayMs: 50 })], POLICY),
      { model: 'sandbox', promptVersion: 'contract-analysis/1', timeoutMs: 1 },
    );
    await expect(governed.analyze(context(), input)).rejects.toThrow('AI_PROVIDER_TIMEOUT');
  });

  it('records the provider that actually answered, not the one that was asked', async () => {
    // With fallback configured these differ, and the run has to record what ran.
    const first = { ...provider({ findings: [] }, { id: 'primary' }), invoke: async () => { throw new Error('down'); } };
    const governed = createGovernedAnalysisGateway(
      new AiGatewayEngine([first as ModelProvider, provider({ findings: [FINDING] }, { id: 'secondary' })], POLICY),
      { model: 'sandbox', promptVersion: 'contract-analysis/1' },
    );
    const result = await governed.analyze(context(), input);
    expect(result.modelVersion).toBe('secondary');
    expect(result.promptVersion).toBe('contract-analysis/1');
  });

  it('does not put agreement text into the prompt, only a reference and a digest', async () => {
    // The document is referenced rather than inlined: this path has no reason to hold contract body
    // text, and a prompt built from it would carry customer content into model logs.
    let seen = '';
    const governed = gateway({
      id: 'spy',
      async invoke(call) {
        seen = call.prompt;
        return { output: { findings: [] }, inputTokens: 0, outputTokens: 0, costMinor: 0 };
      },
    });
    await governed.analyze(context(), input);
    expect(seen).toContain(input.contentReference);
    expect(seen).toContain(input.contentHash);
  });
});

describe('model output is untrusted proposal data', () => {
  it('parses a well-formed finding', async () => {
    const result = await gateway(provider({ findings: [FINDING] })).analyze(context(), input);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].sourceReferences[0].section).toBe('Payment');
  });

  it('reads the sandbox provider’s refusal as "no findings" rather than an error', () => {
    // Every deployment of this repository today. An `AI_ASSISTED` run must still complete and record
    // honestly that nothing was found, rather than failing as though the platform were broken.
    expect(parseAnalysisFindings({ sandbox: true, note: 'no inference' })).toEqual([]);
  });

  it('refuses output that claims findings but malforms them', () => {
    for (const bad of [
      { findings: 'nope' },
      { findings: [{ type: 'X', severity: 'HIGH', title: 'T' }] },
      { findings: [{ type: 'X', severity: 'SEVERE', title: 'T', confidence: 0.5 }] },
      { findings: [{ type: '', severity: 'HIGH', title: 'T', confidence: 0.5 }] },
      { findings: [{ type: 'X', severity: 'HIGH', title: 'T', confidence: 1.5 }] },
    ])
      expect(() => parseAnalysisFindings(bad), JSON.stringify(bad)).toThrow(/AI_ANALYSIS/);
  });

  it('drops a source reference it cannot read rather than inventing its fields', () => {
    // The engine's own SOURCE_REFERENCE_REQUIRED then refuses the finding, which is where that
    // judgement belongs — rather than this adapter fabricating a citation to get past it.
    const parsed = parseAnalysisFindings({
      findings: [{ ...FINDING, sourceReferences: [{ documentVersionId: 'v1' }, 'nonsense'] }],
    });
    expect(parsed[0].sourceReferences).toEqual([]);
  });

  it('refuses a gateway with no model or no prompt version', () => {
    const ai = new AiGatewayEngine([provider({})], POLICY);
    expect(() => createGovernedAnalysisGateway(ai, { model: '', promptVersion: '1' })).toThrow(
      'AI_ANALYSIS_MODEL_REQUIRED',
    );
    expect(() => createGovernedAnalysisGateway(ai, { model: 'sandbox', promptVersion: '  ' })).toThrow(
      'AI_ANALYSIS_PROMPT_VERSION_REQUIRED',
    );
  });
});

describe('ratchet: no reachable AI path bypasses the gateway', () => {
  /**
   * Source with comments removed, because this ratchet is about what the composition *does*.
   *
   * These files explain the bypass they exist to prevent, so a ratchet reading raw text would match
   * its own documentation and fail — and the obvious way to "fix" that is to delete the explanation,
   * which is precisely the wrong direction.
   */
  const read = (relative: string) =>
    readFileSync(path.join(__dirname, '..', relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('composes contract analysis only with the governed gateway', () => {
    // The audit's finding was a composition defect, not a logic defect, so it is guarded by reading
    // the composition. `deterministicAnalysisGateway` returns a hardcoded finding and calls no
    // model; wiring it back into the reachable route would restore exactly the bypass that was found.
    expect(read('lib/trust-app.ts')).not.toContain('new ContractAnalysisEngine');
    const runtimeApp = read('lib/agent-runtime-app.ts');
    expect(runtimeApp).toContain('createGovernedAnalysisGateway');
    expect(runtimeApp).not.toContain('deterministicAnalysisGateway');
  });

  it('routes the reachable analysis endpoint at the governed engine', () => {
    const route = read('app/api/v1/contract-analysis/route.ts');
    expect(route).toContain('getGovernedContractAnalysis');
    expect(route).not.toContain('intelligence.analysis');
  });

  it('leaves no second AiGatewayEngine, because the rate-limit window is per instance', () => {
    // Two instances would silently double every tenant's allowance.
    const constructions = ['lib/agent-runtime-app.ts', 'lib/trust-app.ts', 'lib/governed-analysis.ts']
      .map((file) => (read(file).match(/new AiGatewayEngine/g) ?? []).length)
      .reduce((total, count) => total + count, 0);
    expect(constructions).toBe(0);
  });
});
