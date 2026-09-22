import { describe, expect, it } from 'vitest';
import { followCamera, unionRect } from './follow';
import { visibleWorldRect, type Camera } from './camera';
import type { Rect } from '@/lib/layout/types';

const WIDTH = 800;
const HEIGHT = 600;
const camera: Camera = { x: 0, y: 0, scale: 1 };

describe('unionRect', () => {
  it('is null for nothing', () => {
    expect(unionRect([])).toBeNull();
  });

  it('returns the one rect it is given', () => {
    const r: Rect = { x: 5, y: 6, width: 7, height: 8 };
    expect(unionRect([r])).toEqual(r);
  });

  it('spans every rect', () => {
    expect(
      unionRect([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 90, y: 40, width: 10, height: 10 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });
});

describe('followCamera', () => {
  it('stays put with no target', () => {
    expect(followCamera(null, camera, WIDTH, HEIGHT)).toBeNull();
  });

  it('stays put while the target is comfortably on screen', () => {
    // Re-centring every snapshot would make the view crawl during a burst.
    const target: Rect = { x: 350, y: 250, width: 100, height: 100 };
    expect(followCamera(target, camera, WIDTH, HEIGHT)).toBeNull();
  });

  it('moves when the target is beyond the viewport', () => {
    const target: Rect = { x: 5000, y: 4000, width: 100, height: 100 };
    const next = followCamera(target, camera, WIDTH, HEIGHT)!;
    expect(next).not.toBeNull();
    const view = visibleWorldRect(next, WIDTH, HEIGHT);
    expect(view.x).toBeLessThan(target.x);
    expect(view.x + view.width).toBeGreaterThan(target.x + target.width);
  });

  it('centres the target it moves to', () => {
    const target: Rect = { x: 5000, y: 4000, width: 100, height: 100 };
    const next = followCamera(target, camera, WIDTH, HEIGHT)!;
    const view = visibleWorldRect(next, WIDTH, HEIGHT);
    expect(view.x + view.width / 2).toBeCloseTo(5050);
    expect(view.y + view.height / 2).toBeCloseTo(4050);
  });

  it('never zooms in on a small target', () => {
    // A single state becoming active must not fill the screen.
    const target: Rect = { x: 9000, y: 9000, width: 20, height: 20 };
    const next = followCamera(target, camera, WIDTH, HEIGHT)!;
    expect(next.scale).toBeLessThanOrEqual(camera.scale);
  });

  it('zooms out when the target does not fit', () => {
    const zoomed: Camera = { x: 0, y: 0, scale: 2 };
    const target: Rect = { x: 0, y: 0, width: 4000, height: 3000 };
    const next = followCamera(target, zoomed, WIDTH, HEIGHT)!;
    expect(next.scale).toBeLessThan(zoomed.scale);
    const view = visibleWorldRect(next, WIDTH, HEIGHT);
    expect(view.width).toBeGreaterThanOrEqual(target.width - 1);
  });

  it('treats the viewport edge as offscreen', () => {
    // Just inside the frame but within the margin: still worth moving to.
    const view = visibleWorldRect(camera, WIDTH, HEIGHT);
    const atEdge: Rect = { x: view.x + view.width - 20, y: view.y + 10, width: 15, height: 15 };
    expect(followCamera(atEdge, camera, WIDTH, HEIGHT)).not.toBeNull();
  });

  it('stays put for a degenerate viewport', () => {
    const target: Rect = { x: 100, y: 100, width: 10, height: 10 };
    expect(followCamera(target, camera, 0, 0)).toBeNull();
  });
});
