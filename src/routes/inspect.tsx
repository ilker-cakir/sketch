import { createFileRoute } from '@tanstack/react-router';
import type { StatelyInspectionEvent } from '@statelyai/inspect';
import { useMemo, useState } from 'react';
import { ArrowDownWideNarrow, Boxes, ListOrdered } from 'lucide-react';
import { MachineViz } from '@/components/MachineViz';
import {
  InspectHeader,
  PanelButton,
  WaitingForInspection,
} from '@/components/InspectChrome';
import {
  getActiveIds,
  getSelectedActor,
  selectActor,
  useInspectState,
  type ActorInfo,
  type InspectState,
} from '@/lib/inspect-store';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/inspect')({
  component: InspectRoute,
});

type Panel = 'actors' | 'sequence' | 'events';

function formatJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function InspectRoute() {
  const state = useInspectState();
  const [panel, setPanel] = useState<Panel>('events');

  const selectedActor = getSelectedActor(state);
  const activeIds = useMemo(
    () => getActiveIds(selectedActor?.snapshot, selectedActor?.machine?.id),
    [selectedActor?.snapshot, selectedActor?.machine?.id],
  );

  if (!selectedActor) return <WaitingForInspection route="/inspect" />;

  return (
    <main className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <InspectHeader current="/inspect">
        <PanelButton
          active={panel === 'actors'}
          onClick={() => setPanel('actors')}
          icon={<Boxes className="size-4" />}
          label="Actors"
        />
        <PanelButton
          active={panel === 'sequence'}
          onClick={() => setPanel('sequence')}
          icon={<ArrowDownWideNarrow className="size-4" />}
          label="Sequence"
        />
        <PanelButton
          active={panel === 'events'}
          onClick={() => setPanel('events')}
          icon={<ListOrdered className="size-4" />}
          label="Events"
        />
      </InspectHeader>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-h-0 overflow-auto p-4">
          {selectedActor.graph ? (
            <MachineViz graph={selectedActor.graph} activeIds={activeIds} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No machine definition for {selectedActor.name}.
            </div>
          )}
        </section>
        <aside className="min-h-0 border-l border-border">
          {panel === 'actors' ? (
            <ActorsPanel state={state} />
          ) : panel === 'sequence' ? (
            <SequencePanel events={state.events} />
          ) : (
            <EventsPanel events={state.events} />
          )}
        </aside>
      </div>
    </main>
  );
}

function ActorsPanel({ state }: { state: InspectState }) {
  const tree = buildActorTree(Object.values(state.actors));

  return (
    <div className="h-full overflow-auto p-2">
      {tree.map((actor) => (
        <ActorTreeItem
          key={actor.sessionId}
          actor={actor}
          selectedSessionId={state.selectedSessionId}
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
}: {
  actor: ActorTreeNode;
  selectedSessionId: string | undefined;
}) {
  const selected = actor.sessionId === selectedSessionId;

  return (
    <>
      <button
        type="button"
        onClick={() => selectActor(actor.sessionId)}
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
