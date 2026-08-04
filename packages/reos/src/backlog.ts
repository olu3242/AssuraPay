import { sortBy } from './util/serialize.ts';
import type {
  BacklogEntry,
  CapabilityForensics,
  CapabilityRegistry,
  CapabilityStatus,
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
  const statusById = new Map(
    forensics.map((capability) => [capability.id, capability.status]),
  );

  return registry.capabilities.map((definition) => ({
    id: definition.id,
    title: definition.title,
    kind: definition.kind,
    status: statusById.get(definition.id) ?? 'missing',
    priority: definition.priority,
    dependsOn: [...definition.dependsOn].sort(),
    requiresLiveInfrastructure: definition.requiresLiveInfrastructure ?? false,
  }));
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
export function buildBacklog(nodes: CapabilityNode[]): BacklogEntry[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));

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

      return {
        id: node.id,
        title: node.title,
        status: node.status,
        priority: node.priority,
        executable: blockedBy.length === 0,
        blockedBy,
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
