import type { StateNodeData, TransitionData } from '@/lib/machine';
import { getEventCategory } from '@/lib/machine';

/** Measures the advance width of `text` at the given CSS font shorthand. */
export type MeasureText = (text: string, font: string) => number;

/**
 * Type matched to the DOM renderer, which is the rest of Sketch: Figtree for
 * headings and row keys, mono for event names and action chips, sans-italic
 * for descriptions.
 */
const SANS = "'Figtree Variable', Figtree, system-ui, sans-serif";
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export const FONT_HEADER = `600 16px ${SANS}`;
/** Action chips and event names — `font-mono text-[0.6875rem]` in the DOM. */
export const FONT_BODY = `11px ${MONO}`;
/** State descriptions — `text-xs italic text-muted-foreground` in the DOM. */
export const FONT_DESCRIPTION = `italic 12px ${SANS}`;
export const FONT_LABEL = `600 11px ${MONO}`;
/** `text-[0.625rem] font-semibold uppercase tracking-wider` in the DOM. */
export const FONT_ROW_KEY = `600 10px ${SANS}`;

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
      return measureText(row.text, FONT_DESCRIPTION);
    case 'invoke':
      return chipRowWidth('INVOKE', row.items, measureText);
    case 'actions': {
      const entry =
        row.entry.length > 0 ? chipRowWidth('ENTRY', row.entry, measureText) : 0;
      const exit =
        row.exit.length > 0 ? chipRowWidth('EXIT', row.exit, measureText) : 0;
      // Entry and exit render side by side in equal halves, so the row needs
      // twice the wider column — not the wider of the two.
      return entry > 0 && exit > 0 ? Math.max(entry, exit) * 2 : entry + exit;
    }
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

export const EDGE_LABEL_HEIGHT = 18;
export const EDGE_LABEL_PAD_X = 6;
/** Space reserved for the event-category glyph (timer, always, done, error). */
export const EDGE_ICON_WIDTH = 13;
/** Separator between the event name and its guard. */
export const EDGE_GUARD_GAP = 6;

/**
 * The text a transition's label shows.
 *
 * `displayEvent` is already the cleaned-up form, and it is empty for `always`
 * transitions — those are conveyed by the category glyph alone, exactly as the
 * DOM renderer does. Falling back to `eventType` here would print the literal
 * string `(always)`.
 */
export function edgeLabelText(data: TransitionData): string {
  return data.displayEvent ?? '';
}

/**
 * Size of a transition's label box.
 *
 * The box has to fit the same information the DOM renderer shows inline: a
 * category glyph, the event name, and the guard when there is one. Every
 * transition gets a box — one with no event name still carries a glyph, since
 * an empty event type is an `always` transition.
 */
export function measureEdgeLabel(
  data: TransitionData,
  measureText: MeasureText,
): { width: number; height: number; text: string } {
  const text = edgeLabelText(data);
  const hasIcon = getEventCategory(data.eventType) !== null;

  let width = EDGE_LABEL_PAD_X * 2;
  if (hasIcon) width += EDGE_ICON_WIDTH;
  if (text) width += measureText(text, FONT_LABEL);
  if (data.guard) {
    width += EDGE_GUARD_GAP + measureText(`[${data.guard}]`, FONT_BODY);
  }

  return { width: Math.ceil(width), height: EDGE_LABEL_HEIGHT, text };
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
