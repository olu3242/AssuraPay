
import { readJson } from './util/fsx.ts';
import { writeArtifact, writeJsonArtifact } from './util/serialize.ts';
import { CAPABILITY_REGISTRY, absolute, artifactPaths } from './paths.ts';
import { discover } from './stages/discover.ts';
import { runForensics } from './stages/forensics.ts';
import { buildExecutionManifest, renderExecutionManifest } from './stages/manifest.ts';
import {
  renderDependencyResolution,
  resolveDependencies,
} from './stages/dependencies.ts';
import { certify, renderCertificationReport, type CertifyOptions } from './stages/certify.ts';
import { buildExecutionReport, renderExecutionReport } from './stages/report.ts';
import type {
  CapabilityRegistry,
  CertificationReport,
  DependencyResolution,
  DiscoverySnapshot,
  ExecutionManifest,
  ExecutionReport,
  ForensicsReport,
} from './types.ts';

export function loadRegistry(repoRoot: string): CapabilityRegistry {
  return readJson<CapabilityRegistry>(absolute(repoRoot, CAPABILITY_REGISTRY));
}

export function runDiscover(repoRoot: string): DiscoverySnapshot {
  const snapshot = discover(repoRoot);
  writeJsonArtifact(absolute(repoRoot, artifactPaths().discovery), snapshot);
  return snapshot;
}

export function runForensicsStage(
  repoRoot: string,
  discovery: DiscoverySnapshot,
): ForensicsReport {
  const report = runForensics(repoRoot, discovery, loadRegistry(repoRoot));
  writeJsonArtifact(absolute(repoRoot, artifactPaths().forensics), report);
  return report;
}

export function runManifest(
  repoRoot: string,
  discovery: DiscoverySnapshot,
  forensics: ForensicsReport,
): ExecutionManifest {
  const manifest = buildExecutionManifest(
    repoRoot,
    discovery,
    forensics,
    loadRegistry(repoRoot),
  );
  writeJsonArtifact(absolute(repoRoot, artifactPaths().manifestJson), manifest);
  writeArtifact(
    absolute(repoRoot, artifactPaths().manifestMarkdown),
    renderExecutionManifest(manifest),
  );
  return manifest;
}

export function runDependencies(
  repoRoot: string,
  manifest: ExecutionManifest,
): DependencyResolution {
  const resolution = resolveDependencies(manifest);
  writeJsonArtifact(absolute(repoRoot, artifactPaths().dependenciesJson), resolution);
  writeArtifact(
    absolute(repoRoot, artifactPaths().dependenciesMarkdown),
    renderDependencyResolution(resolution),
  );
  return resolution;
}

export function runCertify(
  repoRoot: string,
  discovery: DiscoverySnapshot,
  options: CertifyOptions = {},
): CertificationReport {
  const report = certify(repoRoot, discovery, options);
  writeJsonArtifact(absolute(repoRoot, artifactPaths().certificationJson), report);
  writeArtifact(
    absolute(repoRoot, artifactPaths().certificationMarkdown),
    renderCertificationReport(report),
  );
  return report;
}

export function runReport(
  repoRoot: string,
  discovery: DiscoverySnapshot,
  manifest: ExecutionManifest,
  resolution: DependencyResolution,
  certification: CertificationReport | null,
  capability: string | null,
): ExecutionReport {
  const report = buildExecutionReport(
    repoRoot,
    discovery,
    manifest,
    resolution,
    certification,
    { capability },
  );
  writeJsonArtifact(absolute(repoRoot, artifactPaths().reportJson), report);
  writeArtifact(
    absolute(repoRoot, artifactPaths().reportMarkdown),
    renderExecutionReport(report),
  );
  return report;
}

/**
 * Reads a previously generated artifact. `repo:report` and `repo:next` use this
 * so a session can consume the certification produced by an earlier command
 * instead of re-running the whole suite.
 */
export function readArtifact<T>(repoRoot: string, relativePath: string): T | null {
  try {
    return readJson<T>(absolute(repoRoot, relativePath));
  } catch {
    return null;
  }
}

export type PipelineResult = {
  discovery: DiscoverySnapshot;
  forensics: ForensicsReport;
  manifest: ExecutionManifest;
  resolution: DependencyResolution;
  certification: CertificationReport | null;
  report: ExecutionReport;
};

/**
 * Stages 1–4 always run together: dependency resolution is only trustworthy
 * when it reads a manifest built from the current repository state.
 */
export function runPlanning(repoRoot: string) {
  const discovery = runDiscover(repoRoot);
  const forensics = runForensicsStage(repoRoot, discovery);
  const manifest = runManifest(repoRoot, discovery, forensics);
  const resolution = runDependencies(repoRoot, manifest);
  return { discovery, forensics, manifest, resolution };
}

/** The full pipeline: discover → forensics → manifest → dependencies → certify → report. */
export function runPipeline(
  repoRoot: string,
  options: { capability?: string | null; certify?: CertifyOptions } = {},
): PipelineResult {
  const planning = runPlanning(repoRoot);
  const certification = runCertify(repoRoot, planning.discovery, options.certify ?? {});
  const report = runReport(
    repoRoot,
    planning.discovery,
    planning.manifest,
    planning.resolution,
    certification,
    options.capability ?? null,
  );
  return { ...planning, certification, report };
}
