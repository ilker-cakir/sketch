import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import { getChildren, getRoots } from '@statelyai/graph';
import type { GraphNode } from '@statelyai/graph';
import type { MachineGraph, StateNodeData } from '@/lib/machine';
import {
  CONTAINER_PAD_BOTTOM,
  CONTAINER_PAD_X,
  measureEdgeLabel,
  measureNode,
  type MeasureText,
  type NodeMetrics,
} from './measure';

export type ElkDirection = 'RIGHT' | 'DOWN' | 'LEFT' | 'UP';

export interface ToElkOptions {
  direction?: ElkDirection;
  /**
   * `INCLUDE_CHILDREN` lays the whole hierarchy out in one pass, which routes
   * edges that cross container boundaries properly — the common case in a
   * statechart. `SEPARATE_CHILDREN` is cheaper but routes cross-boundary edges
   * only at the top level.
   */
  hierarchyHandling?: 'INCLUDE_CHILDREN' | 'SEPARATE_CHILDREN';
}

export interface ToElkResult {
  root: ElkNode;
  /** Per-node intrinsic metrics, reused when building the render scene. */
  metrics: Map<string, NodeMetrics>;
  /** Edges whose source or target is the same node — rendered as loop glyphs. */
  selfEdgeIds: Set<string>;
  /** Edges dropped because an endpoint is missing from the node set. */
  droppedEdgeCount: number;
  /**
   * Edge id → the node its coordinates will be relative to, or `null` for the
   * graph root. ELK reports edge geometry relative to the lowest common
   * ancestor of the endpoints, which is not necessarily the node the edge was
   * declared on, so `fromElk` needs this recorded explicitly.
   */
  edgeOriginById: Map<string, string | null>;
}

/** Ancestor ids of `id`, nearest first, excluding `id` itself. */
function ancestorsOf(
  parentById: Map<string, string | null>,
  id: string,
): string[] {
  const chain: string[] = [];
  let current = parentById.get(id) ?? null;
  while (current) {
    chain.push(current);
    current = parentById.get(current) ?? null;
  }
  return chain;
}

/**
 * Lowest common ancestor of two nodes, or `null` when they only meet at the
 * graph root. ELK requires an edge to be declared on a node that contains both
 * of its endpoints.
 */
export function lowestCommonAncestor(
  parentById: Map<string, string | null>,
  a: string,
  b: string,
): string | null {
  const aAncestors = new Set([a, ...ancestorsOf(parentById, a)]);
  if (aAncestors.has(b)) return b;
  for (const ancestor of [b, ...ancestorsOf(parentById, b)]) {
    if (aAncestors.has(ancestor)) return ancestor;
  }
  return null;
}

/**
 * Builds the ELK input graph for a machine.
 *
 * Nodes nest to mirror the statechart hierarchy. Every edge is declared on the
 * lowest container holding both endpoints. Self- and targetless transitions are
 * withheld from ELK — they do not influence layout and are drawn as loop glyphs
 * — and edges pointing at nodes outside the graph are dropped, because ELK
 * throws rather than ignoring them.
 */
export function toElk(
  graph: MachineGraph,
  measureText: MeasureText,
  options: ToElkOptions = {},
): ToElkResult {
  const { direction = 'RIGHT', hierarchyHandling = 'INCLUDE_CHILDREN' } = options;

  const metrics = new Map<string, NodeMetrics>();
  const parentById = new Map<string, string | null>();
  const elkById = new Map<string, ElkNode>();

  for (const node of graph.nodes) {
    parentById.set(node.id, node.parentId ?? null);
  }

  function build(node: GraphNode<StateNodeData>): ElkNode {
    const children = getChildren(graph, node.id) as GraphNode<StateNodeData>[];
    const measured = measureNode(node.data, measureText);
    metrics.set(node.id, measured);

    const elkNode: ElkNode = {
      id: node.id,
      width: measured.width,
      height: measured.height,
    };

    if (children.length > 0) {
      elkNode.children = children.map(build);
      elkNode.layoutOptions = {
        'elk.padding': `[top=${measured.headerHeight + CONTAINER_PAD_X},left=${CONTAINER_PAD_X},bottom=${CONTAINER_PAD_BOTTOM},right=${CONTAINER_PAD_X}]`,
      };
    }

    elkById.set(node.id, elkNode);
    return elkNode;
  }

  const roots = getRoots(graph) as GraphNode<StateNodeData>[];
  const rootChildren = roots.map(build);

  const selfEdgeIds = new Set<string>();
  const edgeOriginById = new Map<string, string | null>();
  let droppedEdgeCount = 0;
  const rootEdges: ElkExtendedEdge[] = [];

  for (const edge of graph.edges) {
    if (edge.sourceId === edge.targetId) {
      selfEdgeIds.add(edge.id);
      continue;
    }
    if (!parentById.has(edge.sourceId) || !parentById.has(edge.targetId)) {
      droppedEdgeCount++;
      continue;
    }

    const labelText = edge.data.displayEvent || edge.data.eventType;
    const labelSize = measureEdgeLabel(labelText, measureText);
    const elkEdge: ElkExtendedEdge = {
      id: edge.id,
      sources: [edge.sourceId],
      targets: [edge.targetId],
      sections: [],
      ...(labelSize ? { labels: [{ text: labelText, ...labelSize }] } : {}),
    };

    // ELK expresses the edge's geometry relative to the lowest common ancestor
    // of its endpoints, so that is both where we declare it and the origin
    // `fromElk` must add back.
    const container = lowestCommonAncestor(
      parentById,
      edge.sourceId,
      edge.targetId,
    );
    edgeOriginById.set(edge.id, container);

    const containerNode = container ? elkById.get(container) : undefined;
    if (containerNode) {
      (containerNode.edges ??= []).push(elkEdge);
    } else {
      rootEdges.push(elkEdge);
    }
  }

  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.hierarchyHandling': hierarchyHandling,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.spacing.nodeNode': '32',
      'elk.spacing.edgeNode': '20',
      'elk.spacing.edgeLabel': '4',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
    },
    children: rootChildren,
    edges: rootEdges,
  };

  return { root, metrics, selfEdgeIds, droppedEdgeCount, edgeOriginById };
}
