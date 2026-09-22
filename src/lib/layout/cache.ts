import type { MachineGraph } from '@/lib/machine';
import type { LayoutGraph } from './types';

/**
 * Persistent layout cache, keyed by the content of the machine definition.
 *
 * Layout is the expensive part of the pipeline — around a second on a
 * hundred-state machine, and it grows faster than the machine does — while
 * being a pure function of the definition. Keying on content rather than on an
 * actor's session id means a reconnect, a second actor running the same
 * machine, and a page reload all reuse the same result.
 */

/**
 * Bump when anything that changes computed geometry changes: the ELK options
 * in `to-elk`, the fonts or paddings in `measure`, or the shape of
 * `LayoutGraph`. Stale entries are then ignored rather than drawn.
 */
export const LAYOUT_VERSION = 1;

const DB_NAME = 'sketch-layout';
const STORE = 'layouts';
/** Enough for a working set of machines; the oldest are dropped past this. */
const MAX_ENTRIES = 24;

/** FNV-1a. Not cryptographic — it only has to notice that a machine changed. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * A digest of everything about `graph` that changes its layout.
 *
 * Only the fields that reach ELK are included: node text drives box size,
 * edge endpoints and labels drive routing. Context, actions' behaviour and
 * anything else a snapshot carries are deliberately absent, so a running
 * machine never invalidates its own layout.
 */
export function hashGraph(graph: MachineGraph, salt = ''): string {
  const parts: string[] = [`v${LAYOUT_VERSION}`, salt];

  for (const node of graph.nodes) {
    const d = node.data;
    parts.push(
      node.id,
      node.parentId ?? '',
      d.key,
      d.description ?? '',
      d.type ?? '',
      d.historyType ?? '',
      d.entry.join(','),
      d.exit.join(','),
      d.invocations.join(','),
      d.initialId ?? '',
    );
  }

  for (const edge of graph.edges) {
    const d = edge.data;
    parts.push(
      edge.id,
      edge.sourceId,
      edge.targetId,
      d.displayEvent,
      d.guard ?? '',
      d.guardPrefix,
      d.description ?? '',
      d.actions.join(','),
      d.isTargetless ? '1' : '0',
    );
  }

  return fnv1a(parts.join('\u0000'));
}

interface StoredLayout {
  hash: string;
  savedAt: number;
  layout: LayoutGraph;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      // Private browsing and blocked storage both throw here.
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'hash' }).createIndex(
          'savedAt',
          'savedAt',
        );
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function promisify<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** A previously stored layout for this digest, or null. Never throws. */
export async function readPersistedLayout(
  hash: string,
): Promise<LayoutGraph | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const record = (await promisify(store.get(hash))) as StoredLayout | null;
    db.close();
    return record?.layout ?? null;
  } catch {
    return null;
  }
}

/** Stores a layout and trims the oldest entries. Never throws. */
export async function writePersistedLayout(
  hash: string,
  layout: LayoutGraph,
): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put({ hash, savedAt: Date.now(), layout } satisfies StoredLayout);

    const keys = (await promisify(store.getAllKeys())) ?? [];
    if (keys.length > MAX_ENTRIES) {
      const all = ((await promisify(store.getAll())) ?? []) as StoredLayout[];
      all
        .sort((a, b) => a.savedAt - b.savedAt)
        .slice(0, all.length - MAX_ENTRIES)
        .forEach((entry) => store.delete(entry.hash));
    }
    db.close();
  } catch {
    // A full or unavailable quota must never stop the graph rendering.
  }
}
