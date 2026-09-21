import type { LayoutEdge, LayoutGraph, LayoutNode, Point, Rect } from '@/lib/layout/types';
import {
  FONT_BODY,
  FONT_HEADER,
  NODE_PAD_X,
  GLYPH_WIDTH,
  nodeRows,
  truncateToWidth,
  type MeasureText,
  type NodeRow,
} from '@/lib/layout/measure';

/** A node with its text pre-fitted to the box, so drawing does no measuring. */
export interface SceneNode extends LayoutNode {
  headerText: string;
  rows: NodeRow[];
}

export interface Scene {
  nodes: SceneNode[];
  edges: LayoutEdge[];
  nodeById: Map<string, SceneNode>;
  /** Reverse-depth order: deepest first, for topmost-wins hit-testing. */
  hitOrder: SceneNode[];
  bounds: Rect;
  droppedEdgeCount: number;
  /** Grid of edge indices, keyed by cell, for pointer proximity queries. */
  edgeGrid: Map<string, number[]>;
  cellSize: number;
}

const CELL_SIZE = 256;

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;

function addSegmentToGrid(
  grid: Map<string, number[]>,
  a: Point,
  b: Point,
  edgeIndex: number,
  cellSize: number,
): void {
  const minX = Math.floor(Math.min(a.x, b.x) / cellSize);
  const maxX = Math.floor(Math.max(a.x, b.x) / cellSize);
  const minY = Math.floor(Math.min(a.y, b.y) / cellSize);
  const maxY = Math.floor(Math.max(a.y, b.y) / cellSize);

  for (let cx = minX; cx <= maxX; cx++) {
    for (let cy = minY; cy <= maxY; cy++) {
      const key = cellKey(cx, cy);
      const bucket = grid.get(key);
      if (bucket) {
        if (bucket[bucket.length - 1] !== edgeIndex) bucket.push(edgeIndex);
      } else {
        grid.set(key, [edgeIndex]);
      }
    }
  }
}

function rowsFitToWidth(
  rows: NodeRow[],
  width: number,
  measureText: MeasureText,
): NodeRow[] {
  const budget = width - NODE_PAD_X * 2;
  return rows.map((row) =>
    row.kind === 'description'
      ? { kind: 'description', text: truncateToWidth(row.text, FONT_BODY, budget, measureText) }
      : row,
  );
}

/**
 * Builds the draw-ready scene.
 *
 * Text is fitted once here rather than per frame. Edge segments go into a
 * uniform grid because their count grows fastest with machine size; nodes are
 * hit-tested by a reverse-depth scan, which stays cheaper than a grid at the
 * node counts a statechart reaches (a root container would otherwise occupy
 * every cell).
 */
export function buildScene(
  layout: LayoutGraph,
  measureText: MeasureText,
): Scene {
  const nodes: SceneNode[] = layout.nodes.map((node) => {
    const headerBudget = node.width - NODE_PAD_X * 2 - GLYPH_WIDTH;
    return {
      ...node,
      headerText: truncateToWidth(node.data.key, FONT_HEADER, headerBudget, measureText),
      rows: node.isContainer
        ? []
        : rowsFitToWidth(nodeRows(node.data), node.width, measureText),
    };
  });

  const edgeGrid = new Map<string, number[]>();
  layout.edges.forEach((edge, index) => {
    for (let i = 1; i < edge.points.length; i++) {
      addSegmentToGrid(edgeGrid, edge.points[i - 1], edge.points[i], index, CELL_SIZE);
    }
  });

  return {
    nodes,
    edges: layout.edges,
    nodeById: new Map(nodes.map((n) => [n.id, n])),
    hitOrder: [...nodes].sort((a, b) => b.depth - a.depth),
    bounds: { x: 0, y: 0, width: layout.width, height: layout.height },
    droppedEdgeCount: layout.droppedEdgeCount,
    edgeGrid,
    cellSize: CELL_SIZE,
  };
}

/** Deepest node containing `p`, or null. */
export function hitTestNode(scene: Scene, p: Point): SceneNode | null {
  for (const node of scene.hitOrder) {
    if (
      p.x >= node.x &&
      p.x <= node.x + node.width &&
      p.y >= node.y &&
      p.y <= node.y + node.height
    ) {
      return node;
    }
  }
  return null;
}

/** Squared distance from `p` to segment `a`–`b`. */
function distanceSqToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return (p.x - cx) ** 2 + (p.y - cy) ** 2;
}

/** Nearest edge within `tolerance` world units of `p`, or null. */
export function hitTestEdge(
  scene: Scene,
  p: Point,
  tolerance: number,
): LayoutEdge | null {
  const cx = Math.floor(p.x / scene.cellSize);
  const cy = Math.floor(p.y / scene.cellSize);

  let best: LayoutEdge | null = null;
  let bestDistanceSq = tolerance * tolerance;
  const seen = new Set<number>();

  // The tolerance can straddle a cell boundary, so check the 3×3 neighbourhood.
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const bucket = scene.edgeGrid.get(cellKey(gx, gy));
      if (!bucket) continue;
      for (const index of bucket) {
        if (seen.has(index)) continue;
        seen.add(index);
        const edge = scene.edges[index];
        for (let i = 1; i < edge.points.length; i++) {
          const d = distanceSqToSegment(p, edge.points[i - 1], edge.points[i]);
          if (d < bestDistanceSq) {
            bestDistanceSq = d;
            best = edge;
          }
        }
      }
    }
  }

  return best;
}
