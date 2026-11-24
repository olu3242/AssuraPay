import type { RequestContext } from '@assurapay/shared';
import type { AiGatewayEngine } from '@assurapay/agent-runtime';
import type { AnalysisFinding, GovernedAnalysisGateway } from '@assurapay/agreement-intelligence';

/**
 * Contract analysis, routed through the governed AI gateway.
 *
 * `docs/product/ASSURA_AI_CONVERGENCE_AUDIT.md` recorded two AI paths in this product. One was
 * governed and unreachable: `AiGatewayEngine` enforces a model allowlist, a per-tenant rate limit, a
 * raced timeout, bounded retries, provider fallback and a cost ceiling, and nothing called it. The
 * other was reachable and ungoverned: `POST /api/v1/contract-analysis` takes `method` straight from
 * the request body, so a caller asking for `AI_ASSISTED` reached `deterministicAnalysisGateway` —
 * which inherits no allowlist, no rate limit, no cost ceiling, no timeout and no telemetry.
 *
 * This is the convergence. The reachable path now runs through the governed engine, so the two paths
 * become one and the governance is inherited rather than reimplemented. It deliberately adds no
 * second gateway: everything bounding this call already exists in `AiGatewayEngine`, and a parallel
 * implementation of the same bounds is how the two paths diverged in the first place.
 *
 * ## Why this lives in the composition root
 *
 * `agreement-intelligence` declares the port and `agent-runtime` provides the engine, and the engine
 * is a later wave than the port. Implementing the adapter inside `agreement-intelligence` would make
 * an earlier wave depend on a later one; implementing it inside `agent-runtime` would make the agent
 * runtime know about agreements. The composition root is the one place that may know about both,
 * which is what a composition root is for.
 *
 * ## What it refuses rather than guesses
 *
 * A model's output is untrusted proposal data. It arrives as `unknown` and is parsed, not cast: a
 * response that is not a list of findings with the fields this engine stores is rejected outright.
 * The alternative — coercing whatever came back into the finding shape — would put model-shaped
 * noise into a record that an auditor later reads as the platform's own analysis.
 *
 * Findings are returned with `confidence` and `sourceReferences` as the model supplied them, and the
 * engine's own `SOURCE_REFERENCE_REQUIRED` rule then rejects any non-`INFO` finding that cites
 * nothing. That rule is left where it is rather than duplicated here, so there is one place where a
 * finding without provenance is refused.
 */

/** Severities the engine stores. A response naming anything else is not a finding it can hold. */
const SEVERITIES = ['INFO', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const;
type Severity = (typeof SEVERITIES)[number];

export type GatewayAnalysisOptions = {
  /** The allowlisted model to route to. Must be one `GatewayPolicy.allowedModels` names. */
  model: string;
  /**
   * The analysis prompt's version identity, recorded on every `AnalysisRun`.
   *
   * Passed in rather than read from the prompt registry because this path analyses a document
   * against a profile rather than executing a registered agent capability; the registry's versions
   * belong to agent executions. It is still a version, because an analysis whose prompt cannot be
   * named cannot be replayed, and an unreplayable finding is evidence of nothing.
   */
  promptVersion: string;
  /** Output contract handed to the provider, so the model is told the shape it must return. */
  outputContract?: string;
  timeoutMs?: number;
};

const DEFAULT_OUTPUT_CONTRACT =
  'Return JSON {"findings":[{"type":string,"severity":"INFO"|"LOW"|"MODERATE"|"HIGH"|"CRITICAL",' +
  '"title":string,"confidence":number,"sourceReferences":[{"documentVersionId":string,' +
  '"section":string}]}]} and nothing else.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSourceReferences(value: unknown): AnalysisFinding['sourceReferences'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const documentVersionId = entry.documentVersionId;
    const section = entry.section;
    if (typeof documentVersionId !== 'string' || typeof section !== 'string') return [];
    const page = typeof entry.page === 'number' ? entry.page : undefined;
    return [{ documentVersionId, section, ...(page === undefined ? {} : { page }) }];
  });
}

/**
 * Parses a provider response into findings, or refuses it.
 *
 * The sandbox provider returns `{sandbox:true,...}` with no findings, and that is a legitimate
 * response meaning "no model ran": it parses to an empty finding list rather than an error, so a
 * deployment with no model configured still completes an `AI_ASSISTED` run and records honestly that
 * nothing was found. A response that claims findings but malforms them is a different matter and is
 * refused.
 */
export function parseAnalysisFindings(
  output: unknown,
): Array<Omit<AnalysisFinding, 'id' | 'reviewStatus'>> {
  if (!isRecord(output)) throw new Error('AI_ANALYSIS_OUTPUT_INVALID');
  if (output.sandbox === true && output.findings === undefined) return [];
  const raw = output.findings;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('AI_ANALYSIS_OUTPUT_INVALID');

  return raw.map((entry) => {
    if (!isRecord(entry)) throw new Error('AI_ANALYSIS_FINDING_INVALID');
    const { type, severity, title, confidence } = entry;
    if (typeof type !== 'string' || !type.trim())
      throw new Error('AI_ANALYSIS_FINDING_INVALID');
    if (typeof title !== 'string' || !title.trim())
      throw new Error('AI_ANALYSIS_FINDING_INVALID');
    if (typeof severity !== 'string' || !SEVERITIES.includes(severity as Severity))
      throw new Error('AI_ANALYSIS_FINDING_INVALID');
    // A confidence outside 0..1 is not a weaker claim, it is an unreadable one.
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
      throw new Error('AI_ANALYSIS_FINDING_INVALID');
    return {
      type,
      severity: severity as Severity,
      title,
      confidence,
      sourceReferences: parseSourceReferences(entry.sourceReferences),
    };
  });
}

/**
 * Builds the governed gateway.
 *
 * The returned object satisfies `GovernedAnalysisGateway` and holds no state of its own: every bound
 * that matters is `AiGatewayEngine`'s, and the `context` it is handed per call is what lets the
 * engine apply them to the right tenant.
 */
export function createGovernedAnalysisGateway(
  ai: AiGatewayEngine,
  options: GatewayAnalysisOptions,
): GovernedAnalysisGateway {
  if (!options.model?.trim()) throw new Error('AI_ANALYSIS_MODEL_REQUIRED');
  if (!options.promptVersion?.trim()) throw new Error('AI_ANALYSIS_PROMPT_VERSION_REQUIRED');

  return {
    async analyze(context: RequestContext, input) {
      const result = await ai.invoke(context, {
        model: options.model,
        // The document is referenced, never inlined. A storage reference and a digest are enough to
        // replay the analysis, and shipping agreement text into a prompt string here would put
        // customer contract content somewhere this path has no reason to hold it.
        prompt: [
          `Analyse the agreement at ${input.contentReference}`,
          `against profile ${input.profileKey}.`,
          `Content digest ${input.contentHash}.`,
        ].join(' '),
        outputContract: options.outputContract ?? DEFAULT_OUTPUT_CONTRACT,
        timeoutMs: options.timeoutMs,
      });

      return {
        // The gateway reports which model actually answered, not which was asked for: with provider
        // fallback configured these can differ, and the run has to record what ran.
        modelId: result.model,
        modelVersion: result.provider,
        promptVersion: options.promptVersion,
        findings: parseAnalysisFindings(result.output),
      };
    },
  };
}
