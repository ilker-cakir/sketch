import { useEffect, useRef, useState } from 'react';
import { Crosshair, Loader2, Minus, Plus, TriangleAlert } from 'lucide-react';
import type { MachineGraph } from '@/lib/machine';
import { layoutMachine } from '@/lib/layout/client';
import { createCanvasMeasureText } from '@/lib/layout/measure';
import { buildScene, type Scene, type SceneNode } from '@/lib/canvas/scene';
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas';
import { cn } from '@/lib/utils';

interface GraphPanelProps {
  /** Identifies the machine *definition*; layout is cached against it. */
  layoutKey: string;
  graph: MachineGraph;
  activeIds: ReadonlySet<string>;
}

type LayoutStatus =
  | { phase: 'loading' }
  | { phase: 'ready'; scene: Scene }
  | { phase: 'error'; message: string };

const measureText = createCanvasMeasureText();

/**
 * Wires a machine graph to the canvas renderer.
 *
 * This is the only component that re-renders at snapshot rate, and all it does
 * is hand `activeIds` to the canvas. Layout runs once per `layoutKey`.
 */
export function GraphPanel({ layoutKey, graph, activeIds }: GraphPanelProps) {
  const [status, setStatus] = useState<LayoutStatus>({ phase: 'loading' });
  const [selected, setSelected] = useState<SceneNode | null>(null);
  const canvasRef = useRef<GraphCanvasHandle>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus({ phase: 'loading' });
    setSelected(null);

    layoutMachine(layoutKey, graph, { measureText })
      .then((layout) => {
        if (cancelled) return;
        setStatus({ phase: 'ready', scene: buildScene(layout, measureText) });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus({
          phase: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [layoutKey, graph]);

  if (status.phase === 'loading') {
    return (
      <div
        data-testid="graph-loading"
        className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" />
        Laying out {graph.nodes.length} states…
      </div>
    );
  }

  if (status.phase === 'error') {
    return (
      <div
        data-testid="graph-error"
        className="flex size-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground"
      >
        <TriangleAlert className="size-5 text-destructive" />
        <p>Could not lay out this machine.</p>
        <p className="font-mono text-xs">{status.message}</p>
      </div>
    );
  }

  const { scene } = status;

  return (
    <div className="relative size-full">
      <GraphCanvas
        ref={canvasRef}
        scene={scene}
        activeIds={activeIds}
        selectedNodeId={selected?.id ?? null}
        onSelect={setSelected}
      />

      <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-2">
        <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-border bg-card/90 p-1 backdrop-blur">
          <ToolbarButton label="Fit to view" onClick={() => canvasRef.current?.fit()}>
            <Crosshair className="size-4" />
          </ToolbarButton>
          <ToolbarButton label="Zoom out" onClick={() => canvasRef.current?.zoomBy(1 / 1.25)}>
            <Minus className="size-4" />
          </ToolbarButton>
          <ToolbarButton label="Zoom in" onClick={() => canvasRef.current?.zoomBy(1.25)}>
            <Plus className="size-4" />
          </ToolbarButton>
          <span className="px-1.5 text-[0.6875rem] text-muted-foreground">
            {scene.nodes.length} states · {scene.edges.length} transitions
          </span>
        </div>

        {scene.droppedEdgeCount > 0 && (
          <div
            data-testid="graph-dropped-edges"
            title="These transitions target a state that is not part of this machine."
            className="pointer-events-auto rounded-md border border-border bg-card/90 px-2 py-1 text-[0.6875rem] text-muted-foreground backdrop-blur"
          >
            {scene.droppedEdgeCount} unresolved{' '}
            {scene.droppedEdgeCount === 1 ? 'transition' : 'transitions'}
          </div>
        )}
      </div>

      {selected && (
        <div
          data-testid="graph-selection"
          className="pointer-events-none absolute bottom-3 left-3 max-w-sm rounded-md border border-border bg-card/95 px-3 py-2 text-xs backdrop-blur"
        >
          <div className="font-mono font-semibold">{selected.id}</div>
          {selected.data.description && (
            <div className="mt-1 italic text-muted-foreground">
              {selected.data.description}
            </div>
          )}
          <div className="mt-1 text-muted-foreground">
            {selected.data.type ?? 'atomic'}
            {activeIds.has(selected.id) && ' · active'}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded text-muted-foreground',
        'hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
