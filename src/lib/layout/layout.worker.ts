/// <reference lib="webworker" />
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';

/**
 * Runs ELK off the main thread. Only the layout call lives here — measurement
 * needs canvas text metrics, so `toElk` stays on the main thread and this
 * worker exchanges plain ELK JSON.
 *
 * `elk.bundled.js` inlines the algorithm, so `new ELK()` computes in this
 * worker rather than spawning another one.
 */

export interface LayoutWorkerRequest {
  id: number;
  root: ElkNode;
}

export type LayoutWorkerResponse =
  | { id: number; ok: true; result: ElkNode }
  | { id: number; ok: false; error: string };

const elk = new ELK();

self.addEventListener('message', (event: MessageEvent<LayoutWorkerRequest>) => {
  const { id, root } = event.data;
  elk
    .layout(root)
    .then((result) => {
      const response: LayoutWorkerResponse = { id, ok: true, result };
      (self as DedicatedWorkerGlobalScope).postMessage(response);
    })
    .catch((error: unknown) => {
      const response: LayoutWorkerResponse = {
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      (self as DedicatedWorkerGlobalScope).postMessage(response);
    });
});
