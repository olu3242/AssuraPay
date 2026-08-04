import { readJsonIfPresent } from './util/fsx.ts';
import { sortBy } from './util/serialize.ts';
import { GOVERNANCE_POLICY, absolute } from './paths.ts';
import type {
  ExecutionManifest,
  Finding,
  GovernanceEvaluation,
  GovernancePolicy,
  ValidationOutcome,
} from './types.ts';

export const DEFAULT_POLICY: GovernancePolicy = {
  phase: 1,
  exemptRules: {},
  baseline: [],
};

export function loadGovernancePolicy(repoRoot: string): GovernancePolicy {
  const policy = readJsonIfPresent<GovernancePolicy>(
    absolute(repoRoot, GOVERNANCE_POLICY),
  );
  return policy ?? DEFAULT_POLICY;
}

/**
 * Stable identity of a finding: the rule plus the thing it is about. Message
 * wording can change freely without moving a finding in or out of the baseline.
 */
export function fingerprint(finding: Finding): string {
  return `${finding.rule}:${finding.subject ?? finding.location ?? finding.message}`;
}

/**
 * Applies the staged governance policy to the manifest's reconciliation findings.
 *
 * Phase 1 reports. Phase 2 fails only on findings absent from the baseline, so
 * new violations are blocked while pre-existing ones stay visible as warnings.
 * Phase 3 fails on everything and ignores the baseline.
 *
 * Resolved baseline entries are reported too: once a violation is fixed, its
 * fingerprint should be removed so the baseline cannot silently re-admit it.
 */
export function evaluateGovernance(
  manifest: ExecutionManifest,
  policy: GovernancePolicy,
): GovernanceEvaluation {
  const baseline = new Set(policy.baseline);
  const current = manifest.reconciliationFindings;
  const currentFingerprints = new Set(current.map(fingerprint));

  const introduced: string[] = [];
  const findings: Finding[] = [];

  for (const finding of current) {
    const id = fingerprint(finding);
    const exemptReason = policy.exemptRules[finding.rule];
    const isBaselined = baseline.has(id);

    if (exemptReason) {
      findings.push({
        ...finding,
        severity: 'info',
        message: `${finding.message} (rule exempt: ${exemptReason})`,
      });
      continue;
    }

    let severity: Finding['severity'] = finding.severity;
    if (policy.phase === 1) {
      severity = finding.severity === 'error' ? 'warning' : finding.severity;
    } else if (policy.phase === 2) {
      severity = isBaselined ? 'warning' : 'error';
    } else {
      severity = 'error';
    }

    if (severity === 'error' && !isBaselined) introduced.push(id);

    findings.push({
      ...finding,
      severity,
      message: isBaselined
        ? `${finding.message} (baselined pre-existing violation)`
        : finding.message,
    });
  }

  const resolved = [...baseline].filter((id) => !currentFingerprints.has(id)).sort();

  for (const id of resolved) {
    findings.push({
      rule: 'governance/stale-baseline',
      severity: 'warning',
      subject: id,
      message:
        `Baseline entry "${id}" no longer matches any finding. Remove it from ` +
        'governance-policy.json so the violation cannot be silently re-admitted.',
      location: GOVERNANCE_POLICY,
    });
  }

  return {
    phase: policy.phase,
    baselined: current.filter((finding) => baseline.has(fingerprint(finding))).length,
    introduced: introduced.sort(),
    resolved,
    findings: sortBy(findings, (finding) => `${finding.rule}:${finding.message}`),
    passed: findings.every((finding) => finding.severity !== 'error'),
  };
}

/** Adapts a governance evaluation to the shape the certification runner expects. */
export function toValidationOutcome(
  evaluation: GovernanceEvaluation,
): ValidationOutcome {
  return {
    validator: 'governance',
    passed: evaluation.passed,
    checked: evaluation.findings.length,
    findings: evaluation.findings,
  };
}

/** The baseline that would accept every current finding as pre-existing. */
export function proposeBaseline(manifest: ExecutionManifest): string[] {
  return [...new Set(manifest.reconciliationFindings.map(fingerprint))].sort();
}
