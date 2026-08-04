import type {
  CapabilityLifecycle,
  CapabilityStatus,
  CertificationReport,
} from './types.ts';

/**
 * Derives lifecycle from evidence. Every input is observable, so a lifecycle
 * state is never a claim someone typed — it is a conclusion the repository
 * supports.
 *
 *   missing       no evidence, and not yet startable
 *   planned       no evidence, dependencies met, so it is startable now
 *   implementing  some evidence present
 *   implemented   all evidence present
 *   validated     all evidence present and its own certification script is green
 *   certified     validated and the full certification run is green
 *   released      certified and the evidence is present on the default branch
 *   deferred      declared out of scope
 */
export function deriveLifecycle(input: {
  status: CapabilityStatus;
  executable: boolean;
  onDefaultBranch: boolean;
  certification: CertificationReport | null;
  certifyScript: string | null;
}): CapabilityLifecycle {
  if (input.status === 'deferred') return 'deferred';

  // `lost` and `unreachable` are absent at HEAD. They surface as missing here;
  // the status field carries the fact that the work is recoverable.
  if (input.status === 'missing' || input.status === 'lost' || input.status === 'unreachable') {
    return input.executable ? 'planned' : 'missing';
  }

  if (input.status === 'partial') return 'implementing';

  // status === 'implemented' from here.
  const certification = input.certification;
  if (!certification) return 'implemented';

  const ownGateGreen = capabilityGateGreen(certification, input.certifyScript);
  if (!ownGateGreen) return 'implemented';
  if (!certification.passed) return 'validated';

  return input.onDefaultBranch ? 'released' : 'certified';
}

/**
 * Whether the gate that covers this capability passed.
 *
 * A capability's `certify` script is a repository script name such as
 * `certify:identity`, which the certification runner does not execute directly —
 * it runs the aggregate test steps. So the test steps are what stand in for a
 * capability-specific gate, and `repo:certify` capabilities map to the whole run.
 */
function capabilityGateGreen(
  certification: CertificationReport,
  certifyScript: string | null,
): boolean {
  const relevant = certification.steps.filter((step) =>
    certifyScript === 'repo:certify'
      ? !step.skipped
      : ['test:unit', 'test:integration', 'test:e2e'].includes(step.id) && !step.skipped,
  );

  if (relevant.length === 0) return false;
  return relevant.every((step) => step.passed);
}

export function summariseLifecycle(
  states: CapabilityLifecycle[],
): Record<CapabilityLifecycle, number> {
  const summary: Record<CapabilityLifecycle, number> = {
    missing: 0,
    planned: 0,
    implementing: 0,
    implemented: 0,
    validated: 0,
    certified: 0,
    released: 0,
    deferred: 0,
  };
  for (const state of states) summary[state] += 1;
  return summary;
}
