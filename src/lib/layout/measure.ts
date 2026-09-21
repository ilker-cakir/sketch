import type { StateNodeData } from '@/lib/machine';

/** Measures the advance width of `text` at the given CSS font shorthand. */
export type MeasureText = (text: string, font: string) => number;

export const FONT_HEADER = '600 15px Figtree, system-ui, sans-serif';
export const FONT_BODY = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
export const FONT_LABEL = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
export const FONT_ROW_KEY = '600 9px Figtree, system-ui, sans-serif';

export const NODE_MIN_WIDTH = 140;
export const NODE_MAX_WIDTH = 320;
export const NODE_PAD_X = 10;
export const HEADER_HEIGHT = 28;
export const ROW_HEIGHT = 18;
/** Leading space in the header reserved for type affordance glyphs. */
export const GLYPH_WIDTH = 18;

/** Padding between a container's border and its laid-out children. */
export const CONTAINER_PAD_X = 14;
export const CONTAINER_PAD_BOTTOM = 14;

export interface NodeMetrics {
  width: number;
  height: number;
  /** Vertical space taken by the node's own chrome, above any children. */
  headerHeight: number;
  /** The body rows this node renders, in order. */
  rows: NodeRow[];
}

export type NodeRow =
  | { kind: 'description'; text: string }
  | { kind: 'invoke'; items: string[] }
  | { kind: 'actions'; entry: string[]; exit: string[] };

/** Text truncated with an ellipsis so it fits within `maxWidth`. */
export function truncateToWidth(
  text: string,
  font: string,
  maxWidth: number,
  measureText: MeasureText,
): string {
  if (measureText(text, font) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureText(`${text.slice(0, mid)}…`, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/** The body rows a node renders, in order. Shared by measurement and drawing. */
export function nodeRows(data: StateNodeData): NodeRow[] {
  const rows: NodeRow[] = [];
  if (data.description) rows.push({ kind: 'description', text: data.description });
  if (data.invocations.length > 0) {
    rows.push({ kind: 'invoke', items: data.invocations });
  }
  if (data.entry.length > 0 || data.exit.length > 0) {
    rows.push({ kind: 'actions', entry: data.entry, exit: data.exit });
  }
  return rows;
}

/** Width needed by a row of chips, including its uppercase key prefix. */
function chipRowWidth(
  keyText: string,
  items: string[],
  measureText: MeasureText,
): number {
  const key = measureText(keyText, FONT_ROW_KEY) + 6;
  const chips = items.reduce(
    (sum, item) => sum + measureText(item, FONT_BODY) + 10,
    0,
  );
  return key + chips;
}

function rowWidth(row: NodeRow, measureText: MeasureText): number {
  switch (row.kind) {
    case 'description':
      return measureText(row.text, FONT_BODY);
    case 'invoke':
      return chipRowWidth('INVOKE', row.items, measureText);
    case 'actions':
      return Math.max(
        row.entry.length > 0 ? chipRowWidth('ENTRY', row.entry, measureText) : 0,
        row.exit.length > 0 ? chipRowWidth('EXIT', row.exit, measureText) : 0,
      );
  }
}

/**
 * Intrinsic size of a state node from its own content, ignoring children.
 *
 * For containers this is the *minimum* size and the `headerHeight` that ELK
 * must reserve as top padding; ELK grows the box to fit the children it lays
 * out inside.
 */
export function measureNode(
  data: StateNodeData,
  measureText: MeasureText,
): NodeMetrics {
  const rows = nodeRows(data);

  const headerWidth =
    GLYPH_WIDTH + measureText(data.key, FONT_HEADER) + NODE_PAD_X * 2;
  const widest = rows.reduce(
    (max, row) => Math.max(max, rowWidth(row, measureText) + NODE_PAD_X * 2),
    headerWidth,
  );

  const width = Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, Math.ceil(widest)));
  const headerHeight = HEADER_HEIGHT + rows.length * ROW_HEIGHT;

  return { width, height: headerHeight, headerHeight, rows };
}

/** Size of an edge's label box, or null when the edge has nothing to show. */
export function measureEdgeLabel(
  text: string,
  measureText: MeasureText,
): { width: number; height: number } | null {
  if (!text) return null;
  return { width: Math.ceil(measureText(text, FONT_LABEL)) + 8, height: 16 };
}

/**
 * A `MeasureText` backed by a canvas, with a per-(font, text) cache.
 *
 * Falls back to a rough monospace approximation when no 2D context is
 * available, so layout still produces sane boxes in SSR and in tests.
 */
export function createCanvasMeasureText(): MeasureText {
  const cache = new Map<string, number>();
  let ctx: CanvasRenderingContext2D | null = null;
  if (typeof document !== 'undefined') {
    ctx = document.createElement('canvas').getContext('2d');
  }

  return (text, font) => {
    const key = `${font}\u0000${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    let width: number;
    if (ctx) {
      ctx.font = font;
      width = ctx.measureText(text).width;
    } else {
      const size = Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 12);
      width = text.length * size * 0.6;
    }

    cache.set(key, width);
    return width;
  };
}
