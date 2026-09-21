import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { LayoutEdge } from '@/lib/layout/types';
import { createGraphController, type GraphController } from '@/lib/canvas/controller';
import type { Scene, SceneNode } from '@/lib/canvas/scene';

export interface GraphCanvasHandle {
  fit(): void;
  zoomBy(factor: number): void;
  centerOn(nodeId: string): void;
}

interface GraphCanvasProps {
  scene: Scene | null;
  /** Currently active state ids. Pushed straight to the canvas, not rendered. */
  activeIds: ReadonlySet<string>;
  selectedNodeId?: string | null;
  onSelect?: (node: SceneNode | null) => void;
  onHoverChange?: (hover: { node: SceneNode | null; edge: LayoutEdge | null }) => void;
  ref?: Ref<GraphCanvasHandle>;
}

/**
 * React owns the `<canvas>` element and nothing else.
 *
 * This component renders exactly once per scene change. Snapshot-rate updates
 * (`activeIds`) go through effects into the imperative controller, so a
 * keystroke never re-renders a React subtree — the whole point of the canvas
 * renderer.
 */
export function GraphCanvas({
  scene,
  activeIds,
  selectedNodeId = null,
  onSelect,
  onHoverChange,
  ref,
}: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<GraphController | null>(null);

  // Keep the latest callbacks reachable without re-creating the controller.
  const callbacksRef = useRef({ onSelect, onHoverChange });
  callbacksRef.current = { onSelect, onHoverChange };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let controller: GraphController;
    try {
      controller = createGraphController(canvas, {
        onSelect: (node) => callbacksRef.current.onSelect?.(node),
        onHoverChange: (hover) => callbacksRef.current.onHoverChange?.(hover),
      });
    } catch {
      // No 2D context — the panel shows its own fallback.
      return;
    }

    controllerRef.current = controller;
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setScene(scene);
  }, [scene]);

  useEffect(() => {
    controllerRef.current?.setActiveIds(activeIds);
  }, [activeIds]);

  useEffect(() => {
    controllerRef.current?.setSelected(selectedNodeId);
  }, [selectedNodeId]);

  // The theme lives in CSS custom properties, so a class change on <html>
  // (dark mode) needs the resolved colours re-read.
  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => controllerRef.current?.refreshTheme());
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      fit: () => controllerRef.current?.fit(),
      zoomBy: (factor: number) => controllerRef.current?.zoomBy(factor),
      centerOn: (nodeId: string) => controllerRef.current?.centerOn(nodeId),
    }),
    [],
  );

  return (
    <canvas
      ref={canvasRef}
      data-testid="graph-canvas"
      className="block size-full"
      aria-label="State machine graph"
      role="img"
    />
  );
}
