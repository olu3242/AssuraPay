/**
 * Repository Execution Operating System (REOS).
 *
 * REOS makes AI execution against this repository deterministic, repository-aware
 * and certifiable. A future session depends on repository evidence — the
 * artifacts under docs/governance/reos/generated — never on a prior conversation.
 *
 * Pipeline: discover → forensics → manifest → dependencies → implementation →
 * certify → report → next.
 */

export { REOS_VERSION } from './types.ts';

export type {
  AdrRecord,
  ApplicationRecord,
  BacklogEntry,
  CapabilityDefinition,
  CapabilityForensics,
  CapabilityRegistry,
  CapabilityStatus,
  CertificationReport,
  CertificationStep,
  CertificationTarget,
  DependencyResolution,
  DiscoverySnapshot,
  DocumentRecord,
  EngineReconciliation,
  EngineRecord,
  EvidenceProbe,
  ExecutionManifest,
  ExecutionReport,
  Finding,
  FindingSeverity,
  ForensicsReport,
  GitEvidence,
  GitState,
  MigrationRecord,
  PackageRecord,
  RuntimeRegistration,
  TestCounts,
  TestKind,
  ValidationOutcome,
  WorkflowRecord,
} from './types.ts';

export type { CapabilityNode } from './backlog.ts';
export {
  buildBacklog,
  buildEngineNodes,
  buildPlatformNodes,
  engineNodeId,
  selectNext,
} from './backlog.ts';

export {
  ARTIFACTS,
  ARTIFACT_DIRECTORY,
  CAPABILITY_REGISTRY,
  GOVERNANCE_DIRECTORY,
  absolute,
  artifactDirectory,
  artifactPaths,
  resolveRepoRoot,
} from './paths.ts';

export {
  classifyTestFile,
  discover,
  parseCertificationTarget,
  parseEngineCatalog,
} from './stages/discover.ts';
export {
  buildSourceIndex,
  classifyStatus,
  investigateGitEvidence,
  runForensics,
} from './stages/forensics.ts';
export {
  buildExecutionManifest,
  buildReconciliationFindings,
  parseCanonicalChain,
  reconcileEngines,
  renderExecutionManifest,
} from './stages/manifest.ts';
export {
  renderDependencyResolution,
  resolveDependencies,
} from './stages/dependencies.ts';
export {
  CERTIFICATION_STEPS,
  certify,
  renderCertificationReport,
} from './stages/certify.ts';
export type { CertifyOptions } from './stages/certify.ts';
export { buildExecutionReport, renderExecutionReport } from './stages/report.ts';

export { TRUST_FOUNDATION_PACKAGES, validateArchitecture } from './validators/architecture.ts';
export { detectCycles, validateDependencies } from './validators/dependency.ts';
export {
  CUSTODY_PRIMITIVES,
  UNCONDITIONAL_RELEASE_PRIMITIVES,
  validateSecurity,
} from './validators/security.ts';
export { resolveBase, validateExecutionContract } from './validators/contract.ts';
export {
  RULE_VOCABULARY_TOKEN,
  declaresRuleVocabulary,
} from './validators/exemption.ts';

export type { PipelineResult } from './pipeline.ts';
export {
  loadRegistry,
  readArtifact,
  runCertify,
  runDependencies,
  runDiscover,
  runForensicsStage,
  runManifest,
  runPipeline,
  runPlanning,
  runReport,
} from './pipeline.ts';

export { stableStringify } from './util/serialize.ts';
export { parsePorcelainPaths } from './util/git.ts';
export { matchGlob } from './util/fsx.ts';
