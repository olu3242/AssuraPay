/**
 * Repository Execution Operating System (REOS) — shared contracts.
 *
 * Determinism rule: Stages 1–4 (discover, forensics, manifest, dependencies) are
 * pure functions of repository state. Identical repository state must produce
 * byte-identical artifacts, so no wall-clock value may enter those structures.
 * Stages 6–7 (certify, report) are observational and may record durations.
 */

export const REOS_VERSION = '1.0.0';

export type CapabilityStatus =
  | 'implemented'
  | 'partial'
  | 'missing'
  | 'lost'
  | 'unreachable'
  | 'deferred';

export type FindingSeverity = 'error' | 'warning' | 'info';

export type Finding = {
  rule: string;
  severity: FindingSeverity;
  message: string;
  location?: string;
  evidence?: string[];
  /**
   * Stable identity of what the finding is about — an engine id, a package
   * directory, a class name. Governance baselines key on `rule:subject` so that
   * rewording a message never silently un-baselines or re-baselines a finding.
   */
  subject?: string;
};

/**
 * How far a capability has progressed, as distinct from what its evidence looks
 * like. `CapabilityStatus` answers "what does the repository show"; lifecycle
 * answers "how far along is it", and is derived from status plus executability,
 * certification results and presence on the default branch.
 *
 * `lost` and `unreachable` statuses both surface as lifecycle `missing`; the
 * status field is what tells an agent the work is recoverable rather than unbuilt.
 */
export type CapabilityLifecycle =
  | 'missing'
  | 'planned'
  | 'implementing'
  | 'implemented'
  | 'validated'
  | 'certified'
  | 'released'
  | 'deferred';

export const CAPABILITY_LIFECYCLE_ORDER: CapabilityLifecycle[] = [
  'missing',
  'planned',
  'implementing',
  'implemented',
  'validated',
  'certified',
  'released',
];

export type ValidationOutcome = {
  validator: string;
  passed: boolean;
  checked: number;
  findings: Finding[];
};

/* ---------------------------------------------------------------- Stage 1 */

export type TestKind =
  | 'unit'
  | 'integration'
  | 'e2e'
  | 'security'
  | 'performance';

export type TestCounts = Record<TestKind, number>;

export type PackageRecord = {
  name: string;
  directory: string;
  main: string | null;
  moduleType: string | null;
  workspaceDependencies: string[];
  externalDependencies: string[];
  sourceFiles: number;
  sourceLines: number;
  exportedClasses: string[];
  testFiles: string[];
  tests: TestCounts;
};

export type ApplicationRecord = {
  name: string;
  directory: string;
  framework: string;
  routes: number;
  workspaceDependencies: string[];
};

export type EngineRecord = {
  id: string;
  name: string;
  wave: number;
  waveName: string;
  responsibility: string;
  declaredStatus: string | null;
};

export type CertificationTarget = {
  script: string;
  command: string;
  packageDirectory: string | null;
  testNamePattern: string | null;
};

export type RuntimeRegistration = {
  compositionRoot: string;
  registeredEngines: string[];
};

export type DocumentRecord = {
  path: string;
  title: string;
  category: string;
};

export type AdrRecord = {
  path: string;
  identifier: string;
  title: string;
};

export type MigrationRecord = {
  id: string;
  name: string;
  path: string;
  declaresRowLevelSecurity: boolean;
  declaresPolicies: number;
};

export type WorkflowRecord = {
  path: string;
  name: string;
  triggers: string[];
  jobs: string[];
  nodeVersion: string | null;
};

export type GitState = {
  branch: string;
  head: string;
  headShort: string;
  clean: boolean;
  dirtyFiles: string[];
  upstream: string | null;
  remotes: string[];
  branches: string[];
  tags: string[];
  reflogAvailable: boolean;
};

export type DiscoverySnapshot = {
  reosVersion: string;
  stage: 'discover';
  repository: {
    name: string;
    version: string;
    packageManager: string | null;
    git: GitState;
  };
  packages: PackageRecord[];
  applications: ApplicationRecord[];
  engines: EngineRecord[];
  certificationTargets: CertificationTarget[];
  runtime: {
    registrations: RuntimeRegistration[];
    exportedEngines: string[];
    unregisteredEngines: string[];
    duplicatedEngines: string[];
  };
  documentation: DocumentRecord[];
  adrs: AdrRecord[];
  migrations: MigrationRecord[];
  tests: {
    files: number;
    byKind: TestCounts;
  };
  workflows: WorkflowRecord[];
  totals: {
    packages: number;
    applications: number;
    engines: number;
    documents: number;
    migrations: number;
    testFiles: number;
  };
};

/* ---------------------------------------------------------------- Stage 2 */

export type CapabilityEvidenceRule = {
  paths?: string[];
  symbols?: string[];
  tests?: string[];
};

export type CapabilityDefinition = {
  id: string;
  title: string;
  kind: 'platform' | 'engine';
  /** Lower numbers execute first. */
  priority: number;
  dependsOn: string[];
  evidence: CapabilityEvidenceRule;
  certify: string | null;
  requiresLiveInfrastructure?: boolean;
  /** Explicit scope estimate, used in place of counting evidence probes. */
  scope?: { files: number; tests: number };
  notes?: string;
};

export type CapabilityRegistry = {
  version: string;
  enginePackages: Record<string, string | null>;
  capabilities: CapabilityDefinition[];
};

export type EvidenceProbe = {
  kind: 'path' | 'symbol' | 'test';
  query: string;
  satisfied: boolean;
  matches: string[];
};

export type GitEvidence = {
  refsContaining: string[];
  historicalCommits: string[];
  removedFromHead: boolean;
  reachableFromHead: boolean;
};

export type CapabilityForensics = {
  id: string;
  title: string;
  kind: 'platform' | 'engine';
  status: CapabilityStatus;
  /** True when the capability's evidence is already present on the default branch. */
  onDefaultBranch: boolean;
  satisfiedProbes: number;
  totalProbes: number;
  probes: EvidenceProbe[];
  git: GitEvidence;
  rationale: string;
};

export type ForensicsReport = {
  reosVersion: string;
  stage: 'forensics';
  head: string;
  capabilities: CapabilityForensics[];
  summary: Record<CapabilityStatus, number>;
};

/* ---------------------------------------------------------------- Stage 3 */

export type EngineReconciliation = {
  id: string;
  name: string;
  wave: number;
  declaredStatus: string | null;
  observedStatus: CapabilityStatus;
  lifecycle: CapabilityLifecycle;
  packageDirectory: string | null;
  certificationScript: string | null;
  divergent: boolean;
};

export type ExecutionManifest = {
  reosVersion: string;
  stage: 'manifest';
  /**
   * Content digest of this manifest, excluding the digest field itself. Ledger
   * entries record it so an execution can be tied to the exact manifest it read.
   */
  manifestDigest: string;
  identity: {
    repository: string;
    version: string;
    branch: string;
    head: string;
    clean: boolean;
  };
  architecture: {
    waves: { wave: number; name: string; engines: string[] }[];
    canonicalChain: string[];
    packageCount: number;
    applicationCount: number;
  };
  packages: PackageRecord[];
  applications: ApplicationRecord[];
  engines: EngineReconciliation[];
  runtime: DiscoverySnapshot['runtime'];
  platformCapabilities: CapabilityForensics[];
  implementedCapabilities: string[];
  missingCapabilities: string[];
  /** Count of capabilities and engines at each lifecycle state. */
  lifecycleSummary: Record<CapabilityLifecycle, number>;
  certification: {
    targets: number;
    scripted: string[];
    unscripted: string[];
  };
  dependencyGraph: {
    id: string;
    dependsOn: string[];
    blocks: string[];
    status: CapabilityStatus;
    lifecycle: CapabilityLifecycle;
  }[];
  executionBacklog: BacklogEntry[];
  reconciliationFindings: Finding[];
};

export type CapabilityScope = {
  /** Files declared as evidence, or an explicit registry estimate. */
  files: number;
  /** Test suites declared as evidence, or an explicit registry estimate. */
  tests: number;
  /** True when the counts come from the registry rather than evidence probes. */
  estimated: boolean;
};

export type BacklogEntry = {
  id: string;
  title: string;
  status: CapabilityStatus;
  lifecycle: CapabilityLifecycle;
  priority: number;
  executable: boolean;
  /** Every declared dependency, met or not. */
  dependsOn: string[];
  /** The subset of `dependsOn` that is not yet complete. */
  blockedBy: string[];
  /** Capabilities that cannot start until this one completes. */
  blocks: string[];
  scope: CapabilityScope;
  requiresLiveInfrastructure: boolean;
};

/* ---------------------------------------------------------------- Stage 4 */

export type DependencyResolution = {
  reosVersion: string;
  stage: 'dependencies';
  head: string;
  selected: BacklogEntry | null;
  /** Why `selected` won, stated in one line for the agent that implements it. */
  selectionReason: string | null;
  rejected: { id: string; reason: string }[];
  executable: BacklogEntry[];
  blocked: BacklogEntry[];
  completed: string[];
  awaitingInfrastructure: string[];
};

/* ------------------------------------------------------- Governance policy */

/**
 * Staged enforcement of reconciliation findings.
 *
 *  phase 1 — report only; findings never fail certification.
 *  phase 2 — findings absent from the baseline fail; baselined ones warn.
 *  phase 3 — every finding fails; the baseline is ignored.
 *
 * Phase 2 is the working setting: it stops new violations without demanding
 * that every pre-existing one be fixed first.
 */
export type GovernancePhase = 1 | 2 | 3;

export type GovernancePolicy = {
  phase: GovernancePhase;
  /** Rules exempt from escalation at any phase, with a stated reason. */
  exemptRules: Record<string, string>;
  /** `rule:subject` fingerprints accepted as pre-existing. */
  baseline: string[];
};

export type GovernanceEvaluation = {
  phase: GovernancePhase;
  baselined: number;
  introduced: string[];
  resolved: string[];
  findings: Finding[];
  passed: boolean;
};

/* --------------------------------------------------------- Execution ledger */

/** The live probe result for one capability, as forensics measured it. */
export type CapabilityProbeCount = {
  id: string;
  satisfiedProbes: number;
  totalProbes: number;
};

/** A capability whose latest recorded execution contradicts what the repository can now see. */
export type LedgerLifecycleContradiction = {
  capabilityId: string;
  entryId: string;
  /** The lifecycle frozen into that entry, for context in the failure message. */
  lifecycle: CapabilityLifecycle | null;
  recordedAt: string;
};

export type LedgerEntry = {
  entryId: string;
  recordedAt: string;
  capabilityId: string | null;
  lifecycle: CapabilityLifecycle | null;
  branch: string;
  commit: string;
  manifestDigest: string;
  validation: { validator: string; passed: boolean; errors: number; warnings: number }[];
  certification: { available: boolean; passed: boolean; failedSteps: string[] };
  /** Capabilities this execution moved to a terminal lifecycle state. */
  supersedes: string[];
};

/* ---------------------------------------------------------------- Stage 6 */

export type CertificationStep = {
  id: string;
  description: string;
  kind: 'command' | 'validator';
  command?: string;
  passed: boolean;
  skipped: boolean;
  exitCode: number | null;
  durationMs: number;
  findings: Finding[];
  outputTail: string[];
};

export type CertificationReport = {
  reosVersion: string;
  stage: 'certify';
  head: string;
  branch: string;
  generatedAt: string;
  passed: boolean;
  steps: CertificationStep[];
  totals: { executed: number; passed: number; failed: number; skipped: number };
};

/* ---------------------------------------------------------------- Stage 7 */

export type ExecutionReport = {
  reosVersion: string;
  stage: 'report';
  generatedAt: string;
  repositoryState: {
    branch: string;
    head: string;
    clean: boolean;
    dirtyFiles: string[];
  };
  capability: string | null;
  capabilityLifecycle: CapabilityLifecycle | null;
  filesModified: string[];
  validation: ValidationOutcome[];
  certification: {
    available: boolean;
    passed: boolean;
    failedSteps: string[];
  };
  remainingBacklog: BacklogEntry[];
  recommendedNextCapability: BacklogEntry | null;
  governance: GovernanceEvaluation | null;
  ledgerEntryId: string | null;
  commit: string;
};
