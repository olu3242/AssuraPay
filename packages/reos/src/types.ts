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
};

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
  packageDirectory: string | null;
  certificationScript: string | null;
  divergent: boolean;
};

export type ExecutionManifest = {
  reosVersion: string;
  stage: 'manifest';
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
  certification: {
    targets: number;
    scripted: string[];
    unscripted: string[];
  };
  dependencyGraph: { id: string; dependsOn: string[]; status: CapabilityStatus }[];
  executionBacklog: BacklogEntry[];
  reconciliationFindings: Finding[];
};

export type BacklogEntry = {
  id: string;
  title: string;
  status: CapabilityStatus;
  priority: number;
  executable: boolean;
  blockedBy: string[];
  requiresLiveInfrastructure: boolean;
};

/* ---------------------------------------------------------------- Stage 4 */

export type DependencyResolution = {
  reosVersion: string;
  stage: 'dependencies';
  head: string;
  selected: BacklogEntry | null;
  rejected: { id: string; reason: string }[];
  executable: BacklogEntry[];
  blocked: BacklogEntry[];
  completed: string[];
  awaitingInfrastructure: string[];
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
  filesModified: string[];
  validation: ValidationOutcome[];
  certification: {
    available: boolean;
    passed: boolean;
    failedSteps: string[];
  };
  remainingBacklog: BacklogEntry[];
  recommendedNextCapability: BacklogEntry | null;
  commit: string;
};
