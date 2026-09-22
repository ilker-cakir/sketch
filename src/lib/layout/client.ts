import type { ElkNode } from 'elkjs/lib/elk-api';
import type { MachineGraph } from '@/lib/machine';
import { createCanvasMeasureText, type MeasureText } from './measure';
import { toElk, type ToElkOptions } from './to-elk';
import { fromElk } from './from-elk';
import type { LayoutGraph } from './types';
import { hashGraph, readPersistedLayout, writePersistedLayout } from './cache';
import { collapseGraph } from './collapse';
import ElkApi from 'elkjs/lib/elk-api.js';
// Emitted as a standalone asset; fetched only when the worker starts.
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import { resolveElk, type ElkInstance } from './elk-interop';

/**
 * Computes machine layout, off the main thread when possible.
 *
 * Layout costs a few hundred milliseconds on a large machine and depends only
 * on the machine *definition*, never on a snapshot — so results are cached by
 * key and a request for a key already in flight joins the existing promise.
 */

/**
 * ELK runs in elkjs's own worker rather than one of ours.
 *
 * A hand-rolled worker that imports `elk.bundled.js` cannot be made to work
 * here: the bundle does `require('./elk-api.js')["default"]` internally, and
 * under every bundler and worker setting tried that interop broke inside a
 * worker chunk — the constructor threw at module scope, the worker died before
 * it could report anything, and layout silently ran on the main thread while
 * still downloading a second copy of ELK. `elk-api` with `workerUrl` is the
 * mode elkjs ships for browsers: it loads `elk-worker.min.js` as a plain
 * script, which sidesteps module interop entirely.
 */
let elkInstance: ElkInstance | null = null;
let elkBroken = false;

function getElk(): ElkInstance | null {
  if (elkBroken) return null;
  if (elkInstance) return elkInstance;
  try {
    const ELK = resolveElk(ElkApi);
    elkInstance = new ELK({
      workerUrl: elkWorkerUrl,
      workerFactory: (url) => new Worker(url),
    });
    return elkInstance;
  } catch {
    elkBroken = true;
    return null;
  }
}

/** Runs ELK in-process. Used when the worker cannot be created. */
async function layoutOnMainThread(root: ElkNode): Promise<ElkNode> {
  const imported = await import('elkjs/lib/elk.bundled.js');
  const ELK = resolveElk(imported);
  return new ELK().layout(root);
}

function runElk(root: ElkNode): Promise<ElkNode> {
  const elk = getElk();
  if (!elk) return layoutOnMainThread(root);
  return elk.layout(root).catch(() => {
    // A worker that fails mid-flight must not lose the caller's result.
    elkBroken = true;
    elkInstance = null;
    return layoutOnMainThread(root);
  });
}

const cache = new Map<string, LayoutGraph>();
const inflight = new Map<string, Promise<LayoutGraph>>();

export interface LayoutOptions extends ToElkOptions {
  measureText?: MeasureText;
  /** Containers to draw closed, with their insides left out of layout. */
  collapsed?: ReadonlySet<string>;
}

let defaultMeasureText: MeasureText | null = null;
function getMeasureText(): MeasureText {
  defaultMeasureText ??= createCanvasMeasureText();
  return defaultMeasureText;
}

/**
 * Lays out `graph`, reusing any result already computed for the same content.
 *
 * The cache is keyed on a digest of the definition rather than on the caller,
 * because layout is a pure function of the definition and costs about a second
 * on a large machine. Two actors running the same machine, an actor that
 * reconnects with a new session id, and a page reload therefore all reuse one
 * layout: in memory first, then from IndexedDB.
 */
export function layoutMachine(
  graph: MachineGraph,
  options: LayoutOptions = {},
): Promise<LayoutGraph> {
  const { measureText = getMeasureText(), collapsed, ...elkOptions } = options;
  // Collapsing changes the graph, so it has to be part of the cache identity.
  const collapsedKey = collapsed && collapsed.size > 0 ? [...collapsed].sort().join(',') : '';
  const key = hashGraph(graph, `${JSON.stringify(elkOptions)}|${collapsedKey}`);

  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = readPersistedLayout(key)
    .then((persisted) => {
      if (persisted) return persisted;

      const folded = collapseGraph(graph, collapsed ?? new Set());
      const built = toElk(folded.graph, measureText, {
        ...elkOptions,
        collapsed,
        hiddenCountById: folded.hiddenCountById,
        mergedCountById: folded.mergedCountById,
      });
      return runElk(built.root)
        .then((result) =>
          fromElk(result, folded.graph, {
            selfEdgeIds: built.selfEdgeIds,
            droppedEdgeCount: built.droppedEdgeCount,
            edgeOriginById: built.edgeOriginById,
            collapsed,
            hiddenCountById: folded.hiddenCountById,
            mergedCountById: folded.mergedCountById,
          }),
        )
        .then((laidOut) => {
          // Fire and forget: a failed write costs a recompute, nothing more.
          void writePersistedLayout(key, laidOut);
          return laidOut;
        });
    })
    .then((laidOut) => {
      cache.set(key, laidOut);
      return laidOut;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

/** Drops an in-memory cached layout. */
export function invalidateLayout(key: string): void {
  cache.delete(key);
}

/** Test seam: resets module state between cases. */
export function resetLayoutClient(): void {
  cache.clear();
  inflight.clear();
  elkInstance = null;
  elkBroken = false;
}
