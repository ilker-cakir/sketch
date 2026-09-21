import type { LayoutEdge, Point } from '@/lib/layout/types';
import {
  fitToBounds,
  pan,
  screenToWorld,
  zoomBy as zoomCameraBy,
  type Camera,
} from './camera';
import { draw, emptyRenderState, type RenderState } from './renderer';
import { hitTestEdge, hitTestNode, type Scene, type SceneNode } from './scene';
import { readCanvasTheme, type CanvasTheme } from './theme';

export interface GraphControllerCallbacks {
  onHoverChange?: (hover: { node: SceneNode | null; edge: LayoutEdge | null }) => void;
  onSelect?: (node: SceneNode | null) => void;
}

export interface GraphController {
  setScene(scene: Scene | null): void;
  setActiveIds(ids: ReadonlySet<string>): void;
  setSelected(nodeId: string | null): void;
  /** Re-reads theme tokens, e.g. after a dark-mode toggle. */
  refreshTheme(): void;
  fit(): void;
  zoomBy(factor: number): void;
  centerOn(nodeId: string): void;
  destroy(): void;
}

/** Pointer movement beyond this many pixels is a pan, not a click. */
const DRAG_THRESHOLD = 4;
/** Hit tolerance for edges, in screen pixels. */
const EDGE_TOLERANCE = 6;

/**
 * Owns the canvas: camera, input, theme and the render loop.
 *
 * All updates mark the canvas dirty and coalesce into a single
 * `requestAnimationFrame` draw, so a burst of snapshots arriving in one frame
 * costs one repaint rather than one each.
 */
export function createGraphController(
  canvas: HTMLCanvasElement,
  callbacks: GraphControllerCallbacks = {},
): GraphController {
  const context2d = canvas.getContext('2d');
  if (!context2d) throw new Error('2D canvas context unavailable');
  const ctx: CanvasRenderingContext2D = context2d;

  let scene: Scene | null = null;
  let camera: Camera = { x: 0, y: 0, scale: 1 };
  let theme: CanvasTheme = readCanvasTheme(canvas);
  let state: RenderState = emptyRenderState;
  let width = 0;
  let height = 0;
  let frame = 0;
  let destroyed = false;
  /** Set once per scene, so a newly loaded graph starts framed. */
  let needsInitialFit = false;

  function markDirty(): void {
    if (destroyed || frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }

  function render(): void {
    if (!scene || width === 0 || height === 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (needsInitialFit) {
      needsInitialFit = false;
      camera = fitToBounds(scene.bounds, width, height);
    }
    draw({
      ctx,
      scene,
      camera,
      theme,
      state,
      width,
      height,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    width = rect.width;
    height = rect.height;
    const nextWidth = Math.max(1, Math.round(width * dpr));
    const nextHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
    markDirty();
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  // ---- input -------------------------------------------------------------

  const pointerPosition = (event: PointerEvent | MouseEvent): Point => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  let dragging = false;
  let dragMoved = false;
  let lastPointer: Point = { x: 0, y: 0 };
  let activePointerId: number | null = null;

  function updateHover(screen: Point): void {
    if (!scene) return;
    const world = screenToWorld(camera, screen);
    const node = hitTestNode(scene, world);
    // An edge only wins when the pointer is not over a node box.
    const edge = node ? null : hitTestEdge(scene, world, EDGE_TOLERANCE / camera.scale);

    const nodeId = node?.id ?? null;
    const edgeId = edge?.id ?? null;
    if (nodeId === state.hoveredNodeId && edgeId === state.hoveredEdgeId) return;

    state = { ...state, hoveredNodeId: nodeId, hoveredEdgeId: edgeId };
    canvas.style.cursor = node || edge ? 'pointer' : 'grab';
    callbacks.onHoverChange?.({ node, edge });
    markDirty();
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    dragging = true;
    dragMoved = false;
    activePointerId = event.pointerId;
    lastPointer = pointerPosition(event);
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  }

  function onPointerMove(event: PointerEvent): void {
    const position = pointerPosition(event);
    if (!dragging) {
      updateHover(position);
      return;
    }
    const dx = position.x - lastPointer.x;
    const dy = position.y - lastPointer.y;
    if (!dragMoved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragMoved = true;
    lastPointer = position;
    camera = pan(camera, dx, dy);
    markDirty();
  }

  function onPointerUp(event: PointerEvent): void {
    if (activePointerId !== null && canvas.hasPointerCapture(activePointerId)) {
      canvas.releasePointerCapture(activePointerId);
    }
    activePointerId = null;
    const wasDrag = dragMoved;
    dragging = false;
    dragMoved = false;
    canvas.style.cursor = 'grab';

    if (wasDrag || !scene) return;
    const world = screenToWorld(camera, pointerPosition(event));
    const node = hitTestNode(scene, world);
    state = { ...state, selectedNodeId: node?.id ?? null };
    callbacks.onSelect?.(node);
    markDirty();
  }

  function onPointerLeave(): void {
    if (state.hoveredNodeId === null && state.hoveredEdgeId === null) return;
    state = { ...state, hoveredNodeId: null, hoveredEdgeId: null };
    callbacks.onHoverChange?.({ node: null, edge: null });
    markDirty();
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    // Pinch-zoom arrives as a wheel event with ctrlKey set; plain wheel pans.
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY / 200);
      camera = zoomCameraBy(camera, factor, pointerPosition(event));
    } else {
      camera = pan(camera, -event.deltaX, -event.deltaY);
    }
    markDirty();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'none';

  // ---- public API --------------------------------------------------------

  return {
    setScene(next) {
      scene = next;
      needsInitialFit = next !== null;
      state = { ...state, hoveredNodeId: null, hoveredEdgeId: null, selectedNodeId: null };
      markDirty();
    },
    setActiveIds(ids) {
      state = { ...state, activeIds: ids };
      markDirty();
    },
    setSelected(nodeId) {
      if (state.selectedNodeId === nodeId) return;
      state = { ...state, selectedNodeId: nodeId };
      markDirty();
    },
    refreshTheme() {
      theme = readCanvasTheme(canvas);
      markDirty();
    },
    fit() {
      if (!scene) return;
      camera = fitToBounds(scene.bounds, width, height);
      markDirty();
    },
    zoomBy(factor) {
      camera = zoomCameraBy(camera, factor, { x: width / 2, y: height / 2 });
      markDirty();
    },
    centerOn(nodeId) {
      const node = scene?.nodeById.get(nodeId);
      if (!node) return;
      camera = {
        ...camera,
        x: node.x + node.width / 2 - width / 2 / camera.scale,
        y: node.y + node.height / 2 - height / 2 / camera.scale,
      };
      markDirty();
    },
    destroy() {
      destroyed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
