import type { AnyStateMachine } from 'xstate';
import { createGraph, addNode, addEdge, type Graph } from '@statelyai/graph';

/**
 * The machine graph model and the helpers that read it.
 *
 * Turning source code into a machine lives in `machine-parse`, which pulls in
 * a TypeScript stripper, a YAML parser and a Mermaid parser. Only the editor
 * needs those; live inspection receives a machine config over the wire. Keeping
 * them out of this module keeps them out of the `/inspect` and `/visualize`
 * bundles.
 */

// Types for node/edge data used in our graph
export interface StateNodeData {
  key: string;
  description?: string;
  type: 'compound' | 'parallel' | 'atomic' | 'final' | 'history' | null;
  historyType?: 'shallow' | 'deep';
  entry: string[];
  exit: string[];
  invocations: string[];
  initialId: string | null;
}

export interface TransitionData {
  eventType: string;
  displayEvent: string; // Cleaned event name for display
  guard: string | null;
  guardPrefix: '' | 'if' | 'else if' | 'else'; // computed from sibling transitions
  description?: string;
  actions: string[];
  isTargetless: boolean;
}

export type MachineGraph = Graph<StateNodeData, TransitionData>;

/** Clean up XState internal event types for display */
function displayEventType(eventType: string): string {
  if (!eventType) return '';

  // xstate.after(DELAY).stateId → just the delay value
  const afterMatch = eventType.match(/^xstate\.after\((\d+)\)\./);
  if (afterMatch) return `${afterMatch[1]}ms`;
  const afterNamedMatch = eventType.match(/^xstate\.after\(([^)]+)\)\./);
  if (afterNamedMatch) return afterNamedMatch[1];
  // xstate.after.DELAY.stateId → just the delay value
  const afterDotMatch = eventType.match(/^xstate\.after\.([^.]+)\./);
  if (afterDotMatch) return afterDotMatch[1];

  // xstate.done.state.stateId → done
  if (eventType.startsWith('xstate.done.state.')) return 'done';
  // xstate.done.actor.actorId → actor name
  const doneActorMatch = eventType.match(/^xstate\.done\.actor\.(.+)$/);
  if (doneActorMatch) return doneActorMatch[1];

  // xstate.error.actor.actorId → actor name
  const errorMatch = eventType.match(/^xstate\.error\.actor\.(.+)$/);
  if (errorMatch) return errorMatch[1];

  return eventType;
}

/**
 * The delay of an `after` transition in milliseconds, or null.
 *
 * Returns null for named delays (`xstate.after(TIMEOUT).x`), whose duration
 * lives in the machine's `delays` implementation rather than the event type,
 * so no progress can be derived from the event alone.
 */
export function getAfterDelayMs(eventType: string): number | null {
  if (!eventType) return null;
  const match =
    eventType.match(/^xstate\.after\((\d+)\)\./) ??
    eventType.match(/^xstate\.after\.(\d+)\./);
  if (!match) return null;
  const ms = Number(match[1]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Categorize event type for icon display */
export function getEventCategory(
  eventType: string,
): 'after' | 'always' | 'done' | 'error' | null {
  if (!eventType || eventType === '(always)') return 'always';
  if (eventType.startsWith('xstate.after')) return 'after';
  if (eventType.startsWith('xstate.done')) return 'done';
  if (eventType.startsWith('xstate.error')) return 'error';
  return null;
}

/**
 * Convert an XState machine into our graph representation
 */
export function machineToGraph(machine: AnyStateMachine): MachineGraph {
  const graph = createGraph<StateNodeData, TransitionData>();

  // Pass 1: Add all nodes
  function addNodes(stateNode: any) {
    const stateType = stateNode.type as string;
    const initialChildId = stateNode.initial?.target?.[0]?.id ?? null;
    addNode(graph, {
      id: stateNode.id,
      parentId: stateNode.parent?.id ?? null,
      initialNodeId: initialChildId ?? undefined,
      label: stateNode.key,
      data: {
        key: stateNode.key,
        description: stateNode.description,
        type:
          stateType === 'compound'
            ? 'compound'
            : stateType === 'parallel'
              ? 'parallel'
              : stateType === 'final'
                ? 'final'
                : stateType === 'history'
                  ? 'history'
                  : stateNode.states && Object.keys(stateNode.states).length > 0
                    ? 'compound'
                    : 'atomic',
        historyType:
          stateType === 'history'
            ? stateNode.history === 'deep'
              ? 'deep'
              : 'shallow'
            : undefined,
        entry:
          stateNode.entry
            ?.map((a: any) =>
              typeof a === 'string'
                ? a
                : typeof a === 'object' && a?.type
                  ? a.type
                  : null,
            )
            .filter((x: any) => x !== null && !x.startsWith('xstate.')) ?? [],
        exit:
          stateNode.exit
            ?.map((a: any) =>
              typeof a === 'string'
                ? a
                : typeof a === 'object' && a?.type
                  ? a.type
                  : null,
            )
            .filter((x: any) => x !== null && !x.startsWith('xstate.')) ?? [],
        invocations:
          stateNode.invoke?.map((inv: any) =>
            typeof inv === 'string' ? inv : (inv?.src ?? inv?.id ?? 'invoke'),
          ) ?? [],
        initialId: initialChildId,
      },
    });

    for (const child of Object.values(stateNode.states ?? {})) {
      addNodes(child);
    }
  }

  function composedGuardName(guard: any): string {
    // Use check.name (checkAnd/checkOr/checkNot) which is stable across bundlers
    const checkName = guard.check?.name;
    if (checkName === 'checkAnd') return 'and';
    if (checkName === 'checkOr') return 'or';
    if (checkName === 'checkNot') return 'not';
    return 'guard';
  }

  function describeGuard(guard: any): string {
    if (!guard) return '';
    if (typeof guard === 'string') return guard;
    if (typeof guard === 'function') {
      // Composed guard: and/or/not with .guards array
      if (guard.guards) {
        const name = composedGuardName(guard);
        const inner = guard.guards.map((g: any) => describeGuard(g)).join(', ');
        return `${name}(${inner})`;
      }
      return guard.name || 'guard';
    }
    if (guard.type) return guard.type;
    return 'guard';
  }

  function resolveGuard(transition: any): string | null {
    if (!transition.guard) return null;
    if (typeof transition.guard === 'string') return transition.guard;
    if (typeof transition.guard === 'function') {
      // Composed/inline guard — generate a descriptive name
      if (transition.guard.guards) {
        return describeGuard(transition.guard);
      }
      return transition.guard.name || null;
    }
    return transition.guard?.type ?? null;
  }

  /**
   * Compute guard prefix for a transition within its group.
   * - group size 1: no prefix
   * - group size >1, index 0: "if"
   * - group size >1, not last: "else if"
   * - group size >1, last: "else"
   */
  function guardPrefix(
    groupSize: number,
    index: number,
  ): TransitionData['guardPrefix'] {
    if (groupSize <= 1) return '';
    if (index === 0) return 'if';
    if (index === groupSize - 1) return 'else';
    return 'else if';
  }

  function addTransitionGroup(
    stateNode: any,
    eventType: string,
    transitions: any[],
  ) {
    const size = transitions.length;
    transitions.forEach((transition: any, i: number) => {
      const transitionId = `${stateNode.id}:${eventType || 'always'}:${i}`;
      addEdge(graph, {
        id: transitionId,
        sourceId: stateNode.id,
        targetId: transition.target?.[0]?.id ?? stateNode.id,
        label: eventType || '(always)',
        data: {
          eventType: eventType || '(always)',
          displayEvent: displayEventType(eventType),
          guard: resolveGuard(transition),
          guardPrefix: guardPrefix(size, i),
          description: transition.description,
          actions:
            transition.actions
              ?.map((a: any) =>
                typeof a === 'string'
                  ? a
                  : typeof a === 'object' && a?.type
                    ? a.type
                    : null,
              )
              .filter((x: any) => x !== null && !x.startsWith('xstate.')) ?? [],
          isTargetless: !transition.target,
        },
      });
    });
  }

  // Pass 2: Add all edges (all nodes exist now)
  function addEdges(stateNode: any) {
    for (const [eventType, transitions] of stateNode.transitions) {
      if (!Array.isArray(transitions) || transitions.length === 0) continue;
      addTransitionGroup(stateNode, eventType, transitions);
    }

    if (stateNode.always?.length) {
      addTransitionGroup(stateNode, '', stateNode.always);
    }

    for (const child of Object.values(stateNode.states ?? {})) {
      addEdges(child);
    }
  }

  addNodes(machine.root);
  addEdges(machine.root);
  return graph;
}

/**
 * Get relative target key for display.
 * If target is sibling, just show key. If descendant of sibling, show relative path.
 * Otherwise show full "#id".
 */
export function getRelativeTarget(
  sourceId: string,
  targetId: string,
  graph: MachineGraph,
): string {
  if (sourceId === targetId) return '(self)';

  // Get source parent
  const sourceNode = graph.nodes.find((n) => n.id === sourceId);
  const targetNode = graph.nodes.find((n) => n.id === targetId);
  if (!sourceNode || !targetNode) return targetId;

  // Same parent = sibling
  if (sourceNode.parentId === targetNode.parentId) {
    return targetNode.data.key;
  }

  // Target is descendant of a sibling
  if (sourceNode.parentId) {
    const siblings = graph.nodes.filter(
      (n) => n.parentId === sourceNode.parentId,
    );
    for (const sibling of siblings) {
      if (targetId.startsWith(sibling.id + '.')) {
        const relativePath = targetId.slice(
          sibling.id.length - sibling.data.key.length,
        );
        return relativePath;
      }
    }
  }

  // Check if target is a child/descendant of source
  if (targetId.startsWith(sourceId + '.')) {
    return '.' + targetId.slice(sourceId.length + 1);
  }

  return '#' + targetId;
}
