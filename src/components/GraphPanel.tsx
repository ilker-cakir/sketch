import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronUp,
  Crosshair,
  Loader2,
  Minus,
  Plus,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  RiTimerLine,
  RiInfinityLine,
  RiCheckboxCircleFill,
  RiCloseCircleFill,
} from '@remixicon/react';
import { getEventCategory, type MachineGraph } from '@/lib/machine';
import type { LayoutEdge } from '@/lib/layout/types';
import { layoutMachine } from '@/lib/layout/client';
import { createCanvasMeasureText } from '@/lib/layout/measure';
import { buildScene, relativeTarget, type Scene } from '@/lib/canvas/scene';
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canvasRef = useRef<GraphCanvasHandle>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus({ phase: 'loading' });
    setSelectedId(null);

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

  const scene = status.phase === 'ready' ? status.scene : null;

  /**
   * Which of the selected node's children are active, as a string.
   *
   * `activeIds` is a fresh set every snapshot, so passing it to the details
   * panel would re-render every row on every keystroke. Collapsing the part
   * the panel actually depends on into a comparable value keeps the panel
   * memoised until the highlighting genuinely changes.
   */
  const activeChildKey = useMemo(() => {
    if (!scene || !selectedId) return '';
    const children = scene.childIds.get(selectedId) ?? [];
    return children.filter((id) => activeIds.has(id)).join('\u0000');
  }, [scene, selectedId, activeIds]);

  // Stable identities, so the memoised details panel is not re-rendered by the
  // snapshot-rate re-render that only touches `activeIds`.
  const reveal = useCallback((nodeId: string) => {
    setSelectedId(nodeId);
    canvasRef.current?.centerOn(nodeId);
  }, []);
  const close = useCallback(() => setSelectedId(null), []);
  const select = useCallback(
    (node: { id: string } | null) => setSelectedId(node?.id ?? null),
    [],
  );

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

  const readyScene = status.scene;

  return (
    <div className="relative size-full">
      <GraphCanvas
        ref={canvasRef}
        scene={readyScene}
        activeIds={activeIds}
        selectedNodeId={selectedId}
        onSelect={select}
      />

      <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-2">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-md border border-border bg-card/95 p-1">
          <ToolbarButton label="Fit to view" onClick={() => canvasRef.current?.fit()}>
            <Crosshair className="size-4" />
          </ToolbarButton>
          <ToolbarButton label="Zoom out" onClick={() => canvasRef.current?.zoomBy(1 / 1.25)}>
            <Minus className="size-4" />
          </ToolbarButton>
          <ToolbarButton label="Zoom in" onClick={() => canvasRef.current?.zoomBy(1.25)}>
            <Plus className="size-4" />
          </ToolbarButton>
          <span className="border-l border-border px-2 text-[0.6875rem] text-muted-foreground">
            {readyScene.nodes.length} states · {readyScene.edges.length} transitions
          </span>
        </div>

        {readyScene.droppedEdgeCount > 0 && (
          <div
            data-testid="graph-dropped-edges"
            title="These transitions target a state that is not part of this machine."
            className="pointer-events-auto rounded-md border border-border bg-card/95 px-2 py-1 text-[0.6875rem] text-muted-foreground"
          >
            {readyScene.droppedEdgeCount} unresolved{' '}
            {readyScene.droppedEdgeCount === 1 ? 'transition' : 'transitions'}
          </div>
        )}
      </div>

      {selectedId && (
        <SelectionDetails
          scene={readyScene}
          nodeId={selectedId}
          isActive={activeIds.has(selectedId)}
          activeChildKey={activeChildKey}
          onReveal={reveal}
          onClose={close}
        />
      )}
    </div>
  );
}

interface SelectionDetailsProps {
  scene: Scene;
  nodeId: string;
  isActive: boolean;
  /** Active child ids, joined; see `activeChildKey` above. */
  activeChildKey: string;
  onReveal: (nodeId: string) => void;
  onClose: () => void;
}

/**
 * Everything the graph knows about one state: what it contains, what leads out
 * of it and what leads into it.
 *
 * Memoised on plain comparable props so a snapshot that does not change this
 * state's highlighting does not re-render its rows.
 */
const SelectionDetails = memo(function SelectionDetails({
  scene,
  nodeId,
  isActive,
  activeChildKey,
  onReveal,
  onClose,
}: SelectionDetailsProps) {
  const node = scene.nodeById.get(nodeId);
  if (!node) return null;

  const parent = node.parentId ? scene.nodeById.get(node.parentId) : undefined;
  const activeChildren = new Set(activeChildKey ? activeChildKey.split('\u0000') : []);
  const childIds = scene.childIds.get(nodeId) ?? [];
  const outEdges = (scene.outEdgeIds.get(nodeId) ?? [])
    .map((id) => scene.edgeById.get(id))
    .filter((e): e is LayoutEdge => e !== undefined);
  const inEdges = (scene.inEdgeIds.get(nodeId) ?? [])
    .map((id) => scene.edgeById.get(id))
    .filter((e): e is LayoutEdge => e !== undefined);

  return (
    <div
      data-testid="graph-selection"
      className={cn(
        'pointer-events-auto absolute bottom-3 left-3 flex w-80 flex-col',
        'max-h-[min(26rem,calc(100%-5.5rem))] rounded-md border border-border bg-card text-xs',
      )}
    >
      <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          {parent && (
            <button
              type="button"
              data-testid="graph-selection-parent"
              onClick={() => onReveal(parent.id)}
              title={`Go to ${parent.id}`}
              className="-ml-0.5 flex max-w-full items-center gap-0.5 text-[0.625rem] text-muted-foreground hover:text-foreground"
            >
              <ChevronUp className="size-3 shrink-0" />
              <span className="truncate font-mono">{parent.data.key}</span>
            </button>
          )}
          <div className="flex items-center gap-1.5">
            <h4 className="truncate text-sm font-semibold text-foreground">
              {node.data.key}
            </h4>
            {isActive && (
              <span
                data-testid="graph-selection-active"
                className="shrink-0 rounded-sm bg-primary/10 px-1 py-px text-[0.625rem] text-primary"
              >
                active
              </span>
            )}
          </div>
          <p
            data-testid="graph-selection-id"
            title={node.id}
            className="truncate font-mono text-[0.6875rem] text-muted-foreground"
          >
            {node.id}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="-mr-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {node.data.description && (
          <p className="border-b border-border px-3 py-2 italic text-muted-foreground">
            {node.data.description}
          </p>
        )}

        <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2 text-[0.625rem] uppercase tracking-wider text-muted-foreground">
          <span>{node.data.type ?? 'atomic'}</span>
          {node.isInitial && <span className="text-primary">· initial</span>}
          {node.data.historyType && <span>· {node.data.historyType}</span>}
        </div>

        <Section label="Sub-states" count={childIds.length}>
          {childIds.map((childId) => {
            const child = scene.nodeById.get(childId);
            if (!child) return null;
            return (
              <RowButton
                key={childId}
                testId="graph-substate"
                onClick={() => onReveal(childId)}
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-xs font-semibold text-foreground">
                    {child.data.key}
                  </span>
                  {child.isInitial && (
                    <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                      initial
                    </span>
                  )}
                  {activeChildren.has(childId) && (
                    <span className="shrink-0 text-[0.625rem] text-primary">active</span>
                  )}
                </span>
                <span className="mt-0.5 block text-[0.625rem] text-muted-foreground">
                  {child.data.type ?? 'atomic'}
                  {(scene.childIds.get(childId)?.length ?? 0) > 0 &&
                    ` · ${scene.childIds.get(childId)?.length} sub-states`}
                </span>
              </RowButton>
            );
          })}
        </Section>

        <Section label="Outgoing transitions" count={outEdges.length}>
          {outEdges.map((edge) => (
            <TransitionRow
              key={edge.id}
              scene={scene}
              edge={edge}
              direction="out"
              onReveal={onReveal}
            />
          ))}
        </Section>

        <Section label="Incoming transitions" count={inEdges.length}>
          {inEdges.map((edge) => (
            <TransitionRow
              key={edge.id}
              scene={scene}
              edge={edge}
              direction="in"
              onReveal={onReveal}
            />
          ))}
        </Section>
      </div>
    </div>
  );
});

function Section({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="border-b border-border last:border-b-0">
      <h5 className="px-3 pb-1 pt-2 text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground">
        {label} <span className="tabular-nums">({count})</span>
      </h5>
      <div>{children}</div>
    </section>
  );
}

function RowButton({
  testId,
  onClick,
  children,
}: {
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'block w-full border-t border-dashed border-border px-3 py-1.5 text-left',
        'first:border-t-0 hover:bg-primary/5',
      )}
    >
      {children}
    </button>
  );
}

const EVENT_ICONS = {
  after: <RiTimerLine className="size-3.5 shrink-0 text-muted-foreground" />,
  always: <RiInfinityLine className="size-3.5 shrink-0 text-muted-foreground" />,
  done: <RiCheckboxCircleFill className="size-3.5 shrink-0 text-green-500" />,
  error: <RiCloseCircleFill className="size-3.5 shrink-0 text-red-500" />,
} as const;

/**
 * One transition, named the way `TransitionViz` names it: the guard above, the
 * event and the far end below. Clicking jumps to the state at the other end.
 */
function TransitionRow({
  scene,
  edge,
  direction,
  onReveal,
}: {
  scene: Scene;
  edge: LayoutEdge;
  direction: 'in' | 'out';
  onReveal: (nodeId: string) => void;
}) {
  const { data } = edge;
  const isOut = direction === 'out';
  const otherId = isOut ? edge.targetId : edge.sourceId;
  const category = getEventCategory(data.eventType);
  // A targetless transition has no far end to name; everything else is named
  // relative to the state whose details these are.
  const otherLabel =
    isOut && data.isTargetless
      ? null
      : relativeTarget(scene, isOut ? edge.sourceId : edge.targetId, otherId);

  return (
    <RowButton testId={`graph-transition-${direction}`} onClick={() => onReveal(otherId)}>
      {(data.guard || data.guardPrefix) && (
        <span className="mb-0.5 flex items-center gap-1 text-[0.6875rem]">
          {data.guardPrefix && (
            <span className="font-semibold italic text-muted-foreground">
              {data.guardPrefix}
            </span>
          )}
          {data.guard && <span className="truncate font-mono text-primary">{data.guard}</span>}
        </span>
      )}

      {/*
        The event leads in both lists so they read down a common column, and
        the arrow carries the direction: `EVENT -> target` out, `EVENT <- source`
        in. Naming the far end first would leave it looking like the event.
      */}
      <span className="flex items-center gap-1.5">
        {category && EVENT_ICONS[category]}
        {data.displayEvent && (
          <span className="truncate font-mono text-xs font-semibold text-foreground">
            {data.displayEvent}
          </span>
        )}
        {otherLabel && (
          <>
            <span className="shrink-0 text-muted-foreground">
              {isOut ? '\u2192' : '\u2190'}
            </span>
            <span className="truncate font-mono text-xs text-primary">{otherLabel}</span>
          </>
        )}
      </span>

      {data.actions.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-1">
          {data.actions.map((action, i) => (
            <span
              key={i}
              className="rounded-sm bg-muted px-1 font-mono text-[0.6875rem] text-foreground"
            >
              {action}
            </span>
          ))}
        </span>
      )}
    </RowButton>
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
