import {
  createBrowserReceiver,
  type StatelyActorEvent,
  type StatelyInspectionEvent,
} from '@statelyai/inspect';
import { createMachine, type AnyStateMachine } from 'xstate';
import { useSyncExternalStore } from 'react';
import { machineToGraph, type MachineGraph } from './machine';

/**
 * Shared state for the live inspection stream.
 *
 * The receiver lives at module scope rather than inside a route component, so
 * `/inspect` and `/visualize` observe the same actors and history and you can
 * move between them without losing the connection or replaying events.
 */

export interface ActorInfo {
  sessionId: string;
  name: string;
  parentId?: string;
  machine?: AnyStateMachine;
  graph?: MachineGraph;
  snapshot?: StatelyActorEvent['snapshot'];
}

export interface InspectState {
  actors: Record<string, ActorInfo>;
  events: StatelyInspectionEvent[];
  selectedSessionId?: string;
}

/**
 * Inspection events arrive at keystroke rate, so the log is bounded: an
 * unbounded array grows without limit and re-renders the whole sidebar list on
 * every snapshot. The Events and Sequence panels show recent history, not all
 * of it.
 */
export const MAX_EVENTS = 500;

const EMPTY: InspectState = { actors: {}, events: [] };

let state: InspectState = EMPTY;
const listeners = new Set<() => void>();
let receiverStarted = false;

function emit(next: InspectState): void {
  state = next;
  for (const listener of listeners) listener();
}

function appendEvent(
  events: StatelyInspectionEvent[],
  event: StatelyInspectionEvent,
): StatelyInspectionEvent[] {
  const next = [...events, event];
  return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
}

function parseMachine(definition: string | undefined, fallbackId: string) {
  try {
    const config = definition ? JSON.parse(definition) : { id: fallbackId };
    const machine = createMachine(config);
    return { machine, graph: machineToGraph(machine) };
  } catch {
    return {};
  }
}

export function applyInspectionEvent(
  current: InspectState,
  event: StatelyInspectionEvent,
): InspectState {
  if (event.type === '@xstate.actor') {
    const parsed = parseMachine(event.definition, event.sessionId);
    return {
      ...current,
      selectedSessionId: current.selectedSessionId ?? event.sessionId,
      events: appendEvent(current.events, event),
      actors: {
        ...current.actors,
        [event.sessionId]: {
          ...current.actors[event.sessionId],
          sessionId: event.sessionId,
          name: event.name || event.sessionId,
          parentId: event.parentId,
          snapshot: event.snapshot,
          ...parsed,
        },
      },
    };
  }

  if (event.type === '@xstate.snapshot') {
    const existing = current.actors[event.sessionId];
    return {
      ...current,
      events: appendEvent(current.events, event),
      actors: {
        ...current.actors,
        [event.sessionId]: {
          sessionId: event.sessionId,
          name: existing?.name ?? event.sessionId,
          parentId: existing?.parentId,
          machine: existing?.machine,
          graph: existing?.graph,
          snapshot: event.snapshot,
        },
      },
    };
  }

  if (event.type === '@xstate.event') {
    return { ...current, events: appendEvent(current.events, event) };
  }

  return current;
}

/** Starts the browser receiver once, on first subscription. */
function ensureReceiver(): void {
  if (receiverStarted || typeof window === 'undefined') return;
  receiverStarted = true;
  const receiver = createBrowserReceiver();
  receiver.subscribe((event) => emit(applyInspectionEvent(state, event)));
}

export function selectActor(sessionId: string): void {
  if (state.selectedSessionId === sessionId) return;
  emit({ ...state, selectedSessionId: sessionId });
}

/** Test seam: clears the stream without tearing down the receiver. */
export function resetInspectState(): void {
  emit(EMPTY);
}

function subscribe(listener: () => void): () => void {
  ensureReceiver();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): InspectState => state;
const getServerSnapshot = (): InspectState => EMPTY;

export function useInspectState(): InspectState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Resolves the actor a route should display: the selected one, else the first. */
export function getSelectedActor(current: InspectState): ActorInfo | undefined {
  if (current.selectedSessionId) {
    const selected = current.actors[current.selectedSessionId];
    if (selected) return selected;
  }
  return Object.values(current.actors)[0];
}

function collectValueIds(value: unknown, prefix: string, into: Set<string>): void {
  into.add(prefix);
  if (typeof value === 'string') {
    into.add(`${prefix}.${value}`);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectValueIds(child, `${prefix}.${key}`, into);
    }
  }
}

/**
 * The set of active state node ids for a snapshot.
 *
 * Inspection events carry a serialized snapshot (`status`/`value`/`context`)
 * with no `_nodes`, so the ids are derived from the state value plus the
 * machine root id when `_nodes` is absent.
 */
export function getActiveIds(
  snapshot: ActorInfo['snapshot'],
  rootId?: string,
): Set<string> {
  const nodes = (snapshot as { _nodes?: Array<{ id: string }> } | undefined)?._nodes;
  if (nodes) return new Set(nodes.map((node) => node.id));

  const value = (snapshot as { value?: unknown } | undefined)?.value;
  if (value === undefined || !rootId) return new Set();
  const ids = new Set<string>();
  collectValueIds(value, rootId, ids);
  return ids;
}
