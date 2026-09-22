import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { MachineGraph } from '@/lib/machine';
import type { LayoutEdge, LayoutGraph, LayoutNode, Point } from './types';

/**
 * ELK reports every coordinate relative to a container, and this module
 * accumulates those into absolute world coordinates.
 *
 * A node's `x`/`y` are relative to its parent node's origin. An edge's section
 * points are relative to the **lowest common ancestor of its endpoints** —
 * which is not necessarily the node whose `edges` array holds it, because ELK
 * normalises edge containment during hierarchical layout. `toElk` records that
 * ancestor per edge; using the output tree position instead silently
 * mislocates every edge between a container and its own descendant.
 */

interface EdgeGeometry {
  points: Point[];
  label: LayoutEdge['label'];
}

function sectionPoints(
  edge: ElkExtendedEdge,
  originX: number,
  originY: number,
): Point[] {
  const points: Point[] = [];
  for (const section of edge.sections ?? []) {
    // Sections chain end-to-end; skip a repeated join point.
    const start = { x: section.startPoint.x + originX, y: section.startPoint.y + originY };
    const last = points[points.length - 1];
    if (!last || last.x !== start.x || last.y !== start.y) points.push(start);

    for (const bend of section.bendPoints ?? []) {
      points.push({ x: bend.x + originX, y: bend.y + originY });
    }
    points.push({ x: section.endPoint.x + originX, y: section.endPoint.y + originY });
  }
  return points;
}

function collectEdgeGeometry(
  elkNode: ElkNode,
  originOf: (edgeId: string) => Point,
  into: Map<string, EdgeGeometry>,
): void {
  for (const edge of (elkNode.edges ?? []) as ElkExtendedEdge[]) {
    const origin = originOf(edge.id);
    const elkLabel = edge.labels?.[0];
    into.set(edge.id, {
      points: sectionPoints(edge, origin.x, origin.y),
      label:
        elkLabel && elkLabel.text
          ? {
              x: (elkLabel.x ?? 0) + origin.x,
              y: (elkLabel.y ?? 0) + origin.y,
              width: elkLabel.width ?? 0,
              height: elkLabel.height ?? 0,
              text: elkLabel.text,
            }
          : null,
    });
  }

  for (const child of elkNode.children ?? []) {
    collectEdgeGeometry(child, originOf, into);
  }
}

function collectNodeRects(
  elkNode: ElkNode,
  originX: number,
  originY: number,
  into: Map<string, { x: number; y: number; width: number; height: number }>,
): void {
  for (const child of elkNode.children ?? []) {
    const x = originX + (child.x ?? 0);
    const y = originY + (child.y ?? 0);
    into.set(child.id, {
      x,
      y,
      width: child.width ?? 0,
      height: child.height ?? 0,
    });
    collectNodeRects(child, x, y, into);
  }
}

/**
 * Converts an ELK layout result back into absolute-coordinate render geometry,
 * re-attaching the `StateNodeData` / `TransitionData` that ELK does not carry.
 */
export function fromElk(
  laidOut: ElkNode,
  graph: MachineGraph,
  options: {
    selfEdgeIds: Set<string>;
    droppedEdgeCount: number;
    edgeOriginById: Map<string, string | null>;
    /** Containers whose insides were removed before layout. */
    collapsed?: ReadonlySet<string>;
    /** Visible node id → descendants folded into it. */
    hiddenCountById?: ReadonlyMap<string, number>;
    /** Representative edge id → transitions it stands for. */
    mergedCountById?: ReadonlyMap<string, number>;
  },
): LayoutGraph {
  const rects = new Map<string, { x: number; y: number; width: number; height: number }>();
  collectNodeRects(laidOut, 0, 0, rects);

  const ORIGIN: Point = { x: 0, y: 0 };
  const originOf = (edgeId: string): Point => {
    const containerId = options.edgeOriginById.get(edgeId);
    if (!containerId) return ORIGIN;
    return rects.get(containerId) ?? ORIGIN;
  };

  const geometry = new Map<string, EdgeGeometry>();
  collectEdgeGeometry(laidOut, originOf, geometry);

  const graphNodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const childCount = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.parentId) {
      childCount.set(node.parentId, (childCount.get(node.parentId) ?? 0) + 1);
    }
  }

  const depthOf = (id: string): number => {
    let depth = 0;
    let parent = graphNodeById.get(id)?.parentId ?? null;
    while (parent) {
      depth++;
      parent = graphNodeById.get(parent)?.parentId ?? null;
    }
    return depth;
  };

  const nodes: LayoutNode[] = [];
  for (const node of graph.nodes) {
    const rect = rects.get(node.id);
    if (!rect) continue;
    const parent = node.parentId ? graphNodeById.get(node.parentId) : undefined;
    nodes.push({
      id: node.id,
      parentId: node.parentId ?? null,
      depth: depthOf(node.id),
      data: node.data,
      isContainer: (childCount.get(node.id) ?? 0) > 0,
      isInitial: parent?.data.initialId === node.id,
      isRegion: parent?.data.type === 'parallel',
      isCollapsed: options.collapsed?.has(node.id) ?? false,
      hiddenCount: options.hiddenCountById?.get(node.id) ?? 0,
      ...rect,
    });
  }
  // Shallow nodes first, so containers paint beneath their children.
  nodes.sort((a, b) => a.depth - b.depth);

  const edges: LayoutEdge[] = [];
  for (const edge of graph.edges) {
    const isSelf = options.selfEdgeIds.has(edge.id);
    const geo = geometry.get(edge.id);
    if (!isSelf && !geo) continue; // dropped before layout
    edges.push({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      data: edge.data,
      points: geo?.points ?? [],
      label: geo?.label ?? null,
      isSelf,
      mergedCount: options.mergedCountById?.get(edge.id) ?? 1,
    });
  }

  return {
    nodes,
    edges,
    width: laidOut.width ?? 0,
    height: laidOut.height ?? 0,
    droppedEdgeCount: options.droppedEdgeCount,
  };
}
