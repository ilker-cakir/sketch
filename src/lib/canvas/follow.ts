import type { Rect } from '@/lib/layout/types';
import { fitToBounds, visibleWorldRect, type Camera } from './camera';

/**
 * Deciding whether the camera should chase the states that just became active.
 *
 * Kept pure so the rules can be tested without a canvas. Two of them matter:
 *
 * - Only *recently* activated states are followed. A parallel machine always
 *   has several states active at once, spread across the whole graph, so
 *   following everything active would just fit the entire diagram and never
 *   move again. Following what changed is what answers "where did it go?".
 * - The camera stays still while the target is already comfortably on screen.
 *   Re-centring on every snapshot would make the view crawl continuously
 *   during a burst of events.
 */

/** Fraction of the viewport treated as edge, where a target counts as offscreen. */
const MARGIN_FRACTION = 0.12;

export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * The camera to move to so `target` is in view, or null to stay put.
 *
 * Never zooms in: a single small state should not fill the screen just because
 * it became active. It zooms out only when the target does not fit.
 */
export function followCamera(
  target: Rect | null,
  camera: Camera,
  width: number,
  height: number,
  marginFraction = MARGIN_FRACTION,
): Camera | null {
  if (!target || width <= 0 || height <= 0) return null;

  const view = visibleWorldRect(camera, width, height);
  const marginX = view.width * marginFraction;
  const marginY = view.height * marginFraction;
  const comfortable: Rect = {
    x: view.x + marginX,
    y: view.y + marginY,
    width: view.width - marginX * 2,
    height: view.height - marginY * 2,
  };
  if (contains(comfortable, target)) return null;

  const fitted = fitToBounds(target, width, height);
  const scale = Math.min(camera.scale, fitted.scale);
  const centerX = target.x + target.width / 2;
  const centerY = target.y + target.height / 2;

  return {
    scale,
    x: centerX - width / 2 / scale,
    y: centerY - height / 2 / scale,
  };
}
