import type { Point, Rect } from '@/lib/layout/types';

/**
 * A pan/zoom camera mapping world (layout) coordinates to screen pixels.
 *
 * `screen = (world - {x, y}) * scale`
 */
export interface Camera {
  /** World coordinate displayed at the viewport's top-left corner. */
  x: number;
  y: number;
  scale: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 3;

export const clampScale = (scale: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

export function worldToScreen(camera: Camera, p: Point): Point {
  return {
    x: (p.x - camera.x) * camera.scale,
    y: (p.y - camera.y) * camera.scale,
  };
}

export function screenToWorld(camera: Camera, p: Point): Point {
  return {
    x: p.x / camera.scale + camera.x,
    y: p.y / camera.scale + camera.y,
  };
}

/** Pans by a screen-space delta, e.g. a drag. */
export function pan(camera: Camera, dxScreen: number, dyScreen: number): Camera {
  return {
    ...camera,
    x: camera.x - dxScreen / camera.scale,
    y: camera.y - dyScreen / camera.scale,
  };
}

/**
 * Zooms to `scale` while keeping the world point currently under `anchor`
 * (a screen position) pinned there.
 */
export function zoomAt(camera: Camera, scale: number, anchor: Point): Camera {
  const next = clampScale(scale);
  const world = screenToWorld(camera, anchor);
  return {
    scale: next,
    x: world.x - anchor.x / next,
    y: world.y - anchor.y / next,
  };
}

/** Multiplies the current zoom, pinning `anchor`. */
export function zoomBy(camera: Camera, factor: number, anchor: Point): Camera {
  return zoomAt(camera, camera.scale * factor, anchor);
}

/**
 * A camera that fits `bounds` within a viewport of `width` × `height`,
 * centred, with `padding` screen pixels of margin.
 */
export function fitToBounds(
  bounds: Rect,
  width: number,
  height: number,
  padding = 32,
): Camera {
  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);
  const scale = clampScale(
    bounds.width > 0 && bounds.height > 0
      ? Math.min(usableWidth / bounds.width, usableHeight / bounds.height)
      : 1,
  );

  // Centre the scaled bounds inside the viewport.
  const offsetX = (width - bounds.width * scale) / 2;
  const offsetY = (height - bounds.height * scale) / 2;

  return {
    scale,
    x: bounds.x - offsetX / scale,
    y: bounds.y - offsetY / scale,
  };
}

/** The world-space rectangle currently visible in a `width` × `height` viewport. */
export function visibleWorldRect(
  camera: Camera,
  width: number,
  height: number,
): Rect {
  return {
    x: camera.x,
    y: camera.y,
    width: width / camera.scale,
    height: height / camera.scale,
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
