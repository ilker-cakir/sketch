import type { LayoutEdge, Point, Rect } from '@/lib/layout/types';
import {
  FONT_BODY,
  FONT_HEADER,
  FONT_LABEL,
  FONT_ROW_KEY,
  HEADER_HEIGHT,
  NODE_PAD_X,
  ROW_HEIGHT,
} from '@/lib/layout/measure';
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

export interface RenderState {
  activeIds: ReadonlySet<string>;
  hoveredNodeId: string | null;
  hoveredEdgeId: string | null;
  selectedNodeId: string | null;
}

export const emptyRenderState: RenderState = {
  activeIds: new Set(),
  hoveredNodeId: null,
  hoveredEdgeId: null,
  selectedNodeId: null,
};

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawChip(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  text: string,
  x: number,
  y: number,
): number {
  const width = ctx.measureText(text).width;
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = theme.muted;
  roundedRect(ctx, x - 3, y - 7, width + 6, 14, 3);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = theme.foreground;
  ctx.fillText(text, x, y);
  return width + 10;
}

/** The affordance glyph for a node's type, drawn left of its key. */
function drawNodeGlyph(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  node: SceneNode,
  x: number,
  y: number,
): void {
  const { data } = node;
  ctx.strokeStyle = theme.mutedForeground;
  ctx.fillStyle = theme.mutedForeground;
  ctx.lineWidth = 1.5;

  if (data.type === 'history') {
    ctx.strokeRect(x, y - 5, 11, 11);
    ctx.font = '700 7px Figtree, system-ui, sans-serif';
    ctx.fillText(data.historyType === 'deep' ? 'H*' : 'H', x + 2, y + 3.5);
    return;
  }
  if (data.type === 'parallel') {
    ctx.fillRect(x, y - 5, 3, 11);
    ctx.fillRect(x + 5, y - 5, 3, 11);
    return;
  }
  if (data.type === 'final') {
    ctx.beginPath();
    ctx.arc(x + 5, y, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 5, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (node.isInitial) {
    // Filled dot with a stub, mirroring the statechart initial marker.
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
  const isActive = state.activeIds.has(node.id);
  const isHovered = state.hoveredNodeId === node.id;
  const isSelected = state.selectedNodeId === node.id;

  // Body
  if (node.isContainer) {
    ctx.globalAlpha = 0.035;
    ctx.fillStyle = theme.foreground;
  } else {
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.card;
  }
  roundedRect(ctx, node.x, node.y, node.width, node.height, 6);
  ctx.fill();
  ctx.globalAlpha = 1;

  if (isActive) {
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = theme.primary;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Border
  ctx.strokeStyle = isActive || isSelected || isHovered ? theme.primary : theme.border;
  ctx.lineWidth = (isActive || isSelected ? 2 : 1) / scale;
  if (node.isRegion) ctx.setLineDash([6 / scale, 4 / scale]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (node.data.type === 'final') {
    roundedRect(ctx, node.x + 3, node.y + 3, node.width - 6, node.height - 6, 4);
    ctx.stroke();
  }

  if (scale < LOD_LABELS) return;

  // Header
  const textY = node.y + HEADER_HEIGHT / 2 + 1;
  drawNodeGlyph(ctx, theme, node, node.x + NODE_PAD_X, textY);

  ctx.font = FONT_HEADER;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = isActive ? theme.primary : theme.foreground;
  ctx.fillText(node.headerText, node.x + NODE_PAD_X + 16, textY);

  if (scale < LOD_DETAIL || node.rows.length === 0) return;

  // Body rows
  let rowY = node.y + HEADER_HEIGHT;
  for (const row of node.rows) {
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    ctx.moveTo(node.x, rowY);
    ctx.lineTo(node.x + node.width, rowY);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const centreY = rowY + ROW_HEIGHT / 2;
    let x = node.x + NODE_PAD_X;

    if (row.kind === 'description') {
      ctx.font = FONT_BODY;
      ctx.fillStyle = theme.mutedForeground;
      ctx.fillText(row.text, x, centreY);
    } else {
      const label = row.kind === 'invoke' ? 'INVOKE' : row.entry.length ? 'ENTRY' : 'EXIT';
      ctx.font = FONT_ROW_KEY;
      ctx.fillStyle = theme.mutedForeground;
      ctx.fillText(label, x, centreY);
      x += ctx.measureText(label).width + 6;

      ctx.font = FONT_BODY;
      const items = row.kind === 'invoke' ? row.items : [...row.entry, ...row.exit];
      const limit = node.x + node.width - NODE_PAD_X;
      for (const item of items) {
        if (x > limit) break;
        x += drawChip(ctx, theme, item, x, centreY);
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
  const size = 6 / scale;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - size * Math.cos(angle - Math.PI / 6),
    to.y - size * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    to.x - size * Math.cos(angle + Math.PI / 6),
    to.y - size * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  edge: LayoutEdge,
  state: RenderState,
  scale: number,
): void {
  const isActive = state.activeIds.has(edge.sourceId);
  const isHovered = state.hoveredEdgeId === edge.id;

  ctx.strokeStyle = isHovered || isActive ? theme.primary : theme.mutedForeground;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.globalAlpha = isHovered ? 1 : isActive ? 0.85 : 0.4;
  ctx.lineWidth = (isHovered ? 2 : 1.25) / scale;

  const points = edge.points;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();

  if (scale >= LOD_DETAIL && points.length >= 2) {
    drawArrowhead(ctx, points[points.length - 2], points[points.length - 1], scale);
  }
  ctx.globalAlpha = 1;
}

/** A small loop on the node's top-right for self and targetless transitions. */
function drawSelfLoop(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  node: SceneNode,
  active: boolean,
  scale: number,
): void {
  const x = node.x + node.width - 8;
  const y = node.y;
  ctx.strokeStyle = active ? theme.primary : theme.mutedForeground;
  ctx.globalAlpha = active ? 0.85 : 0.45;
  ctx.lineWidth = 1.25 / scale;
  ctx.beginPath();
  ctx.arc(x, y, 6, Math.PI * 0.6, Math.PI * 2.2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawEdgeLabel(
  ctx: CanvasRenderingContext2D,
  theme: CanvasTheme,
  edge: LayoutEdge,
  state: RenderState,
): void {
  const label = edge.label;
  if (!label) return;
  const isHovered = state.hoveredEdgeId === edge.id;
  const isActive = state.activeIds.has(edge.sourceId);

  ctx.globalAlpha = 0.92;
  ctx.fillStyle = theme.background;
  roundedRect(ctx, label.x - 3, label.y - 1, label.width + 6, label.height + 2, 3);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.font = FONT_LABEL;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = isHovered || isActive ? theme.primary : theme.mutedForeground;
  ctx.fillText(label.text, label.x, label.y + label.height / 2);
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

  const viewport = inflate(visibleWorldRect(camera, width, height), CULL_MARGIN / scale);
  const stats: DrawStats = { nodes: 0, edges: 0 };

  // Edges under nodes, so boxes stay readable where routes pass behind them.
  const visibleEdges: LayoutEdge[] = [];
  for (const edge of scene.edges) {
    if (edge.isSelf || edge.points.length < 2) continue;
    if (!rectsIntersect(viewport, edgeBounds(edge))) continue;
    visibleEdges.push(edge);
    drawEdge(ctx, theme, edge, state, scale);
    stats.edges++;
  }

  for (const node of scene.nodes) {
    if (!rectsIntersect(viewport, node)) continue;
    drawNode(ctx, theme, node, state, scale);
    stats.nodes++;
  }

  for (const edge of scene.edges) {
    if (!edge.isSelf) continue;
    const node = scene.nodeById.get(edge.sourceId);
    if (!node || !rectsIntersect(viewport, node)) continue;
    drawSelfLoop(ctx, theme, node, state.activeIds.has(node.id), scale);
  }

  if (scale >= LOD_DETAIL) {
    for (const edge of visibleEdges) drawEdgeLabel(ctx, theme, edge, state);
  }

  ctx.restore();
  return stats;
}
