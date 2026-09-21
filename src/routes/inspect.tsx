import { createFileRoute, Link } from '@tanstack/react-router';
import {
  createBrowserReceiver,
  type StatelyActorEvent,
  type StatelyInspectionEvent,
} from '@statelyai/inspect';
import { useEffect, useMemo, useReducer } from 'react';
import type React from 'react';
import { createMachine, type AnyStateMachine } from 'xstate';
import {
  Activity,
  ArrowDownWideNarrow,
  Boxes,
  ListOrdered,
  Workflow,
} from 'lucide-react';
import { MachineViz } from '@/components/MachineViz';
import { GraphPanel } from '@/components/GraphPanel';
import { machineToGraph, type MachineGraph } from '@/lib/machine';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/inspect')({
  component: InspectRoute,
});

type ActorInfo = {
  sessionId: string;
  name: string;
  parentId?: string;
  machine?: AnyStateMachine;
  graph?: MachineGraph;
  snapshot?: StatelyActorEvent['snapshot'];
};

type InspectState = {
  actors: Record<string, ActorInfo>;
  events: StatelyInspectionEvent[];
  selectedSessionId?: string;
  panel: 'actors' | 'sequence' | 'events';
  mainView: 'dom' | 'graph';
};

type InspectAction =
  | StatelyInspectionEvent
  | { type: 'actor.select'; sessionId: string }
  | { type: 'panel.select'; panel: InspectState['panel'] }
  | { type: 'view.select'; view: InspectState['mainView'] };

const initialInspectState: InspectState = {
  actors: {},
  events: [],
  panel: 'events',
  mainView: 'dom',
};

/**
 * Inspection events arrive at keystroke rate, so the log is bounded: an
 * unbounded array grows without limit and re-renders the whole sidebar list on
 * every snapshot. The Events and Sequence panels therefore show recent history
 * rather than all of it.
 */
const MAX_EVENTS = 500;

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

function inspectReducer(
  state: InspectState,
  action: InspectAction,
): InspectState {
  if (action.type === 'actor.select') {
    return { ...state, selectedSessionId: action.sessionId };
  }
  if (action.type === 'panel.select') {
    return { ...state, panel: action.panel };
  }
  if (action.type === 'view.select') {
    return { ...state, mainView: action.view };
  }
  if (action.type === '@xstate.actor') {
    const parsed = parseMachine(action.definition, action.sessionId);
    return {
      ...state,
      selectedSessionId: state.selectedSessionId ?? action.sessionId,
      events: appendEvent(state.events, action),
      actors: {
        ...state.actors,
        [action.sessionId]: {
          ...state.actors[action.sessionId],
          sessionId: action.sessionId,
          name: action.name || action.sessionId,
          parentId: action.parentId,
          snapshot: action.snapshot,
          ...parsed,
        },
      },
    };
  }
  if (action.type === '@xstate.snapshot') {
    const existing = state.actors[action.sessionId];
    return {
      ...state,
      events: appendEvent(state.events, action),
      actors: {
        ...state.actors,
        [action.sessionId]: {
          sessionId: action.sessionId,
          name: existing?.name ?? action.sessionId,
          parentId: existing?.parentId,
          machine: existing?.machine,
          graph: existing?.graph,
          snapshot: action.snapshot,
        },
      },
    };
  }
  if (action.type === '@xstate.event') {
    return { ...state, events: appendEvent(state.events, action) };
  }
  return state;
}

function collectValueIds(
  value: unknown,
  prefix: string,
  into: Set<string>,
): void {
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

function getActiveIds(
  snapshot: ActorInfo['snapshot'],
  rootId?: string,
): Set<string> {
  const nodes = (snapshot as { _nodes?: Array<{ id: string }> } | undefined)
    ?._nodes;
  if (nodes) return new Set(nodes.map((node) => node.id));
  // Inspection events carry a serialized snapshot (`status`/`value`/`context`)
  // with no `_nodes`, so derive the active ids from the state value instead.
  const value = (snapshot as { value?: unknown } | undefined)?.value;
  if (value === undefined || !rootId) return new Set();
  const ids = new Set<string>();
  collectValueIds(value, rootId, ids);
  return ids;
}

function formatJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function InspectRoute() {
  const [state, send] = useReducer(inspectReducer, initialInspectState);

  useEffect(() => {
    const receiver = createBrowserReceiver();
    const sub = receiver.subscribe((event) => send(event));
    return () => sub.unsubscribe();
  }, []);

  const actors = Object.values(state.actors);
  const selectedActor =
    state.selectedSessionId ? state.actors[state.selectedSessionId] : actors[0];
  const activeIds = useMemo(
    () => getActiveIds(selectedActor?.snapshot, selectedActor?.machine?.id),
    [selectedActor?.snapshot, selectedActor?.machine?.id],
  );

  if (!selectedActor) {
    return (
      <main className="flex h-screen items-center justify-center bg-background text-foreground">
        <div className="max-w-md px-6 text-center">
          <Activity className="mx-auto mb-4 size-8 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Waiting for inspection</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Use{' '}
            <code className="font-mono">
              createBrowserInspector({`{ url: 'https://sketch.stately.ai/inspect' }`})
            </code>
            .
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <Link to="/" className="text-sm font-semibold">
          Stately Sketch
        </Link>
        <div className="flex items-center gap-1">
          <PanelButton
            active={state.mainView === 'graph'}
            onClick={() =>
              send({
                type: 'view.select',
                view: state.mainView === 'graph' ? 'dom' : 'graph',
              })
            }
            icon={<Workflow className="size-4" />}
            label="Visualization"
            testId="tab-visualization"
          />
          <div className="mx-1 h-5 w-px bg-border" aria-hidden />
          <PanelButton
            active={state.panel === 'actors'}
            onClick={() => send({ type: 'panel.select', panel: 'actors' })}
            icon={<Boxes className="size-4" />}
            label="Actors"
          />
          <PanelButton
            active={state.panel === 'sequence'}
            onClick={() => send({ type: 'panel.select', panel: 'sequence' })}
            icon={<ArrowDownWideNarrow className="size-4" />}
            label="Sequence"
          />
          <PanelButton
            active={state.panel === 'events'}
            onClick={() => send({ type: 'panel.select', panel: 'events' })}
            icon={<ListOrdered className="size-4" />}
            label="Events"
          />
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px]">
        <section
          className={cn(
            'min-h-0',
            state.mainView === 'graph' ? 'overflow-hidden' : 'overflow-auto p-4',
          )}
        >
          {!selectedActor.graph ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No machine definition for {selectedActor.name}.
            </div>
          ) : state.mainView === 'graph' ? (
            <GraphPanel
              layoutKey={selectedActor.sessionId}
              graph={selectedActor.graph}
              activeIds={activeIds}
            />
          ) : (
            <MachineViz graph={selectedActor.graph} activeIds={activeIds} />
          )}
        </section>
        <aside className="min-h-0 border-l border-border">
          {state.panel === 'actors' ? (
            <ActorsPanel state={state} send={send} />
          ) : state.panel === 'sequence' ? (
            <SequencePanel events={state.events} />
          ) : (
            <EventsPanel events={state.events} />
          )}
        </aside>
      </div>
    </main>
  );
}

function PanelButton({
  active,
  icon,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-muted',
        active && 'bg-muted text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function ActorsPanel({
  state,
  send,
}: {
  state: InspectState;
  send: React.Dispatch<InspectAction>;
}) {
  const tree = buildActorTree(Object.values(state.actors));

  return (
    <div className="h-full overflow-auto p-2">
      {tree.map((actor) => (
        <ActorTreeItem
          key={actor.sessionId}
          actor={actor}
          selectedSessionId={state.selectedSessionId}
          send={send}
        />
      ))}
    </div>
  );
}

type ActorTreeNode = ActorInfo & {
  children: ActorTreeNode[];
  depth: number;
};

function buildActorTree(actors: ActorInfo[]): ActorTreeNode[] {
  const nodes = new Map<string, ActorTreeNode>();
  const roots: ActorTreeNode[] = [];

  for (const actor of actors) {
    nodes.set(actor.sessionId, { ...actor, children: [], depth: 0 });
  }

  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (!parent) {
      roots.push(node);
      continue;
    }
    node.depth = parent.depth + 1;
    parent.children.push(node);
  }

  return roots;
}

function ActorTreeItem({
  actor,
  selectedSessionId,
  send,
}: {
  actor: ActorTreeNode;
  selectedSessionId: string | undefined;
  send: React.Dispatch<InspectAction>;
}) {
  const selected = actor.sessionId === selectedSessionId;

  return (
    <>
      <button
        type="button"
        onClick={() =>
          send({ type: 'actor.select', sessionId: actor.sessionId })
        }
        style={{
          marginLeft: actor.depth * 16,
          width: `calc(100% - ${actor.depth * 16}px)`,
        }}
        className={cn(
          'mb-2 block rounded-md border border-border p-3 text-left text-sm hover:bg-muted',
          selected && 'bg-muted',
        )}
      >
        <div className="font-medium">{actor.name}</div>
        <div className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">
          {actor.sessionId}
        </div>
        {actor.snapshot && (
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-background p-2 text-[0.6875rem]">
            {formatJson({
              status: actor.snapshot.status,
              value: actor.snapshot.value,
              context: actor.snapshot.context,
              output: actor.snapshot.output,
            })}
          </pre>
        )}
      </button>
      {actor.children.map((child) => (
        <ActorTreeItem
          key={child.sessionId}
          actor={child}
          selectedSessionId={selectedSessionId}
          send={send}
        />
      ))}
    </>
  );
}

function SequencePanel({ events }: { events: StatelyInspectionEvent[] }) {
  return (
    <div className="h-full overflow-auto p-3">
      {events.map((event, index) => (
        <div key={`${event.createdAt}-${index}`} className="relative pb-4 pl-5">
          <div className="absolute left-1 top-1 size-2 rounded-full bg-primary" />
          <div className="absolute bottom-0 left-[7px] top-3 w-px bg-border" />
          <div className="text-xs font-medium">{event.type}</div>
          <div className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">
            {event.type === '@xstate.event'
              ? `${event.sourceId ?? 'external'} -> ${event.sessionId}: ${event.event.type}`
              : event.sessionId}
          </div>
        </div>
      ))}
    </div>
  );
}

function EventsPanel({ events }: { events: StatelyInspectionEvent[] }) {
  return (
    <div className="h-full overflow-auto p-3">
      {events.map((event, index) => (
        <details
          key={`${event.createdAt}-${index}`}
          className="mb-2 rounded-md border border-border bg-card"
        >
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            {event.type}
            {'event' in event ? ` · ${event.event.type}` : ''}
          </summary>
          <pre className="max-h-80 overflow-auto border-t border-border p-3 text-[0.6875rem]">
            {formatJson(event)}
          </pre>
        </details>
      ))}
    </div>
  );
}
