import type { Camera } from './camera';

/**
 * Time-dependent maths for the canvas, kept free of canvas and DOM so it can
 * be tested by passing `now` explicitly.
 *
 * Durations mirror the DOM renderer: state changes there use
 * `transition-[border-color,box-shadow,background-color] duration-150`.
 */

/** How long a node takes to fade between inactive and active. */
export const ACTIVATION_MS = 150;
/** How long the camera takes to tween on fit / zoom. */
export const CAMERA_MS = 250;

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) ** 3;
}

export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

export const lerp = (from: number, to: number, t: number): number =>
  from + (to - from) * t;

interface ActivationEntry {
  /** Where the fade is heading: 1 active, 0 inactive. */
  target: 0 | 1;
  /** Where it started from when the target last changed. */
  from: number;
  changedAt: number;
}

export interface ActivationTracker {
  /** Records a new active set, starting fades for anything that changed. */
  setActive(activeIds: ReadonlySet<string>, now: number): void;
  /** 0–1 fade amount for a node. */
  amount(nodeId: string, now: number): number;
  /** True while any fade is still in flight. */
  isAnimating(now: number): boolean;
  /**
   * When this node was last observed becoming active, or null if it is not
   * active or was never seen to change.
   *
   * Timer progress is measured from here, so a state that was already active
   * before the session connected reports null rather than a made-up start.
   */
  activeSince(nodeId: string): number | null;
  reset(): void;
}

export function createActivationTracker(
  durationMs = ACTIVATION_MS,
): ActivationTracker {
  const entries = new Map<string, ActivationEntry>();
  let seededActive = false;

  const amountAt = (entry: ActivationEntry, now: number): number => {
    const t = easeOutCubic((now - entry.changedAt) / durationMs);
    return lerp(entry.from, entry.target, t);
  };

  return {
    setActive(activeIds, now) {
      for (const id of activeIds) {
        const entry = entries.get(id);
        if (entry?.target === 1) continue;
        entries.set(id, {
          target: 1,
          // The very first active set is the state we joined in the middle
          // of, so it appears already on rather than fading in.
          from: entry ? amountAt(entry, now) : seededActive ? 0 : 1,
          changedAt: now,
        });
      }

      for (const [id, entry] of entries) {
        if (activeIds.has(id) || entry.target === 0) continue;
        entries.set(id, { target: 0, from: amountAt(entry, now), changedAt: now });
      }

      // Drop anything fully faded out, so the map cannot grow without bound.
      for (const [id, entry] of entries) {
        if (entry.target === 0 && now - entry.changedAt >= durationMs) {
          entries.delete(id);
        }
      }

      seededActive = true;
    },

    amount(nodeId, now) {
      const entry = entries.get(nodeId);
      return entry ? amountAt(entry, now) : 0;
    },

    isAnimating(now) {
      for (const [, entry] of entries) {
        // An entry that began at its target is not moving, so it must not
        // keep the render loop awake.
        if (entry.from === entry.target) continue;
        if (now - entry.changedAt < durationMs) return true;
      }
      return false;
    },

    activeSince(nodeId) {
      const entry = entries.get(nodeId);
      return entry && entry.target === 1 ? entry.changedAt : null;
    },

    reset() {
      entries.clear();
      seededActive = false;
    },
  };
}

/**
 * Progress 0–1 of an `after` timer, or null when it cannot be known.
 *
 * Null means "draw no bar": either the delay is a named one we cannot resolve,
 * or the state was already active when we connected so there is no honest
 * start time.
 */
export function timerProgress(
  delayMs: number | null,
  startedAt: number | null,
  now: number,
): number | null {
  if (delayMs === null || startedAt === null || delayMs <= 0) return null;
  return clamp01((now - startedAt) / delayMs);
}

export interface CameraTween {
  from: Camera;
  to: Camera;
  startedAt: number;
  durationMs: number;
}

/**
 * The camera partway through a tween.
 *
 * Scale interpolates geometrically: zooming 0.1 → 1 linearly spends most of
 * the tween near the target, which reads as a jump followed by a crawl.
 */
export function tweenCamera(
  tween: CameraTween,
  now: number,
): { camera: Camera; done: boolean } {
  const raw = (now - tween.startedAt) / tween.durationMs;
  const done = raw >= 1;
  const t = easeInOutCubic(raw);

  return {
    done,
    camera: done
      ? tween.to
      : {
          x: lerp(tween.from.x, tween.to.x, t),
          y: lerp(tween.from.y, tween.to.y, t),
          scale: Math.exp(
            lerp(Math.log(tween.from.scale), Math.log(tween.to.scale), t),
          ),
        },
  };
}
