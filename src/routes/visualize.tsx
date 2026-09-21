import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Boxes } from 'lucide-react';
import { GraphPanel } from '@/components/GraphPanel';
import { InspectHeader, WaitingForInspection } from '@/components/InspectChrome';
import {
  getActiveIds,
  getSelectedActor,
  selectActor,
  useInspectState,
} from '@/lib/inspect-store';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/visualize')({
  component: VisualizeRoute,
});

/**
 * Full-bleed canvas view of the live machine.
 *
 * Shares the inspection stream with `/inspect` through the module-level store,
 * so switching routes keeps the connection, the actor list and the selection.
 */
function VisualizeRoute() {
  const state = useInspectState();
  const selectedActor = getSelectedActor(state);
  const actors = Object.values(state.actors);

  const activeIds = useMemo(
    () => getActiveIds(selectedActor?.snapshot, selectedActor?.machine?.id),
    [selectedActor?.snapshot, selectedActor?.machine?.id],
  );

  if (!selectedActor) return <WaitingForInspection route="/visualize" />;

  return (
    <main className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <InspectHeader current="/visualize">
        {actors.length > 1 && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Boxes className="size-4" />
            <span className="sr-only">Actor</span>
            <select
              data-testid="actor-select"
              value={selectedActor.sessionId}
              onChange={(event) => selectActor(event.target.value)}
              className={cn(
                'h-8 rounded-md border border-border bg-card px-2 text-xs text-foreground',
                'hover:bg-muted',
              )}
            >
              {actors.map((actor) => (
                <option key={actor.sessionId} value={actor.sessionId}>
                  {actor.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </InspectHeader>

      <section className="min-h-0 flex-1 overflow-hidden">
        {selectedActor.graph ? (
          <GraphPanel
            layoutKey={selectedActor.sessionId}
            graph={selectedActor.graph}
            activeIds={activeIds}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No machine definition for {selectedActor.name}.
          </div>
        )}
      </section>
    </main>
  );
}
