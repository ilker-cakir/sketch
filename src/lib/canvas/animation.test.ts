import { describe, expect, it } from 'vitest';
import { getAfterDelayMs } from '@/lib/machine';
import {
  ACTIVATION_MS,
  clamp01,
  createActivationTracker,
  easeInOutCubic,
  easeOutCubic,
  timerProgress,
  tweenCamera,
} from './animation';
import type { Camera } from './camera';

describe('easing', () => {
  it('clamps outside the unit interval', () => {
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(5)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);
  });

  it.each([easeOutCubic, easeInOutCubic])('pins both ends', (ease) => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
  });

  it('is monotonic and stays within bounds', () => {
    let previous = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = easeOutCubic(t);
      expect(v).toBeGreaterThanOrEqual(previous);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      previous = v;
    }
  });

  it('decelerates: ease-out is ahead of linear in the first half', () => {
    expect(easeOutCubic(0.25)).toBeGreaterThan(0.25);
  });
});

describe('activation tracker', () => {
  it('shows the first active set fully on, with no fade-in', () => {
    // We join a machine mid-run; its current state was not a transition we saw.
    const t = createActivationTracker();
    t.setActive(new Set(['a']), 1000);
    expect(t.amount('a', 1000)).toBe(1);
    expect(t.isAnimating(1000)).toBe(false);
  });

  it('fades a newly activated node in over the duration', () => {
    const t = createActivationTracker();
    t.setActive(new Set(['a']), 0);
    t.setActive(new Set(['a', 'b']), 1000);

    expect(t.amount('b', 1000)).toBe(0);
    const mid = t.amount('b', 1000 + ACTIVATION_MS / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(t.amount('b', 1000 + ACTIVATION_MS)).toBe(1);
  });

  it('fades a deactivated node out', () => {
    const t = createActivationTracker();
    t.setActive(new Set(['a']), 0);
    t.setActive(new Set(), 1000);

    expect(t.amount('a', 1000)).toBe(1);
    expect(t.amount('a', 1000 + ACTIVATION_MS / 2)).toBeLessThan(1);
    expect(t.amount('a', 1000 + ACTIVATION_MS)).toBe(0);
  });

  it('reverses cleanly from wherever the fade had got to', () => {
    const t = createActivationTracker();
    t.setActive(new Set(['a']), 0);
    t.setActive(new Set(), 1000);

    const half = 1000 + ACTIVATION_MS / 2;
    const atReversal = t.amount('a', half);
    t.setActive(new Set(['a']), half);

    // No snap: it resumes from the value it had, then climbs back to 1.
    expect(t.amount('a', half)).toBeCloseTo(atReversal, 5);
    expect(t.amount('a', half + ACTIVATION_MS)).toBe(1);
  });

  it('reports animating only while a fade is in flight', () => {
    const t = createActivationTracker();
    t.setActive(new Set(['a']), 0);
    t.setActive(new Set(['a', 'b']), 1000);

    expect(t.isAnimating(1000 + ACTIVATION_MS - 1)).toBe(true);
    expect(t.isAnimating(1000 + ACTIVATION_MS)).toBe(false);
  });

  it('is zero for a node it has never seen', () => {
    const t = createActivationTracker();
    t.setActive(new Set(['a']), 0);
    expect(t.amount('unknown', 0)).toBe(0);
  });

  it('forgets nodes once they have finished fading out', () => {
    const t = createActivationTracker();
    t.setActive(new Set(['a']), 0);
    t.setActive(new Set(), 1000);
    // A later update past the fade prunes the settled entry.
    t.setActive(new Set(), 1000 + ACTIVATION_MS);
    expect(t.amount('a', 2000)).toBe(0);
    expect(t.activeSince('a')).toBe(null);
  });

  describe('activeSince', () => {
    it('reports when a node was observed becoming active', () => {
      const t = createActivationTracker();
      t.setActive(new Set(['a']), 0);
      t.setActive(new Set(['a', 'b']), 700);
      expect(t.activeSince('b')).toBe(700);
    });

    it('does not restart while a node stays active', () => {
      const t = createActivationTracker();
      t.setActive(new Set(['a']), 0);
      t.setActive(new Set(['a']), 500);
      t.setActive(new Set(['a']), 900);
      expect(t.activeSince('a')).toBe(0);
    });

    it('is null for an inactive or unknown node', () => {
      const t = createActivationTracker();
      t.setActive(new Set(['a']), 0);
      t.setActive(new Set(), 100);
      expect(t.activeSince('a')).toBe(null);
      expect(t.activeSince('nope')).toBe(null);
    });
  });

  describe('recentlyActivated', () => {
    it('reports what just turned on, not everything that is on', () => {
      // A parallel machine always has states active across the whole graph;
      // only the ones that just changed are somewhere worth looking.
      const t = createActivationTracker();
      t.setActive(new Set(['a', 'b']), 0);
      t.setActive(new Set(['a', 'b', 'c']), 1000);
      expect(t.recentlyActivated(1000, 600)).toEqual(['c']);
    });

    it('forgets a state once the window has passed', () => {
      const t = createActivationTracker();
      t.setActive(new Set(['a']), 0);
      t.setActive(new Set(['a', 'b']), 1000);
      expect(t.recentlyActivated(1599, 600)).toEqual(['b']);
      expect(t.recentlyActivated(1601, 600)).toEqual([]);
    });

    it('ignores the set we joined mid-run', () => {
      // Those states did not transition where we could see it, so jumping to
      // them on connect would be arbitrary.
      const t = createActivationTracker();
      t.setActive(new Set(['a', 'b']), 0);
      expect(t.recentlyActivated(0, 600)).toEqual([]);
    });

    it('ignores states on their way out', () => {
      const t = createActivationTracker();
      t.setActive(new Set(['a']), 0);
      t.setActive(new Set(['a', 'b']), 500);
      t.setActive(new Set(['a']), 600);
      expect(t.recentlyActivated(600, 600)).toEqual([]);
    });

    it('reports several states entered together', () => {
      const t = createActivationTracker();
      t.setActive(new Set(['a']), 0);
      t.setActive(new Set(['a', 'b', 'c']), 1000);
      expect(t.recentlyActivated(1000, 600).sort()).toEqual(['b', 'c']);
    });
  });

  it('clears on reset', () => {
    const t = createActivationTracker();
    t.setActive(new Set(['a']), 0);
    t.reset();
    // After a reset the next set is a fresh join: on, not fading.
    t.setActive(new Set(['a']), 50);
    expect(t.amount('a', 50)).toBe(1);
  });
});

describe('timerProgress', () => {
  it('runs from 0 to 1 across the delay', () => {
    expect(timerProgress(1000, 500, 500)).toBe(0);
    expect(timerProgress(1000, 500, 1000)).toBeCloseTo(0.5);
    expect(timerProgress(1000, 500, 1500)).toBe(1);
  });

  it('clamps once the delay has elapsed', () => {
    expect(timerProgress(1000, 0, 99999)).toBe(1);
  });

  it('draws nothing without a resolvable delay', () => {
    expect(timerProgress(null, 0, 10)).toBe(null);
    expect(timerProgress(0, 0, 10)).toBe(null);
  });

  it('draws nothing for a state that was already active when we connected', () => {
    // No observed start means no honest progress to show.
    expect(timerProgress(1000, null, 10)).toBe(null);
  });
});

describe('getAfterDelayMs', () => {
  it.each([
    ['xstate.after(5000).trafficLight.green', 5000],
    ['xstate.after.3000.trafficLight.red.waiting', 3000],
  ])('parses %s', (eventType, expected) => {
    expect(getAfterDelayMs(eventType)).toBe(expected);
  });

  it.each([
    ['xstate.after(TIMEOUT).some.state'],
    ['xstate.after.TIMEOUT.some.state'],
    ['NEXT'],
    [''],
  ])('returns null for %s', (eventType) => {
    expect(getAfterDelayMs(eventType)).toBe(null);
  });
});

describe('tweenCamera', () => {
  const from: Camera = { x: 0, y: 0, scale: 0.1 };
  const to: Camera = { x: 500, y: 200, scale: 1 };
  const tween = { from, to, startedAt: 0, durationMs: 250 };

  it('starts at the source camera', () => {
    const { camera, done } = tweenCamera(tween, 0);
    expect(done).toBe(false);
    expect(camera.x).toBeCloseTo(0);
    expect(camera.scale).toBeCloseTo(0.1);
  });

  it('lands exactly on the target', () => {
    const { camera, done } = tweenCamera(tween, 250);
    expect(done).toBe(true);
    expect(camera).toEqual(to);
  });

  it('interpolates scale geometrically, not linearly', () => {
    // Linear would sit near 0.55 at the midpoint, which reads as a jump then
    // a crawl. Geometric gives the perceptually even sqrt(0.1 * 1) ≈ 0.316.
    const { camera } = tweenCamera(tween, 125);
    expect(camera.scale).toBeCloseTo(Math.sqrt(0.1), 2);
  });

  it('stays done past the end', () => {
    expect(tweenCamera(tween, 10_000).done).toBe(true);
  });
});
