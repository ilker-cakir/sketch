import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { createMachine } from 'xstate';
import { machineToGraph, parseXStateMachineCode, defaultMachineCode } from '@/lib/machine';
import type { MachineGraph } from '@/lib/machine';
import { measureNode, truncateToWidth, type MeasureText } from './measure';
import { lowestCommonAncestor, toElk } from './to-elk';
import { fromElk } from './from-elk';
import type { LayoutGraph, LayoutNode } from './types';

/** Deterministic stand-in for canvas text measurement. */
const fakeMeasure: MeasureText = (text, font) => {
  const size = Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 12);
  return text.length * size * 0.6;
};

function trafficLightGraph(): MachineGraph {
  const { machines, error } = parseXStateMachineCode(defaultMachineCode);
  if (error) throw new Error(error);
  return machineToGraph(machines[0]);
}

/** A machine with both a self-targeted and a targetless transition. */
function selfLoopMachine() {
  return createMachine({
    id: 's',
    initial: 'idle',
    states: {
      idle: {
        on: {
          RETRY: { target: 'idle' },
          PING: { actions: [] },
          GO: { target: 'done' },
        },
      },
      done: { type: 'final' },
    },
  });
}

async function layout(graph: MachineGraph): Promise<LayoutGraph> {
  const built = toElk(graph, fakeMeasure);
  const elk = new ELK();
  const result = await elk.layout(built.root);
  return fromElk(result, graph, {
    selfEdgeIds: built.selfEdgeIds,
    droppedEdgeCount: built.droppedEdgeCount,
    edgeOriginById: built.edgeOriginById,
  });
}

const byId = (g: LayoutGraph) => new Map(g.nodes.map((n) => [n.id, n]));

/** Distance from a point to the edge of a rect; 0 when inside. */
function distanceToRect(
  p: { x: number; y: number },
  r: LayoutNode,
): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

describe('measureNode', () => {
  it('sizes a node from its key and clamps to the minimum width', () => {
    const metrics = measureNode(
      { key: 'a', type: 'atomic', entry: [], exit: [], invocations: [], initialId: null },
      fakeMeasure,
    );
    expect(metrics.width).toBe(140);
    expect(metrics.rows).toEqual([]);
    expect(metrics.height).toBe(metrics.headerHeight);
  });

  it('adds a row per content section and grows the header', () => {
    const bare = measureNode(
      { key: 'x', type: 'atomic', entry: [], exit: [], invocations: [], initialId: null },
      fakeMeasure,
    );
    const full = measureNode(
      {
        key: 'x',
        type: 'atomic',
        description: 'does a thing',
        entry: ['onEnter'],
        exit: ['onExit'],
        invocations: ['fetchUser'],
        initialId: null,
      },
      fakeMeasure,
    );
    expect(full.rows.map((r) => r.kind)).toEqual(['description', 'invoke', 'actions']);
    expect(full.headerHeight).toBe(bare.headerHeight + 3 * 18);
  });

  it('sizes an entry+exit row for two side-by-side columns', () => {
    // The renderer splits the row in half, so a node sized for only the wider
    // column lets the two lists overlap.
    const base = {
      key: 'x', type: 'atomic' as const, entry: [], exit: [],
      invocations: [], initialId: null,
    };
    const entryOnly = measureNode({ ...base, entry: ['trackCartView'] }, fakeMeasure);
    const both = measureNode(
      { ...base, entry: ['trackCartView'], exit: ['persistCart'] },
      fakeMeasure,
    );
    expect(both.width).toBeGreaterThanOrEqual(entryOnly.width * 2 - 2 * 10 * 2);
    expect(both.width).toBeGreaterThan(entryOnly.width);
  });

  it('never exceeds the maximum width', () => {
    const metrics = measureNode(
      {
        key: 'a'.repeat(400),
        type: 'atomic',
        entry: [],
        exit: [],
        invocations: [],
        initialId: null,
      },
      fakeMeasure,
    );
    expect(metrics.width).toBe(320);
  });
});

describe('truncateToWidth', () => {
  it('leaves text that already fits untouched', () => {
    expect(truncateToWidth('short', '12px x', 1000, fakeMeasure)).toBe('short');
  });

  it('ellipsises to fit and never returns something wider than the budget', () => {
    const out = truncateToWidth('abcdefghijklmnop', '10px x', 40, fakeMeasure);
    expect(out.endsWith('…')).toBe(true);
    expect(fakeMeasure(out, '10px x')).toBeLessThanOrEqual(40);
  });
});

describe('lowestCommonAncestor', () => {
  const parents = new Map<string, string | null>([
    ['root', null],
    ['a', 'root'],
    ['a.1', 'a'],
    ['a.2', 'a'],
    ['b', 'root'],
    ['b.1', 'b'],
  ]);

  it('finds the nearest shared container for siblings', () => {
    expect(lowestCommonAncestor(parents, 'a.1', 'a.2')).toBe('a');
  });

  it('walks up across branches', () => {
    expect(lowestCommonAncestor(parents, 'a.1', 'b.1')).toBe('root');
  });

  it('returns the ancestor itself when one contains the other', () => {
    expect(lowestCommonAncestor(parents, 'a', 'a.1')).toBe('a');
  });

  it('returns null when the nodes share no ancestor', () => {
    const disjoint = new Map<string, string | null>([['x', null], ['y', null]]);
    expect(lowestCommonAncestor(disjoint, 'x', 'y')).toBe(null);
  });
});

describe('toElk', () => {
  it('mirrors the statechart hierarchy', () => {
    const { root } = toElk(trafficLightGraph(), fakeMeasure);
    const machine = root.children?.[0];
    expect(machine?.id).toBe('trafficLight');
    const red = machine?.children?.find((c) => c.id === 'trafficLight.red');
    expect(red?.children?.map((c) => c.id)).toContain('trafficLight.red.flash');
  });

  it('reserves top padding for a container’s own header', () => {
    const { root, metrics } = toElk(trafficLightGraph(), fakeMeasure);
    const red = root.children?.[0]?.children?.find(
      (c) => c.id === 'trafficLight.red',
    );
    const headerHeight = metrics.get('trafficLight.red')!.headerHeight;
    expect(red?.layoutOptions?.['elk.padding']).toContain(`top=${headerHeight + 14}`);
  });

  it('withholds self and targetless transitions from ELK', () => {
    const graph = machineToGraph(selfLoopMachine());
    const selfEdges = graph.edges.filter((e) => e.sourceId === e.targetId);
    expect(selfEdges).toHaveLength(2); // one self-targeted, one targetless

    const { selfEdgeIds, root } = toElk(graph, fakeMeasure);
    for (const edge of selfEdges) expect(selfEdgeIds.has(edge.id)).toBe(true);

    const declared: string[] = [];
    (function visit(node: typeof root) {
      for (const e of node.edges ?? []) declared.push(e.id);
      for (const c of node.children ?? []) visit(c);
    })(root);
    for (const edge of selfEdges) expect(declared).not.toContain(edge.id);
  });

  it('drops edges pointing outside the node set and counts them', () => {
    const graph = trafficLightGraph();
    graph.edges.push({
      type: 'edge',
      id: 'dangling',
      sourceId: 'trafficLight.green',
      targetId: '#nope.does.not.exist',
      label: 'X',
      data: graph.edges[0].data,
    } as (typeof graph.edges)[number]);

    const { droppedEdgeCount, root } = toElk(graph, fakeMeasure);
    expect(droppedEdgeCount).toBe(1);
    const allIds = JSON.stringify(root);
    expect(allIds).not.toContain('does.not.exist');
  });

  it('declares every edge on the lowest common ancestor of its endpoints', () => {
    const graph = trafficLightGraph();
    const { root, edgeOriginById } = toElk(graph, fakeMeasure);

    const declaredIn = new Map<string, string | null>();
    (function visit(node: typeof root, id: string | null) {
      for (const e of node.edges ?? []) declaredIn.set(e.id, id);
      for (const c of node.children ?? []) visit(c, c.id);
    })(root, null);

    expect(declaredIn.size).toBeGreaterThan(0);
    for (const [edgeId, container] of declaredIn) {
      expect(container).toBe(edgeOriginById.get(edgeId) ?? null);
    }

    // A container→descendant edge lands on the container itself, not its
    // parent: ELK reports such an edge's geometry relative to the container.
    expect(declaredIn.get('trafficLight.red:EMERGENCY:0')).toBe('trafficLight.red');
  });
});

describe('fromElk', () => {
  it('resolves nested node coordinates to absolute world space', async () => {
    const graph = trafficLightGraph();
    const laid = await layout(graph);
    const nodes = byId(laid);

    const red = nodes.get('trafficLight.red')!;
    const flash = nodes.get('trafficLight.red.flash')!;

    // A child must sit strictly inside its container once coordinates are absolute.
    expect(flash.x).toBeGreaterThanOrEqual(red.x);
    expect(flash.y).toBeGreaterThanOrEqual(red.y);
    expect(flash.x + flash.width).toBeLessThanOrEqual(red.x + red.width);
    expect(flash.y + flash.height).toBeLessThanOrEqual(red.y + red.height);
  });

  it('clears the container header so children never overlap it', async () => {
    const laid = await layout(trafficLightGraph());
    const nodes = byId(laid);
    const red = nodes.get('trafficLight.red')!;
    for (const child of laid.nodes.filter((n) => n.parentId === 'trafficLight.red')) {
      expect(child.y).toBeGreaterThan(red.y);
    }
  });

  it('anchors every routed edge to its source and target boxes', async () => {
    const graph = trafficLightGraph();
    const laid = await layout(graph);
    const nodes = byId(laid);

    const routed = laid.edges.filter((e) => !e.isSelf && e.points.length > 0);
    expect(routed.length).toBeGreaterThan(0);

    for (const edge of routed) {
      const source = nodes.get(edge.sourceId)!;
      const target = nodes.get(edge.targetId)!;
      const first = edge.points[0];
      const last = edge.points[edge.points.length - 1];
      // Tolerance covers ELK's port offsets and arrowhead insets.
      expect(distanceToRect(first, source)).toBeLessThan(2);
      expect(distanceToRect(last, target)).toBeLessThan(2);
    }
  });

  it('keeps edge labels inside the laid-out canvas', async () => {
    const laid = await layout(trafficLightGraph());
    const labelled = laid.edges.filter((e) => e.label);
    expect(labelled.length).toBeGreaterThan(0);
    for (const edge of labelled) {
      expect(edge.label!.x).toBeGreaterThanOrEqual(0);
      expect(edge.label!.y).toBeGreaterThanOrEqual(0);
      expect(edge.label!.x).toBeLessThanOrEqual(laid.width);
      expect(edge.label!.y).toBeLessThanOrEqual(laid.height);
    }
  });

  it('marks containers, initial states and parallel regions', async () => {
    const machine = createMachine({
      id: 'p',
      type: 'parallel',
      states: {
        one: { initial: 'a', states: { a: {}, b: {} } },
        two: { initial: 'c', states: { c: {} } },
      },
    });
    const laid = await layout(machineToGraph(machine));
    const nodes = byId(laid);

    expect(nodes.get('p')!.isContainer).toBe(true);
    expect(nodes.get('p.one')!.isRegion).toBe(true);
    expect(nodes.get('p.one.a')!.isInitial).toBe(true);
    expect(nodes.get('p.one.b')!.isInitial).toBe(false);
    expect(nodes.get('p.one.a')!.isRegion).toBe(false);
    expect(nodes.get('p.one.a')!.depth).toBe(2);
  });

  it('retains self transitions with no routed geometry', async () => {
    const laid = await layout(machineToGraph(selfLoopMachine()));
    const selfEdges = laid.edges.filter((e) => e.isSelf);
    expect(selfEdges.length).toBeGreaterThan(0);
    for (const edge of selfEdges) {
      expect(edge.points).toEqual([]);
      expect(edge.sourceId).toBe(edge.targetId);
    }
  });

  it('paints containers before their children', async () => {
    const laid = await layout(trafficLightGraph());
    const depths = laid.nodes.map((n) => n.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
  });
});
