import { describe, expect, it } from 'vitest';
import { createMachine } from 'xstate';
import { machineToGraph, type MachineGraph } from '@/lib/machine';
import {
  collapseGraph,
  collapsibleIds,
  outermostCollapsibleIds,
  visibleAncestor,
} from './collapse';

/** region0 { group0 { leaf0, leaf1 } }, region1 { … } — three levels. */
function nested(): MachineGraph {
  return machineToGraph(
    createMachine({
      id: 'm',
      type: 'parallel',
      states: {
        region0: {
          initial: 'group0',
          states: {
            group0: {
              initial: 'leaf0',
              states: {
                leaf0: { on: { NEXT: { target: 'leaf1' } } },
                leaf1: { on: { OUT: { target: '#m.region1.group1' } } },
              },
            },
          },
        },
        region1: {
          initial: 'group1',
          states: {
            group1: {
              initial: 'leafA',
              states: { leafA: { on: { BACK: { target: '#m.region0' } } } },
            },
          },
        },
      },
    }),
  );
}

const ids = (g: MachineGraph) => g.nodes.map((n) => n.id).sort();
const edgeOf = (g: MachineGraph, id: string) => g.edges.find((e) => e.id === id);

describe('visibleAncestor', () => {
  const parents = new Map<string, string | null>([
    ['m', null],
    ['m.a', 'm'],
    ['m.a.b', 'm.a'],
    ['m.a.b.c', 'm.a.b'],
  ]);

  it('is the node itself when nothing above it is collapsed', () => {
    expect(visibleAncestor('m.a.b.c', parents, new Set())).toBe('m.a.b.c');
  });

  it('is the collapsed ancestor that hides it', () => {
    expect(visibleAncestor('m.a.b.c', parents, new Set(['m.a.b']))).toBe('m.a.b');
  });

  it('prefers the shallowest collapsed ancestor, not the nearest', () => {
    // Collapsing an outer container hides everything under it, whatever the
    // inner ones say about themselves.
    expect(visibleAncestor('m.a.b.c', parents, new Set(['m.a', 'm.a.b']))).toBe('m.a');
  });
});

describe('collapseGraph', () => {
  it('returns the graph untouched when nothing is collapsed', () => {
    const graph = nested();
    const result = collapseGraph(graph, new Set());
    expect(result.graph).toBe(graph);
    expect(result.internalEdgeCount).toBe(0);
  });

  it('removes the descendants of a collapsed container', () => {
    const { graph } = collapseGraph(nested(), new Set(['m.region0']));
    expect(ids(graph)).toEqual(['m', 'm.region0', 'm.region1', 'm.region1.group1', 'm.region1.group1.leafA']);
  });

  it('counts what each container is hiding', () => {
    const { hiddenCountById } = collapseGraph(nested(), new Set(['m.region0']));
    // group0, leaf0, leaf1.
    expect(hiddenCountById.get('m.region0')).toBe(3);
    expect(hiddenCountById.get('m.region1')).toBeUndefined();
  });

  it('re-points an edge leaving a collapsed container at the container', () => {
    const { graph } = collapseGraph(nested(), new Set(['m.region0']));
    const out = graph.edges.find((e) => e.data.eventType === 'OUT')!;
    expect(out.sourceId).toBe('m.region0');
    expect(out.targetId).toBe('m.region1.group1');
  });

  it('re-points an edge arriving into a collapsed container', () => {
    const { graph } = collapseGraph(nested(), new Set(['m.region1']));
    const out = graph.edges.find((e) => e.data.eventType === 'OUT')!;
    expect(out.targetId).toBe('m.region1');
  });

  it('drops an edge that falls entirely inside one collapsed container', () => {
    const { graph, internalEdgeCount } = collapseGraph(nested(), new Set(['m.region0']));
    // leaf0 --NEXT--> leaf1 has nothing left to say once both are hidden.
    expect(graph.edges.some((e) => e.data.eventType === 'NEXT')).toBe(false);
    expect(internalEdgeCount).toBe(1);
  });

  it('keeps a genuine self transition on a collapsed container', () => {
    const graph = machineToGraph(
      createMachine({
        id: 'm',
        initial: 'a',
        states: {
          a: { initial: 'x', on: { PING: { target: 'a' } }, states: { x: {} } },
        },
      }),
    );
    const collapsed = collapseGraph(graph, new Set(['m.a']));
    const ping = collapsed.graph.edges.find((e) => e.data.eventType === 'PING')!;
    expect(ping.sourceId).toBe('m.a');
    expect(ping.targetId).toBe('m.a');
    expect(collapsed.internalEdgeCount).toBe(0);
  });

  it('drops the initial-child pointer of a collapsed container', () => {
    const { graph } = collapseGraph(nested(), new Set(['m.region0']));
    const region = graph.nodes.find((n) => n.id === 'm.region0')!;
    // The child it pointed at no longer exists, so keeping it would dangle.
    expect(region.initialNodeId ?? null).toBeNull();
  });

  it('keeps the initial-child pointer of a container left expanded', () => {
    const { graph } = collapseGraph(nested(), new Set(['m.region0']));
    const region = graph.nodes.find((n) => n.id === 'm.region1')!;
    expect(region.initialNodeId).toBe('m.region1.group1');
  });

  it('preserves edge data so the details panel still reads correctly', () => {
    const before = nested();
    const { graph } = collapseGraph(before, new Set(['m.region0']));
    const out = graph.edges.find((e) => e.data.eventType === 'OUT')!;
    expect(out.data).toBe(edgeOf(before, out.id)!.data);
  });

  it('handles nested collapses without losing nodes', () => {
    const { graph } = collapseGraph(nested(), new Set(['m.region0', 'm.region0.group0']));
    expect(ids(graph)).toContain('m.region0');
    expect(ids(graph)).not.toContain('m.region0.group0');
  });
});

describe('merging transitions onto collapsed containers', () => {
  /** Two regions, each with two leaves, criss-crossed between them. */
  function crossed(): MachineGraph {
    return machineToGraph(
      createMachine({
        id: 'm',
        type: 'parallel',
        states: {
          left: {
            initial: 'a',
            states: {
              a: { on: { A1: { target: '#m.right.c' }, A2: { target: '#m.right.d' } } },
              b: { on: { B1: { target: '#m.right.c' } } },
            },
          },
          right: {
            initial: 'c',
            states: { c: {}, d: {} },
          },
        },
      }),
    );
  }

  it('draws one edge per pair instead of one per transition', () => {
    // Three transitions all run left -> right once both are closed. Drawing
    // them as three parallel lines between two boxes says nothing extra.
    const { graph, mergedCountById } = collapseGraph(
      crossed(),
      new Set(['m.left', 'm.right']),
    );
    const between = graph.edges.filter(
      (e) => e.sourceId === 'm.left' && e.targetId === 'm.right',
    );
    expect(between).toHaveLength(1);
    expect(mergedCountById.get(between[0].id)).toBe(3);
  });

  it('leaves an unmerged edge uncounted', () => {
    const { graph, mergedCountById } = collapseGraph(crossed(), new Set(['m.right']));
    // left.a -> right and left.b -> right are distinct sources, so neither
    // merges into the other.
    const fromA = graph.edges.find((e) => e.sourceId === 'm.left.b')!;
    expect(mergedCountById.get(fromA.id)).toBeUndefined();
  });

  it('merges per pair, not across pairs', () => {
    const { graph } = collapseGraph(crossed(), new Set(['m.right']));
    const pairs = new Set(graph.edges.map((e) => `${e.sourceId}->${e.targetId}`));
    expect(pairs.size).toBe(graph.edges.length);
  });

  it('counts nothing when nothing is collapsed', () => {
    expect(collapseGraph(crossed(), new Set()).mergedCountById.size).toBe(0);
  });
});

describe('collapsible sets', () => {
  it('lists containers with children, never a root', () => {
    expect(collapsibleIds(nested()).sort()).toEqual([
      'm.region0',
      'm.region0.group0',
      'm.region1',
      'm.region1.group1',
    ]);
  });

  it('picks only the outermost containers for an overview', () => {
    expect(outermostCollapsibleIds(nested()).sort()).toEqual(['m.region0', 'm.region1']);
  });

  it('has nothing to collapse in a flat machine', () => {
    const flat = machineToGraph(
      createMachine({ id: 'm', initial: 'a', states: { a: {}, b: {} } }),
    );
    expect(collapsibleIds(flat)).toEqual([]);
    expect(outermostCollapsibleIds(flat)).toEqual([]);
  });
});
