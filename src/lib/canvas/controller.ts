import type { LayoutEdge, Point } from '@/lib/layout/types';
import {
  fitToBounds,
  pan,
  screenToWorld,
  zoomBy as zoomCameraBy,
  type Camera,
} from './camera';
import { draw, emptyRenderState, LOD_DETAIL, type RenderState } from './renderer';
import {
  CAMERA_MS,
  createActivationTracker,
  timerProgress,
  tweenCamera,
  type CameraTween,
} from './animation';
import { followCamera, unionRect } from './follow';
import { hitTestEdge, hitTestNode, type Scene, type SceneNode } from './scene';
import { readCanvasTheme, type CanvasTheme } from './theme';

export interface GraphControllerCallbacks {
  onHoverChange?: (hover: { node: SceneNode | null; edge: LayoutEdge | null }) => void;
  onSelect?: (node: SceneNode | null) => void;
  /** Fires when following turns itself off because the user took the camera. */
  onFollowChange?: (following: boolean) => void;
}

export interface GraphController {
  setScene(scene: Scene | null): void;
  setActiveIds(ids: ReadonlySet<string>): void;
  setSelected(nodeId: string | null): void;
  /** Re-reads theme tokens, e.g. after a dark-mode toggle. */
  refreshTheme(): void;
  /** Whether the camera chases states as they become active. */
  setFollow(following: boolean): void;
  fit(): void;
  zoomBy(factor: number): void;
  centerOn(nodeId: string): void;
  destroy(): void;
}

/** Pointer movement beyond this many pixels is a pan, not a click. */
const DRAG_THRESHOLD = 4;
/**
 * How recently a state must have become active for the camera to chase it.
 *
 * Long enough to cover a burst of snapshots arriving together, short enough
 * that the camera does not chase something that happened a moment ago.
 */
const FOLLOW_WINDOW_MS = 600;
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

  const activation = createActivationTracker();
  let cameraTween: CameraTween | null = null;
  let following = false;

  /** Stops chasing, because the user has taken the camera. */
  function releaseFollow(): void {
    if (!following) return;
    following = false;
    callbacks.onFollowChange?.(false);
  }

  /**
   * Moves the camera to whatever just became active, if it is off screen.
   *
   * Prefers the leaf states: when a child activates so does its container, and
   * jumping to the container would frame a region rather than the state.
   */
  function followRecentlyActive(now: number): void {
    if (!following || !scene || width === 0 || height === 0) return;

    const recent = activation.recentlyActivated(now, FOLLOW_WINDOW_MS);
    if (recent.length === 0) return;

    const nodes = recent
      .map((id) => scene?.nodeById.get(id))
      .filter((n): n is SceneNode => n !== undefined);
    const leaves = nodes.filter((n) => !n.isContainer);
    const target = unionRect(leaves.length > 0 ? leaves : nodes);

    const next = followCamera(target, camera, width, height);
    if (next) startTween(next);
  }

  /** Live `after` timers for currently active sources, keyed by edge id. */
  function edgeTimerProgress(edgeId: string, now: number): number | null {
    const delay = scene?.edgeDelayMs.get(edgeId);
    const edge = scene?.edgeById.get(edgeId);
    if (delay === undefined || !edge) return null;
    return timerProgress(delay, activation.activeSince(edge.sourceId), now);
  }

  /**
   * True while any `after` timer on an active state is still counting down.
   *
   * Gated on zoom: timer bars are only drawn at detail zoom, so below it
   * there is nothing to animate and the render loop must be allowed to idle
   * rather than burning frames on invisible progress.
   *
   * Runs every frame, so it stays linear in the number of timed edges.
   */
  function hasRunningTimer(now: number): boolean {
    if (!scene || camera.scale < LOD_DETAIL) return false;
    for (const [edgeId, delay] of scene.edgeDelayMs) {
      const edge = scene.edgeById.get(edgeId);
      if (!edge) continue;
      const since = activation.activeSince(edge.sourceId);
      if (since !== null && now - since < delay) return true;
    }
    return false;
  }

  function markDirty(): void {
    if (destroyed || frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
      // Keep the loop awake only while something is actually moving; when
      // nothing is, the canvas goes back to redrawing on input alone.
      const now = performance.now();
      if (
        cameraTween !== null ||
        activation.isAnimating(now) ||
        hasRunningTimer(now)
      ) {
        markDirty();
      }
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
      cameraTween = null;
      camera = fitToBounds(scene.bounds, width, height);
    }

    const now = performance.now();
    if (cameraTween) {
      const stepped = tweenCamera(cameraTween, now);
      camera = stepped.camera;
      if (stepped.done) cameraTween = null;
    }

    draw({
      ctx,
      scene,
      camera,
      theme,
      state: {
        ...state,
        activation: (nodeId) => activation.amount(nodeId, now),
        timerProgress: (edgeId) => edgeTimerProgress(edgeId, now),
      },
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
    cameraTween = null;
    releaseFollow();
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
    cameraTween = null;
    releaseFollow();
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

  /** Eases to `to` rather than jumping, so the viewport stays followable. */
  function startTween(to: Camera): void {
    cameraTween = {
      from: camera,
      to,
      startedAt: performance.now(),
      durationMs: CAMERA_MS,
    };
    markDirty();
  }

  // ---- public API --------------------------------------------------------

  return {
    setScene(next) {
      scene = next;
      activation.reset();
      cameraTween = null;
      needsInitialFit = next !== null;
      state = { ...state, hoveredNodeId: null, hoveredEdgeId: null, selectedNodeId: null };
      markDirty();
    },
    setActiveIds(ids) {
      const now = performance.now();
      state = { ...state, activeIds: ids };
      activation.setActive(ids, now);
      followRecentlyActive(now);
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
    setFollow(next) {
      following = next;
      if (next) followRecentlyActive(performance.now());
    },
    fit() {
      if (!scene) return;
      releaseFollow();
      startTween(fitToBounds(scene.bounds, width, height));
    },
    zoomBy(factor) {
      releaseFollow();
      startTween(zoomCameraBy(camera, factor, { x: width / 2, y: height / 2 }));
    },
    centerOn(nodeId) {
      const node = scene?.nodeById.get(nodeId);
      if (!node) return;
      releaseFollow();
      // Jumping to a node from a fit-out view would centre something too small
      // to read, so zoom in far enough for its detail to be drawn.
      const scale = Math.max(camera.scale, LOD_DETAIL);
      startTween({
        scale,
        x: node.x + node.width / 2 - width / 2 / scale,
        y: node.y + node.height / 2 - height / 2 / scale,
      });
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
