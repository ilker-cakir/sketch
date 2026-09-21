import type { StateNodeData, TransitionData } from '@/lib/machine';

/** A point in world (post-layout) coordinates. */
export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A laid-out state node. `x`/`y` are absolute world coordinates — ELK reports
 * child coordinates relative to their parent container, and `fromElk` has
 * already accumulated them.
 */
export interface LayoutNode extends Rect {
  id: string;
  parentId: string | null;
  /** Nesting depth; roots are 0. Used for z-order and container shading. */
  depth: number;
  data: StateNodeData;
  /** True when this node contains other nodes and should render as a container. */
  isContainer: boolean;
  /** Whether this node is the initial child of its parent. */
  isInitial: boolean;
  /** Whether the parent is a parallel state, i.e. this node is a region. */
  isRegion: boolean;
}

/**
 * A laid-out transition. `points` is an absolute-coordinate polyline from
 * source to target, including ELK's orthogonal bend points.
 */
export interface LayoutEdge {
  id: string;
  sourceId: string;
  targetId: string;
  data: TransitionData;
  points: Point[];
  /** Absolute position of the edge label's top-left corner, if it has one. */
  label: (Rect & { text: string }) | null;
  /** Source and target are the same node — drawn as a loop glyph. */
  isSelf: boolean;
}

export interface LayoutGraph {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** Bounding box of the whole laid-out graph, in world coordinates. */
  width: number;
  height: number;
  /** Edges dropped because an endpoint was not present in the node set. */
  droppedEdgeCount: number;
}
