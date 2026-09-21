import type { LayoutEdge, Point, Rect } from '@/lib/layout/types';
import {
  EDGE_GUARD_GAP,
  EDGE_ICON_WIDTH,
  EDGE_LABEL_PAD_X,
  FONT_BODY,
  FONT_DESCRIPTION,
  FONT_HEADER,
  FONT_LABEL,
  FONT_ROW_KEY,
  HEADER_HEIGHT,
  NODE_PAD_X,
  ROW_HEIGHT,
  edgeLabelText,
} from '@/lib/layout/measure';
import { getEventCategory } from '@/lib/machine';
import { rectsIntersect, visibleWorldRect, type Camera } from './camera';
import type { Scene, SceneNode } from './scene';
import type { CanvasTheme } from './theme';

/**
 * Zoom thresholds at which progressively more detail is drawn. Below the first
 * threshold a 99-node graph is mostly sub-pixel text, so drawing it is wasted
 * work; above the second everything is legible.
 */
export const LOD_LABELS = 0.35;
export const LOD_DETAIL = 0.7;

/** Spacing of the background dot grid, in world units. */
const GRID_SPACING = 32;
const NODE_RADIUS = 7;
/** Header text starts after the type-glyph slot. */
const GLYPH_OFFSET = 17;

export interface RenderState {
  activeIds: ReadonlySet<string>;
  hoveredNodeId: string | null;
  hoveredEdgeId: string | null;
  selectedNodeId: string | null;
  /**
   * 0–1 activation fade per node, so a state change eases in over 150ms the
   * way `transition-... duration-150` does in the DOM renderer. Defaults to a
   * hard 0/1 from `activeIds` when no tracker is supplied.
   */
  activation?: (nodeId: string) => number;
  /** 0–1 progress of an `after` transition's timer, or null to draw no bar. */
  timerProgress?: (edgeId: string) => number | null;
}

export const emptyRenderState: RenderState = {
  activeIds: new Set(),
  hoveredNodeId: null,
  hoveredEdgeId: null,
  selectedNodeId: null,
};

const activationOf = (state: RenderState, nodeId: string): number =>
  state.activation?.(nodeId) ?? (state.activeIds.has(nodeId) ? 1 : 0);

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** `letterSpacing` is recent; setting it is a no-op where unsupported. */
function setLetterSpacing(ctx: CanvasRenderingContext2D, value: string): void {
  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = value;
  } catch {
    /* older engine — tracking is cosmetic */
  }
}

/** Faint dot grid, so panning an empty region still reads as movement. */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  viewport: Rect,
  scale: number,
): void {
  if (scale < 0.6) return;
  const step = GRID_SPACING;
  const startX = Math.floor(viewport.x / step) * step;
  const startY = Math.floor(viewport.y / step) * step;
  const radius = 1 / scale;

  ctx.globalAlpha = 0.07;
  ctx.fillStyle = theme.mutedForeground;
  ctx.beginPath();
  for (let x = startX; x < viewport.x + viewport.width; x += step) {
    for (let y = startY; y < viewport.y + viewport.height; y += step) {
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
  }
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawChip(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  text: string,
  x: number,
  y: number,
): number {
  const width = ctx.measureText(text).width;
  ctx.fillStyle = theme.muted;
  roundedRect(ctx, x - 3, y - 7.5, width + 6, 15, 3);
  ctx.fill();
  ctx.fillStyle = theme.foreground;
  ctx.fillText(text, x, y);
  return width + 10;
}

/** Small uppercase key like ENTRY / EXIT / INVOKE. Returns its width. */
function drawRowKey(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  label: string,
  x: number,
  y: number,
): number {
  ctx.font = FONT_ROW_KEY;
  setLetterSpacing(ctx, '0.5px');
  ctx.fillStyle = theme.mutedForeground;
  ctx.fillText(label, x, y);
  const width = ctx.measureText(label).width;
  setLetterSpacing(ctx, '0px');
  return width + 6;
}

/** The affordance glyph for a node's type, drawn left of its key. */
function drawNodeGlyph(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  node: SceneNode,
  x: number,
  y: number,
  active: boolean,
): void {
  const { data } = node;
  const tint = active ? theme.primary : theme.mutedForeground;
  ctx.strokeStyle = tint;
  ctx.fillStyle = tint;
  ctx.lineWidth = 1.4;

  if (data.type === 'history') {
    roundedRect(ctx, x, y - 5.5, 12, 11, 2);
    ctx.stroke();
    ctx.font = '700 7px Figtree, system-ui, sans-serif';
    ctx.fillText(data.historyType === 'deep' ? 'H*' : 'H', x + 2, y + 0.5);
    return;
  }
  if (data.type === 'parallel') {
    ctx.fillRect(x, y - 5, 3, 10);
    ctx.fillRect(x + 5, y - 5, 3, 10);
    return;
  }
  if (data.type === 'final') {
    ctx.beginPath();
    ctx.arc(x + 5, y, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 5, y, 2.4, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (node.isChoice) {
    ctx.save();
    ctx.translate(x + 5, y);
    ctx.rotate(Math.PI / 4);
    ctx.strokeRect(-4, -4, 8, 8);
    ctx.restore();
    return;
  }
  if (node.isInitial) {
    // Filled dot with a stub — the statechart initial marker.
    ctx.beginPath();
    ctx.arc(x + 3, y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 6, y);
    ctx.lineTo(x + 11, y);
    ctx.stroke();
  }
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  node: SceneNode,
  state: RenderState,
  scale: number,
): void {
  const activation = activationOf(state, node.id);
  const isHovered = state.hoveredNodeId === node.id;
  const isSelected = state.selectedNodeId === node.id;
  // An active leaf is the state the machine is *in*; an active container is
  // merely an ancestor of it, so it gets a lighter treatment.
  const leafActivation = node.isContainer ? 0 : activation;

  // Body. Flat, like the DOM renderer's cards — no drop shadow.
  if (node.isContainer) {
    // Deeper containers sit slightly lighter so nesting reads at a glance.
    ctx.globalAlpha = 0.03 + Math.min(node.depth, 3) * 0.012;
    ctx.fillStyle = theme.foreground;
  } else {
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.card;
  }
  roundedRect(ctx, node.x, node.y, node.width, node.height, NODE_RADIUS);
  ctx.fill();
  ctx.globalAlpha = 1;

  if (leafActivation > 0) {
    // `bg-primary/10`, faded in with the activation.
    ctx.globalAlpha = 0.1 * leafActivation;
    ctx.fillStyle = theme.primary;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Border. The DOM renderer uses a 2px border, so match its weight.
  const emphasised = leafActivation > 0.5 || isSelected;
  const primaryBorder = activation > 0 || isSelected || isHovered;
  ctx.strokeStyle = primaryBorder ? theme.primary : theme.border;
  ctx.globalAlpha =
    activation > 0 && leafActivation === 0
      ? 0.25 + 0.3 * activation // active ancestor: present but subdued
      : primaryBorder && !isSelected && !isHovered
        ? Math.max(0.25, activation)
        : 1;
  ctx.lineWidth = (emphasised ? 2.25 : 1.75) / scale;
  if (node.isRegion) ctx.setLineDash([6 / scale, 4 / scale]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // `shadow-[0_0_0_1px_var(--color-primary)]` — the DOM's highlight ring.
  if (isHovered || isSelected) {
    ctx.strokeStyle = theme.primary;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1 / scale;
    roundedRect(
      ctx,
      node.x - 2 / scale,
      node.y - 2 / scale,
      node.width + 4 / scale,
      node.height + 4 / scale,
      NODE_RADIUS + 2 / scale,
    );
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Final states get the statechart double border.
  if (node.data.type === 'final') {
    ctx.strokeStyle = primaryBorder ? theme.primary : theme.border;
    ctx.lineWidth = 1.5 / scale;
    roundedRect(
      ctx,
      node.x + 4,
      node.y + 4,
      node.width - 8,
      node.height - 8,
      Math.max(2, NODE_RADIUS - 3),
    );
    ctx.stroke();
  }

  if (scale < LOD_LABELS) return;

  // Header
  const textY = node.y + HEADER_HEIGHT / 2 + 1;
  drawNodeGlyph(ctx, theme, node, node.x + NODE_PAD_X, textY, activation > 0.5);

  ctx.font = FONT_HEADER;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = activation > 0.5 ? theme.primary : theme.foreground;
  ctx.fillText(node.headerText, node.x + NODE_PAD_X + GLYPH_OFFSET, textY);

  if (scale < LOD_DETAIL || node.rows.length === 0) return;

  let rowY = node.y + HEADER_HEIGHT;
  for (const row of node.rows) {
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    ctx.moveTo(node.x, rowY);
    ctx.lineTo(node.x + node.width, rowY);
    ctx.stroke();

    const centreY = rowY + ROW_HEIGHT / 2;
    const rowRight = node.x + node.width;

    if (row.kind === 'description') {
      ctx.font = FONT_DESCRIPTION;
      ctx.fillStyle = theme.mutedForeground;
      ctx.fillText(row.text, node.x + NODE_PAD_X, centreY);
    } else if (row.kind === 'invoke') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(node.x, rowY, node.width, ROW_HEIGHT);
      ctx.clip();
      let x = node.x + NODE_PAD_X;
      x += drawRowKey(ctx, theme, 'INVOKE', x, centreY);
      ctx.font = FONT_BODY;
      for (const item of row.items) {
        if (x > rowRight) break;
        x += drawChip(ctx, theme, item, x, centreY);
      }
      ctx.restore();
    } else {
      // Entry and exit share the row in two columns, as the DOM renderer does.
      const split = row.entry.length > 0 && row.exit.length > 0;
      const midX = node.x + node.width / 2;
      const columns: Array<{ label: string; items: string[]; x0: number; x1: number }> = [];
      if (row.entry.length > 0) {
        columns.push({
          label: 'ENTRY',
          items: row.entry,
          x0: node.x,
          x1: split ? midX : rowRight,
        });
      }
      if (row.exit.length > 0) {
        columns.push({
          label: 'EXIT',
          items: row.exit,
          x0: split ? midX : node.x,
          x1: rowRight,
        });
      }

      if (split) {
        ctx.beginPath();
        ctx.moveTo(midX, rowY);
        ctx.lineTo(midX, rowY + ROW_HEIGHT);
        ctx.stroke();
      }

      for (const column of columns) {
        // Clip to the column so a long action list can never bleed into its
        // neighbour, however the node was sized.
        ctx.save();
        ctx.beginPath();
        ctx.rect(column.x0, rowY, column.x1 - column.x0, ROW_HEIGHT);
        ctx.clip();

        let x = column.x0 + NODE_PAD_X;
        x += drawRowKey(ctx, theme, column.label, x, centreY);
        ctx.font = FONT_BODY;
        for (const item of column.items) {
          if (x > column.x1) break;
          x += drawChip(ctx, theme, item, x, centreY);
        }
        ctx.restore();
      }
    }

    rowY += ROW_HEIGHT;
  }
}

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  scale: number,
): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 6.5 / scale;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - size * Math.cos(angle - Math.PI / 7),
    to.y - size * Math.sin(angle - Math.PI / 7),
  );
  ctx.lineTo(
    to.x - size * Math.cos(angle + Math.PI / 7),
    to.y - size * Math.sin(angle + Math.PI / 7),
  );
  ctx.closePath();
  ctx.fill();
}

type EdgeEmphasis = 'normal' | 'dim' | 'strong';

function edgeEmphasis(
  edge: LayoutEdge,
  state: RenderState,
  hoveredOutEdges: ReadonlySet<string> | null,
): EdgeEmphasis {
  if (state.hoveredEdgeId === edge.id) return 'strong';
  if (hoveredOutEdges) return hoveredOutEdges.has(edge.id) ? 'strong' : 'dim';
  if (activationOf(state, edge.sourceId) > 0.5) return 'strong';
  return 'normal';
}

const EDGE_ALPHA: Record<EdgeEmphasis, number> = {
  strong: 1,
  normal: 0.4,
  dim: 0.12,
};

function drawEdge(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  edge: LayoutEdge,
  emphasis: EdgeEmphasis,
  scale: number,
): void {
  ctx.strokeStyle = emphasis === 'strong' ? theme.primary : theme.mutedForeground;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.globalAlpha = EDGE_ALPHA[emphasis];
  ctx.lineWidth = (emphasis === 'strong' ? 1.9 : 1.25) / scale;

  const points = edge.points;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();

  if (scale >= LOD_LABELS && points.length >= 2) {
    drawArrowhead(ctx, points[points.length - 2], points[points.length - 1], scale);
  }
  ctx.globalAlpha = 1;
}

/**
 * Category glyph for a transition: timer for `after`, loop for `always`, tick
 * for `done`, cross for `error`. Mirrors the icons `TransitionViz` shows.
 */
function drawEventIcon(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  category: 'after' | 'always' | 'done' | 'error',
  x: number,
  y: number,
): void {
  ctx.lineWidth = 1.3;
  if (category === 'done') {
    ctx.strokeStyle = '#22c55e';
    ctx.beginPath();
    ctx.moveTo(x + 1, y);
    ctx.lineTo(x + 3.5, y + 2.8);
    ctx.lineTo(x + 8, y - 3);
    ctx.stroke();
    return;
  }
  if (category === 'error') {
    ctx.strokeStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(x + 1, y - 3);
    ctx.lineTo(x + 8, y + 3);
    ctx.moveTo(x + 8, y - 3);
    ctx.lineTo(x + 1, y + 3);
    ctx.stroke();
    return;
  }
  ctx.strokeStyle = theme.mutedForeground;
  if (category === 'after') {
    ctx.beginPath();
    ctx.arc(x + 4.5, y, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 4.5, y - 2.2);
    ctx.lineTo(x + 4.5, y);
    ctx.lineTo(x + 6.4, y + 1.2);
    ctx.stroke();
    return;
  }
  // always — a small lemniscate
  ctx.beginPath();
  ctx.arc(x + 2.6, y, 2.4, 0, Math.PI * 2);
  ctx.moveTo(x + 9.4, y);
  ctx.arc(x + 7, y, 2.4, 0, Math.PI * 2);
  ctx.stroke();
}

function drawEdgeLabel(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  edge: LayoutEdge,
  emphasis: EdgeEmphasis,
  progress: number | null,
): void {
  const label = edge.label;
  if (!label || emphasis === 'dim') return;

  const strong = emphasis === 'strong';

  // A knockout behind the text, not a bordered pill: the DOM renderer shows
  // transitions as plain type on the page background.
  ctx.globalAlpha = 0.94;
  ctx.fillStyle = theme.background;
  roundedRect(ctx, label.x, label.y, label.width, label.height, 3);
  ctx.fill();
  ctx.globalAlpha = 1;

  // The simulation's timer bar: a primary fill sweeping across the label as
  // the `after` delay elapses.
  if (progress !== null) {
    ctx.save();
    ctx.beginPath();
    roundedRect(ctx, label.x, label.y, label.width, label.height, 3);
    ctx.clip();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = theme.primary;
    ctx.fillRect(label.x, label.y, label.width * progress, label.height);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  let x = label.x + EDGE_LABEL_PAD_X;
  const centreY = label.y + label.height / 2;

  const category = getEventCategory(edge.data.eventType);
  if (category) {
    drawEventIcon(ctx, theme, category, x, centreY);
    x += EDGE_ICON_WIDTH;
  }

  const text = edgeLabelText(edge.data);
  if (text) {
    ctx.font = FONT_LABEL;
    ctx.fillStyle = strong ? theme.primary : theme.foreground;
    ctx.fillText(text, x, centreY);
    x += ctx.measureText(text).width;
  }

  if (edge.data.guard) {
    ctx.font = FONT_BODY;
    ctx.fillStyle = theme.primary;
    ctx.globalAlpha = strong ? 1 : 0.75;
    ctx.fillText(`[${edge.data.guard}]`, x + EDGE_GUARD_GAP, centreY);
    ctx.globalAlpha = 1;
  }
}

/**
 * One labelled loop per node, for its self and targetless transitions.
 *
 * The arc deliberately stops short of a full turn: a 2π sweep closes the
 * circle and buries the arrowhead under its own start point, which reads as a
 * stray ring rather than a transition.
 */
const LOOP_START = Math.PI * 0.3;
/** Equivalent to 0.7π, reached anticlockwise, leaving a 0.4π gap at the base. */
const LOOP_END = Math.PI * -1.3;

function drawSelfLoop(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  node: SceneNode,
  label: string,
  active: boolean,
  scale: number,
): void {
  // The whole loop clears the node's top edge, so the gap in the arc and the
  // arrowhead are both visible instead of being hidden behind the border.
  const r = 7;
  const cx = node.x + node.width - 18;
  const cy = node.y - r - 4;

  const at = (angle: number): Point => ({
    x: cx + r * Math.cos(angle),
    y: cy + r * Math.sin(angle),
  });

  ctx.strokeStyle = active ? theme.primary : theme.mutedForeground;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.globalAlpha = active ? 0.95 : 0.5;
  ctx.lineWidth = 1.4 / scale;

  ctx.beginPath();
  ctx.arc(cx, cy, r, LOOP_START, LOOP_END, true);
  ctx.stroke();

  if (scale >= LOD_LABELS) {
    drawArrowhead(ctx, at(LOOP_END + 0.25), at(LOOP_END), scale);
  }
  ctx.globalAlpha = 1;

  // Name the events, so the glyph says which transitions it stands for.
  if (scale < LOD_DETAIL || !label) return;

  ctx.font = FONT_LABEL;
  const textWidth = ctx.measureText(label).width;
  const boxWidth = textWidth + EDGE_LABEL_PAD_X * 2;
  const boxX = cx - boxWidth / 2;
  const boxY = cy - r - 21;

  ctx.globalAlpha = 0.94;
  ctx.fillStyle = theme.background;
  roundedRect(ctx, boxX, boxY, boxWidth, 18, 3);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = active ? theme.primary : theme.mutedForeground;
  ctx.fillText(label, boxX + EDGE_LABEL_PAD_X, boxY + 9);
}

export interface DrawOptions {
  ctx: CanvasRenderingContext2D;
  scene: Scene;
  camera: Camera;
  theme: CanvasTheme;
  state: RenderState;
  /** CSS pixel size of the viewport. */
  width: number;
  height: number;
  devicePixelRatio: number;
}

/** Number of nodes and edges drawn in the last frame; used by tests. */
export interface DrawStats {
  nodes: number;
  edges: number;
}

/** Culling margin so partly off-screen geometry still draws its ends. */
const CULL_MARGIN = 64;

function inflate(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + by * 2,
    height: rect.height + by * 2,
  };
}

function edgeBounds(edge: LayoutEdge): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of edge.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Draws one frame.
 *
 * Everything off-screen is culled and text below the LOD thresholds is skipped,
 * so cost tracks what is actually visible rather than machine size.
 */
export function draw(options: DrawOptions): DrawStats {
  const { ctx, scene, camera, theme, state, width, height, devicePixelRatio } = options;
  const scale = camera.scale;

  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-camera.x, -camera.y);
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const viewport = inflate(visibleWorldRect(camera, width, height), CULL_MARGIN / scale);
  const stats: DrawStats = { nodes: 0, edges: 0 };

  drawGrid(ctx, theme, viewport, scale);

  // Hovering a node emphasises the transitions leaving it and fades the rest,
  // the canvas equivalent of the DOM renderer's hover highlighting.
  const hoveredOutEdges = state.hoveredNodeId
    ? new Set(scene.outEdgeIds.get(state.hoveredNodeId) ?? [])
    : null;

  // Edges under nodes, so boxes stay readable where routes pass behind them.
  const visible: Array<{ edge: LayoutEdge; emphasis: EdgeEmphasis }> = [];
  for (const edge of scene.edges) {
    if (edge.isSelf || edge.points.length < 2) continue;
    if (!rectsIntersect(viewport, edgeBounds(edge))) continue;
    const emphasis = edgeEmphasis(edge, state, hoveredOutEdges);
    visible.push({ edge, emphasis });
    drawEdge(ctx, theme, edge, emphasis, scale);
    stats.edges++;
  }

  for (const node of scene.nodes) {
    if (!rectsIntersect(viewport, node)) continue;
    drawNode(ctx, theme, node, state, scale);
    stats.nodes++;
  }

  for (const [nodeId, label] of scene.selfLoopLabels) {
    const node = scene.nodeById.get(nodeId);
    if (!node || !rectsIntersect(viewport, node)) continue;
    drawSelfLoop(ctx, theme, node, label, activationOf(state, nodeId) > 0.5, scale);
  }

  if (scale >= LOD_DETAIL) {
    for (const { edge, emphasis } of visible) {
      drawEdgeLabel(
        ctx,
        theme,
        edge,
        emphasis,
        state.timerProgress?.(edge.id) ?? null,
      );
    }
  }

  ctx.restore();
  return stats;
}
