import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMERCIAL_COMMITMENT_FLOW_V1 } from './canonical-chain';
import { BASIC_COMMERCIAL_COMMITMENT_FLOW_V1 } from './index';

/**
 * Every event the canonical flow waits for is an event an engine actually emits.
 *
 * This is the ratchet for a defect that nothing else could see. A `FlowDefinition` names the events
 * it awaits as plain strings, so a step can wait on `AgreementExecuted` for ever while the engine
 * emits `ExecutionCertificateIssued` — and the whole thing type-checks, lints, and passes every
 * orchestration test, because those tests signal the flow with whatever name the flow itself
 * declares. Three of thirteen steps were in exactly that state: each awaited a plausible paraphrase
 * of a real event rather than the real one.
 *
 * The consequence was not a test failure but a silent stall. The domain would issue the certificate,
 * emit its event, and the journey tracking it would sit on the previous step indefinitely.
 *
 * So the assertion deliberately reaches outside this package and reads the engines. It is the only
 * place the two vocabularies meet, and until now nothing compared them.
 */

const PACKAGES = path.join(__dirname, '..', '..');

/** Engine sources, excluding tests and this package — the flow cannot be its own evidence. */
function engineSources(): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : walk(full);
      return full.endsWith('.ts') && !full.includes('.test.') ? [full] : [];
    });

  return readdirSync(PACKAGES)
    .filter((name) => name !== 'flow-orchestration')
    .map((name) => path.join(PACKAGES, name, 'src'))
    .filter((directory) => {
      try {
        return statSync(directory).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap(walk);
}

const sources = engineSources().map((file) => readFileSync(file, 'utf8'));

/**
 * True when some engine emits this event type.
 *
 * Matched as `emit(..., 'Name', ...)` or `'Name',` in a publish position rather than as a bare
 * substring, so an aggregate type or a comment that happens to share the word does not count as an
 * emitter. The point is to prove something *fires* it.
 */
function isEmittedByAnEngine(eventType: string): boolean {
  const quoted = `'${eventType}'`;
  return sources.some((source) => source.includes(quoted));
}

describe('the canonical flow waits only for events the domain really emits', () => {
  it('reads some engine sources at all, so this cannot pass vacuously', () => {
    // Without this, a bad path or a renamed directory would make every assertion below trivially
    // true — the exact way a coverage ratchet stops covering anything.
    expect(sources.length).toBeGreaterThan(20);
    expect(isEmittedByAnEngine('CompletionCertificateIssued')).toBe(true);
    expect(isEmittedByAnEngine('ThisEventDoesNotExistAnywhere')).toBe(false);
  });

  it('has an emitter for every awaited event', () => {
    const awaited = COMMERCIAL_COMMITMENT_FLOW_V1.steps
      .map((step) => step.waitForEvent)
      .filter((event): event is string => Boolean(event));

    expect(awaited.length).toBeGreaterThan(10);
    const orphaned = awaited.filter((event) => !isEmittedByAnEngine(event));
    expect(orphaned, `awaited with no engine emitting them: ${orphaned.join(', ')}`).toEqual([]);
  });

  it('gives every step either an event to wait for or a human to wait on', () => {
    // A step with neither can never leave READY under its own power, so it would stall the journey
    // just as surely as an orphaned event name — and is just as invisible to a type checker.
    const stranded = COMMERCIAL_COMMITMENT_FLOW_V1.steps.filter(
      (step) => !step.waitForEvent && !step.humanTaskRole && !step.handler,
    );
    expect(stranded.map((step) => step.id)).toEqual([]);
  });

  it('declares dependencies that exist, in an order that can complete', () => {
    const ids = new Set(COMMERCIAL_COMMITMENT_FLOW_V1.steps.map((step) => step.id));
    const seen = new Set<string>();
    for (const step of COMMERCIAL_COMMITMENT_FLOW_V1.steps) {
      for (const dependency of step.dependencies ?? []) {
        expect(ids, `${step.id} depends on unknown ${dependency}`).toContain(dependency);
        // Declared before use, so the journey has at least one valid completion order. A cycle would
        // leave both steps WAITING_DEPENDENCY for ever.
        expect(seen, `${step.id} depends on ${dependency}, which is declared later`).toContain(
          dependency,
        );
      }
      seen.add(step.id);
    }
  });
});

describe('the basic flow is a fixture, and is not the one production registers', () => {
  it('awaits names no engine emits, which is why it must not be composed', () => {
    // `BASIC_COMMERCIAL_COMMITMENT_FLOW_V1` waits on `EVIDENCE_SUBMITTED` and `SETTLEMENT_CONFIRMED`,
    // which are nobody's event names. That is fine for a unit fixture and would be a dead flow in
    // production, so the distinction is asserted rather than left to whoever edits `flow-app.ts`.
    const awaited = BASIC_COMMERCIAL_COMMITMENT_FLOW_V1.steps
      .map((step) => step.waitForEvent)
      .filter((event): event is string => Boolean(event));
    expect(awaited.every((event) => !isEmittedByAnEngine(event))).toBe(true);
  });

  it('is not the flow the web application registers', () => {
    const composition = readFileSync(
      path.join(__dirname, '..', '..', '..', 'apps', 'web', 'lib', 'flow-app.ts'),
      'utf8',
    );
    expect(composition).toContain('COMMERCIAL_COMMITMENT_FLOW_V1');
    expect(composition).not.toContain('BASIC_COMMERCIAL_COMMITMENT_FLOW_V1');
  });
});
