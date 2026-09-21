import type { ElkNode } from 'elkjs/lib/elk-api';
import type { MachineGraph } from '@/lib/machine';
import { createCanvasMeasureText, type MeasureText } from './measure';
import { toElk, type ToElkOptions } from './to-elk';
import { fromElk } from './from-elk';
import type { LayoutGraph } from './types';
import type { LayoutWorkerRequest, LayoutWorkerResponse } from './layout.worker';

/**
 * Computes machine layout, off the main thread when possible.
 *
 * Layout costs a few hundred milliseconds on a large machine and depends only
 * on the machine *definition*, never on a snapshot — so results are cached by
 * key and a request for a key already in flight joins the existing promise.
 */

type Pending = {
  resolve: (result: ElkNode) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let workerBroken = false;
let nextRequestId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./layout.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener('message', (event: MessageEvent<LayoutWorkerResponse>) => {
      const message = event.data;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error));
    });
    worker.addEventListener('error', () => {
      // Fail every in-flight request; subsequent ones fall back to main thread.
      failWorker(new Error('Layout worker crashed'));
    });
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

function failWorker(error: Error): void {
  workerBroken = true;
  worker?.terminate();
  worker = null;
  for (const [, entry] of pending) entry.reject(error);
  pending.clear();
}

/** Runs ELK in-process. Used when no worker is available. */
async function layoutOnMainThread(root: ElkNode): Promise<ElkNode> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  return new ELK().layout(root);
}

function runElk(root: ElkNode): Promise<ElkNode> {
  const activeWorker = getWorker();
  if (!activeWorker) return layoutOnMainThread(root);

  const id = nextRequestId++;
  return new Promise<ElkNode>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: LayoutWorkerRequest = { id, root };
    activeWorker.postMessage(request);
  }).catch((error: Error) => {
    // A broken worker should not lose the result the caller asked for.
    if (workerBroken) return layoutOnMainThread(root);
    throw error;
  });
}

const cache = new Map<string, LayoutGraph>();
const inflight = new Map<string, Promise<LayoutGraph>>();

export interface LayoutOptions extends ToElkOptions {
  measureText?: MeasureText;
}

let defaultMeasureText: MeasureText | null = null;
function getMeasureText(): MeasureText {
  defaultMeasureText ??= createCanvasMeasureText();
  return defaultMeasureText;
}

/**
 * Lays out `graph`, reusing a cached result for the same `key`.
 *
 * `key` should identify the machine *definition* — an actor's session id is a
 * good choice, since its definition never changes over that actor's life.
 */
export function layoutMachine(
  key: string,
  graph: MachineGraph,
  options: LayoutOptions = {},
): Promise<LayoutGraph> {
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);

  const existing = inflight.get(key);
  if (existing) return existing;

  const { measureText = getMeasureText(), ...elkOptions } = options;
  const built = toElk(graph, measureText, elkOptions);

  const promise = runElk(built.root)
    .then((result) =>
      fromElk(result, graph, {
        selfEdgeIds: built.selfEdgeIds,
        droppedEdgeCount: built.droppedEdgeCount,
        edgeOriginById: built.edgeOriginById,
      }),
    )
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

/** Drops a cached layout, e.g. when an actor's definition is replaced. */
export function invalidateLayout(key: string): void {
  cache.delete(key);
}

/** Test seam: resets module state between cases. */
export function resetLayoutClient(): void {
  cache.clear();
  inflight.clear();
  failWorker(new Error('reset'));
  workerBroken = false;
}
