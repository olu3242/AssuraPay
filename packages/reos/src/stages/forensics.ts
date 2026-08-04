import path from 'node:path';
import { existsSync } from 'node:fs';
import { readTextIfPresent, walkFiles } from '../util/fsx.ts';
import {
  commitsTouchingSymbol,
  defaultBranchRef,
  isMergedIntoHead,
  pathExistsAtRef,
  refsContainingSymbol,
} from '../util/git.ts';
import { sortBy } from '../util/serialize.ts';
import { REOS_VERSION } from '../types.ts';
import type {
  CapabilityDefinition,
  CapabilityForensics,
  CapabilityRegistry,
  CapabilityStatus,
  DiscoverySnapshot,
  EvidenceProbe,
  ForensicsReport,
  GitEvidence,
} from '../types.ts';

const SEARCHABLE_ROOTS = ['packages', 'apps', 'scripts', 'supabase'];
const SEARCHABLE_EXTENSIONS = /\.(tsx?|sql)$/;

/**
 * An in-memory index of HEAD source text. Built once per forensics run so that
 * symbol probes cost a string scan rather than a process spawn.
 */
export function buildSourceIndex(repoRoot: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const root of SEARCHABLE_ROOTS) {
    for (const file of walkFiles(path.join(repoRoot, root), repoRoot)) {
      if (!SEARCHABLE_EXTENSIONS.test(file)) continue;
      const text = readTextIfPresent(path.join(repoRoot, file));
      if (text !== null) index.set(file, text);
    }
  }
  return index;
}

function probePaths(
  repoRoot: string,
  patterns: string[] | undefined,
): EvidenceProbe[] {
  return (patterns ?? []).map((pattern) => {
    const present = existsSync(path.join(repoRoot, pattern));
    return {
      kind: 'path' as const,
      query: pattern,
      satisfied: present,
      matches: present ? [pattern] : [],
    };
  });
}

function probeSymbols(
  index: Map<string, string>,
  symbols: string[] | undefined,
): EvidenceProbe[] {
  return (symbols ?? []).map((symbol) => {
    const matches: string[] = [];
    for (const [file, text] of index) {
      if (text.includes(symbol)) matches.push(file);
    }
    matches.sort();
    return {
      kind: 'symbol' as const,
      query: symbol,
      satisfied: matches.length > 0,
      matches,
    };
  });
}

function probeTests(
  repoRoot: string,
  patterns: string[] | undefined,
): EvidenceProbe[] {
  return (patterns ?? []).map((pattern) => {
    const present = existsSync(path.join(repoRoot, pattern));
    return {
      kind: 'test' as const,
      query: pattern,
      satisfied: present,
      matches: present ? [pattern] : [],
    };
  });
}

/**
 * Answers "does this exist somewhere other than HEAD?" — the question that
 * separates never-built work from work that was built and then lost.
 */
export function investigateGitEvidence(
  repoRoot: string,
  definition: CapabilityDefinition,
  refs: string[],
): GitEvidence {
  const symbol = definition.evidence.symbols?.[0];
  if (!symbol) {
    return {
      refsContaining: [],
      historicalCommits: [],
      removedFromHead: false,
      reachableFromHead: false,
    };
  }

  const refsContaining = refsContainingSymbol(symbol, refs, repoRoot);
  const historicalCommits = commitsTouchingSymbol(symbol, repoRoot);
  const reachableFromHead = refsContaining.some((ref) =>
    isMergedIntoHead(ref, repoRoot),
  );

  return {
    refsContaining,
    historicalCommits,
    removedFromHead: historicalCommits.length > 0,
    reachableFromHead,
  };
}

export function classifyStatus(
  satisfied: number,
  total: number,
  git: GitEvidence,
): { status: CapabilityStatus; rationale: string } {
  if (total === 0) {
    return { status: 'missing', rationale: 'No evidence rules declared.' };
  }
  if (satisfied === total) {
    return {
      status: 'implemented',
      rationale: `All ${total} evidence probes satisfied at HEAD.`,
    };
  }
  if (satisfied > 0) {
    return {
      status: 'partial',
      rationale: `${satisfied} of ${total} evidence probes satisfied at HEAD.`,
    };
  }
  if (git.refsContaining.length > 0 && !git.reachableFromHead) {
    return {
      status: 'unreachable',
      rationale: `Present on ${git.refsContaining.join(', ')} but not merged into HEAD.`,
    };
  }
  if (git.removedFromHead) {
    return {
      status: 'lost',
      rationale: `Absent at HEAD but ${git.historicalCommits.length} historical commit(s) touched it.`,
    };
  }
  return {
    status: 'missing',
    rationale: 'No evidence at HEAD, on any ref, or in history.',
  };
}

/**
 * Whether the capability's evidence is already on the default branch. This is
 * what separates lifecycle `certified` (green on a feature branch) from
 * `released` (present on main).
 */
export function isOnDefaultBranch(
  repoRoot: string,
  definition: CapabilityDefinition,
  ref: string | null,
): boolean {
  if (!ref) return false;

  const paths = definition.evidence.paths ?? [];
  if (paths.length > 0) {
    return paths.every((candidate) => pathExistsAtRef(ref, candidate, repoRoot));
  }

  const symbol = definition.evidence.symbols?.[0];
  if (!symbol) return false;
  return refsContainingSymbol(symbol, [ref], repoRoot).length > 0;
}

/** Stage 2 — evidence-based investigation of every registered capability. */
export function runForensics(
  repoRoot: string,
  discovery: DiscoverySnapshot,
  registry: CapabilityRegistry,
): ForensicsReport {
  const index = buildSourceIndex(repoRoot);
  const refs = [...discovery.repository.git.branches, ...discovery.repository.git.tags];
  const defaultRef = defaultBranchRef(repoRoot);

  const capabilities: CapabilityForensics[] = registry.capabilities.map(
    (definition) => {
      const probes = [
        ...probePaths(repoRoot, definition.evidence.paths),
        ...probeSymbols(index, definition.evidence.symbols),
        ...probeTests(repoRoot, definition.evidence.tests),
      ];

      const satisfied = probes.filter((probe) => probe.satisfied).length;
      // Git forensics only matter when HEAD is incomplete.
      const git =
        satisfied === probes.length && probes.length > 0
          ? {
              refsContaining: [],
              historicalCommits: [],
              removedFromHead: false,
              reachableFromHead: true,
            }
          : investigateGitEvidence(repoRoot, definition, refs);

      const { status, rationale } = classifyStatus(satisfied, probes.length, git);

      return {
        id: definition.id,
        title: definition.title,
        kind: definition.kind,
        status,
        onDefaultBranch:
          status === 'implemented'
            ? isOnDefaultBranch(repoRoot, definition, defaultRef)
            : false,
        satisfiedProbes: satisfied,
        totalProbes: probes.length,
        probes,
        git,
        rationale,
      };
    },
  );

  const summary: Record<CapabilityStatus, number> = {
    implemented: 0,
    partial: 0,
    missing: 0,
    lost: 0,
    unreachable: 0,
    deferred: 0,
  };
  for (const capability of capabilities) summary[capability.status] += 1;

  return {
    reosVersion: REOS_VERSION,
    stage: 'forensics',
    head: discovery.repository.git.head,
    capabilities: sortBy(capabilities, (capability) => capability.id),
    summary,
  };
}
