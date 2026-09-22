import { createGraph, addNode, addEdge } from '@statelyai/graph';
import type { MachineGraph } from '@/lib/machine';

/**
 * Hiding the inside of a container.
 *
 * A hundred-state machine drawn in full is a hairball no renderer can rescue,
 * so the answer is to draw less of it. Collapsing is done here, on the graph,
 * before layout — not at draw time — because it has to shrink the problem ELK
 * solves as well as the picture: fewer nodes and fewer edges make the layout
 * both faster and smaller.
 */

export interface CollapseResult {
  /** The graph to lay out: collapsed containers keep their box, lose insides. */
  graph: MachineGraph;
  /** Visible node id → number of descendants folded into it. */
  hiddenCountById: Map<string, number>;
  /** Transitions dropped because both ends fell inside one collapsed node. */
  internalEdgeCount: number;
  /**
   * Representative edge id → how many transitions it now stands for.
   *
   * Collapsing re-points many transitions at the same pair of containers.
   * Drawing them all is worse than drawing the expanded graph: a hundred
   * parallel lines between two boxes is a solid block, not a diagram. Only one
   * is laid out, and it says how many it speaks for.
   */
  mergedCountById: Map<string, number>;
}

/**
 * The shallowest collapsed ancestor of `nodeId`, or `nodeId` itself.
 *
 * Shallowest, not nearest: if a container is collapsed, everything under it is
 * hidden regardless of what its own descendants say about themselves.
 */
export function visibleAncestor(
  nodeId: string,
  parentById: ReadonlyMap<string, string | null>,
  collapsed: ReadonlySet<string>,
): string {
  let visible = nodeId;
  let current: string | null | undefined = parentById.get(nodeId);
  while (current != null) {
    if (collapsed.has(current)) visible = current;
    current = parentById.get(current);
  }
  return visible;
}

/**
 * Rebuilds `graph` with the insides of every collapsed container removed.
 *
 * Edges are re-pointed at the collapsed container that swallowed their
 * endpoint, so a transition into a region still arrives somewhere. An edge
 * with both ends inside the same collapsed container has nothing left to say
 * and is dropped — the container reports how many states it is hiding instead.
 */
export function collapseGraph(
  graph: MachineGraph,
  collapsed: ReadonlySet<string>,
): CollapseResult {
  if (collapsed.size === 0) {
    return {
      graph,
      hiddenCountById: new Map(),
      internalEdgeCount: 0,
      mergedCountById: new Map(),
    };
  }

  const parentById = new Map<string, string | null>(
    graph.nodes.map((n) => [n.id, n.parentId ?? null]),
  );

  const visibleOf = new Map<string, string>();
  for (const node of graph.nodes) {
    visibleOf.set(node.id, visibleAncestor(node.id, parentById, collapsed));
  }

  const hiddenCountById = new Map<string, number>();
  for (const node of graph.nodes) {
    const visible = visibleOf.get(node.id)!;
    if (visible === node.id) continue;
    hiddenCountById.set(visible, (hiddenCountById.get(visible) ?? 0) + 1);
  }

  const next = createGraph<
    MachineGraph['nodes'][number]['data'],
    MachineGraph['edges'][number]['data']
  >();

  for (const node of graph.nodes) {
    if (visibleOf.get(node.id) !== node.id) continue;
    const isCollapsed = collapsed.has(node.id);
    addNode(next, {
      id: node.id,
      parentId: node.parentId ?? null,
      // A collapsed node has no children to point at any more, so keeping its
      // initial child would dangle.
      initialNodeId: isCollapsed ? undefined : (node.initialNodeId ?? undefined),
      label: node.label,
      data: node.data,
    });
  }

  let internalEdgeCount = 0;
  const mergedCountById = new Map<string, number>();
  const representativeOf = new Map<string, string>();

  for (const edge of graph.edges) {
    const source = visibleOf.get(edge.sourceId);
    const target = visibleOf.get(edge.targetId);
    if (source === undefined || target === undefined) continue;

    const wasSelf = edge.sourceId === edge.targetId;
    if (source === target && !wasSelf) {
      internalEdgeCount++;
      continue;
    }

    const pair = `${source}\u0000${target}`;
    const existing = representativeOf.get(pair);
    if (existing !== undefined) {
      mergedCountById.set(existing, (mergedCountById.get(existing) ?? 1) + 1);
      continue;
    }
    representativeOf.set(pair, edge.id);

    addEdge(next, {
      id: edge.id,
      sourceId: source,
      targetId: target,
      label: edge.label,
      data: edge.data,
    });
  }

  return { graph: next, hiddenCountById, internalEdgeCount, mergedCountById };
}

/**
 * Every container that can be collapsed, i.e. has children.
 *
 * Roots are excluded: collapsing the machine itself would leave one box and
 * nothing to look at.
 */
export function collapsibleIds(graph: MachineGraph): string[] {
  const hasChildren = new Set<string>();
  for (const node of graph.nodes) {
    if (node.parentId) hasChildren.add(node.parentId);
  }
  return graph.nodes
    .filter((n) => n.parentId !== null && hasChildren.has(n.id))
    .map((n) => n.id);
}

/**
 * The containers to collapse for a readable overview: the outermost ones.
 *
 * Collapsing every container is the same picture as collapsing only the
 * shallowest, since a collapsed container hides its descendants anyway — but
 * the smaller set is what the UI has to keep and reason about.
 */
export function outermostCollapsibleIds(graph: MachineGraph): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const depthOf = (id: string): number => {
    let depth = 0;
    let current = byId.get(id)?.parentId ?? null;
    while (current != null) {
      depth++;
      current = byId.get(current)?.parentId ?? null;
    }
    return depth;
  };

  const collapsible = collapsibleIds(graph);
  if (collapsible.length === 0) return [];
  const shallowest = Math.min(...collapsible.map(depthOf));
  return collapsible.filter((id) => depthOf(id) === shallowest);
}
