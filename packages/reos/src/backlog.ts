import { sortBy } from './util/serialize.ts';
import { deriveLifecycle } from './lifecycle.ts';
import type {
  BacklogEntry,
  CapabilityForensics,
  CapabilityLifecycle,
  CapabilityRegistry,
  CapabilityScope,
  CapabilityStatus,
  CertificationReport,
  EngineReconciliation,
} from './types.ts';

/**
 * A node in the execution dependency graph. Platform capabilities and catalog
 * engines are unified here so dependency resolution has one graph to reason
 * over rather than two parallel ones.
 */
export type CapabilityNode = {
  id: string;
  title: string;
  kind: 'platform' | 'engine';
  status: CapabilityStatus;
  priority: number;
  dependsOn: string[];
  requiresLiveInfrastructure: boolean;
  onDefaultBranch: boolean;
  certifyScript: string | null;
  scope: CapabilityScope;
};

/** Engines are numbered after platform capabilities so platform work leads. */
const ENGINE_PRIORITY_BASE = 100;

export function engineNodeId(engineId: string): string {
  return `engine:${engineId}`;
}

/**
 * Engines execute in ascending catalog order, which is how the six waves are
 * sequenced. Deferred engines are skipped rather than treated as blockers, so a
 * deferred engine never stalls the engines behind it.
 */
export function buildEngineNodes(
  engines: EngineReconciliation[],
  /** Package directories already present on the default branch. */
  releasedPackages: ReadonlySet<string> = new Set(),
): CapabilityNode[] {
  const ordered = sortBy(engines, (engine) => engine.id);
  const nodes: CapabilityNode[] = [];
  let previousBlocking: string | null = null;

  for (const engine of ordered) {
    const node: CapabilityNode = {
      id: engineNodeId(engine.id),
      title: `Engine ${engine.id} — ${engine.name}`,
      kind: 'engine',
      status: engine.observedStatus,
      priority: ENGINE_PRIORITY_BASE + Number(engine.id),
      dependsOn: previousBlocking ? [previousBlocking] : [],
      requiresLiveInfrastructure: false,
      // An engine's evidence is its package, so it counts as released once that
      // package exists on the default branch.
      onDefaultBranch:
        engine.packageDirectory !== null &&
        releasedPackages.has(engine.packageDirectory),
      certifyScript: engine.certificationScript,
      scope: { files: 0, tests: 0, estimated: false },
    };
    nodes.push(node);
    if (engine.observedStatus !== 'deferred') previousBlocking = node.id;
  }

  return nodes;
}

export function buildPlatformNodes(
  registry: CapabilityRegistry,
  forensics: CapabilityForensics[],
): CapabilityNode[] {
  const byId = new Map(forensics.map((capability) => [capability.id, capability]));

  return registry.capabilities.map((definition) => ({
    id: definition.id,
    title: definition.title,
    kind: definition.kind,
    status: byId.get(definition.id)?.status ?? 'missing',
    priority: definition.priority,
    dependsOn: [...definition.dependsOn].sort(),
    requiresLiveInfrastructure: definition.requiresLiveInfrastructure ?? false,
    onDefaultBranch: byId.get(definition.id)?.onDefaultBranch ?? false,
    certifyScript: definition.certify,
    scope: scopeOf(definition),
  }));
}

/**
 * Scope is the declared evidence surface unless the registry states an explicit
 * estimate. Counting probes is honest — it is what the capability promises to
 * produce — so it is never presented as a prediction of total churn.
 */
function scopeOf(definition: CapabilityRegistry['capabilities'][number]): CapabilityScope {
  if (definition.scope) {
    return { ...definition.scope, estimated: true };
  }
  return {
    files: definition.evidence.paths?.length ?? 0,
    tests: definition.evidence.tests?.length ?? 0,
    estimated: false,
  };
}

/**
 * Reverse dependency closure: everything that cannot start until `id` completes,
 * transitively. Direct dependents alone understate the cost of leaving a
 * capability unbuilt — a one-step view of engine 01 hides the other 59.
 * Traversal is cycle-safe, so a dependency cycle cannot hang the walk.
 */
export function computeBlocks(nodes: CapabilityNode[]): Map<string, string[]> {
  const directDependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      directDependents.set(dependency, [
        ...(directDependents.get(dependency) ?? []),
        node.id,
      ]);
    }
  }

  const closure = new Map<string, string[]>();
  for (const node of nodes) {
    const reached = new Set<string>();
    const queue = [...(directDependents.get(node.id) ?? [])];

    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || next === node.id || reached.has(next)) continue;
      reached.add(next);
      queue.push(...(directDependents.get(next) ?? []));
    }

    if (reached.size > 0) closure.set(node.id, [...reached].sort());
  }

  return closure;
}

const COMPLETE_STATUSES = new Set<CapabilityStatus>(['implemented', 'deferred']);

/**
 * Turns the graph into an ordered backlog.
 *
 * Resolution rules, in the order they are applied:
 *  - completed work is never re-selected (`implemented`);
 *  - deferred work is never selected;
 *  - a node is executable only when every dependency is complete;
 *  - ties break on priority, then on id, so the result is deterministic.
 */
export function buildBacklog(
  nodes: CapabilityNode[],
  certification: CertificationReport | null = null,
): BacklogEntry[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const blocks = computeBlocks(nodes);

  const entries = nodes
    .filter((node) => !COMPLETE_STATUSES.has(node.status))
    .map((node) => {
      const blockedBy = node.dependsOn
        .filter((dependency) => {
          const target = byId.get(dependency);
          if (!target) return true;
          return !COMPLETE_STATUSES.has(target.status);
        })
        .sort();

      const executable = blockedBy.length === 0;

      return {
        id: node.id,
        title: node.title,
        status: node.status,
        dependsOn: node.dependsOn,
        lifecycle: deriveLifecycle({
          status: node.status,
          executable,
          onDefaultBranch: node.onDefaultBranch,
          certification,
          certifyScript: node.certifyScript,
        }),
        priority: node.priority,
        executable,
        blockedBy,
        blocks: blocks.get(node.id) ?? [],
        scope: node.scope,
        requiresLiveInfrastructure: node.requiresLiveInfrastructure,
      };
    });

  return entries.sort(
    (left, right) =>
      left.priority - right.priority || left.id.localeCompare(right.id),
  );
}

/**
 * Selects the single highest-priority executable capability. Work needing live
 * infrastructure is deprioritised over work that can be completed offline, but
 * remains selectable when nothing else is available.
 */
export function selectNext(backlog: BacklogEntry[]): BacklogEntry | null {
  const executable = backlog.filter((entry) => entry.executable);
  const offline = executable.filter((entry) => !entry.requiresLiveInfrastructure);
  return (offline[0] ?? executable[0]) ?? null;
}

/** Lifecycle for every node, including the complete ones the backlog omits. */
export function lifecycleByNode(
  nodes: CapabilityNode[],
  certification: CertificationReport | null,
): Map<string, CapabilityLifecycle> {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return new Map(
    nodes.map((node) => {
      const executable = node.dependsOn.every((dependency) => {
        const target = byId.get(dependency);
        return target ? COMPLETE_STATUSES.has(target.status) : false;
      });

      return [
        node.id,
        deriveLifecycle({
          status: node.status,
          executable,
          onDefaultBranch: node.onDefaultBranch,
          certification,
          certifyScript: node.certifyScript,
        }),
      ];
    }),
  );
}
