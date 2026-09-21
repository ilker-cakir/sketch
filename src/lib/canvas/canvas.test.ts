import { describe, expect, it } from 'vitest';
import type { LayoutGraph, LayoutNode, Rect } from '@/lib/layout/types';
import type { MeasureText } from '@/lib/layout/measure';
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  fitToBounds,
  pan,
  rectsIntersect,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
  zoomBy,
  type Camera,
} from './camera';
import { buildScene, hitTestEdge, hitTestNode } from './scene';
import { EDGE_ICON_WIDTH, measureEdgeLabel } from '@/lib/layout/measure';
import type { LayoutEdge } from '@/lib/layout/types';

const fakeMeasure: MeasureText = (text, font) => {
  const size = Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 12);
  return text.length * size * 0.6;
};

const camera: Camera = { x: 100, y: 50, scale: 2 };

function node(
  id: string,
  rect: Rect,
  overrides: Partial<LayoutNode> = {},
): LayoutNode {
  return {
    id,
    parentId: null,
    depth: 0,
    isContainer: false,
    isInitial: false,
    isRegion: false,
    data: {
      key: id,
      type: 'atomic',
      entry: [],
      exit: [],
      invocations: [],
      initialId: null,
    },
    ...rect,
    ...overrides,
  };
}

describe('camera', () => {
  it('round-trips between screen and world space', () => {
    const point = { x: 321, y: 654 };
    const back = screenToWorld(camera, worldToScreen(camera, point));
    expect(back.x).toBeCloseTo(point.x);
    expect(back.y).toBeCloseTo(point.y);
  });

  it('places the camera origin at the viewport corner', () => {
    expect(worldToScreen(camera, { x: 100, y: 50 })).toEqual({ x: 0, y: 0 });
  });

  it('pans in screen pixels regardless of zoom', () => {
    const panned = pan(camera, 20, -10);
    // Dragging right by 20px moves the world origin left by 20/scale.
    expect(panned.x).toBe(100 - 10);
    expect(panned.y).toBe(50 + 5);
  });

  it('keeps the anchored world point fixed while zooming', () => {
    const anchor = { x: 400, y: 300 };
    const before = screenToWorld(camera, anchor);
    const after = screenToWorld(zoomAt(camera, 0.75, anchor), anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('keeps the anchor fixed through a multiplicative zoom too', () => {
    const anchor = { x: 10, y: 800 };
    const before = screenToWorld(camera, anchor);
    const after = screenToWorld(zoomBy(camera, 1.25, anchor), anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps zoom to the supported range', () => {
    expect(clampScale(1e6)).toBe(MAX_SCALE);
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(zoomAt(camera, 1e6, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
  });

  describe('fitToBounds', () => {
    const bounds: Rect = { x: 0, y: 0, width: 1000, height: 500 };

    it('scales so the whole graph fits inside the padding', () => {
      const fitted = fitToBounds(bounds, 600, 400, 20);
      const topLeft = worldToScreen(fitted, bounds);
      const bottomRight = worldToScreen(fitted, {
        x: bounds.x + bounds.width,
        y: bounds.y + bounds.height,
      });
      expect(topLeft.x).toBeGreaterThanOrEqual(20 - 0.001);
      expect(topLeft.y).toBeGreaterThanOrEqual(0);
      expect(bottomRight.x).toBeLessThanOrEqual(600 - 20 + 0.001);
      expect(bottomRight.y).toBeLessThanOrEqual(400);
    });

    it('centres the graph in the viewport', () => {
      const fitted = fitToBounds(bounds, 600, 400, 20);
      const left = worldToScreen(fitted, bounds).x;
      const right =
        600 - worldToScreen(fitted, { x: bounds.width, y: 0 }).x;
      expect(left).toBeCloseTo(right, 5);
    });

    it('survives a degenerate empty graph', () => {
      const fitted = fitToBounds({ x: 0, y: 0, width: 0, height: 0 }, 300, 200);
      expect(Number.isFinite(fitted.x)).toBe(true);
      expect(Number.isFinite(fitted.y)).toBe(true);
      expect(fitted.scale).toBe(1);
    });

    it('never zooms past the maximum for a tiny graph', () => {
      const fitted = fitToBounds({ x: 0, y: 0, width: 1, height: 1 }, 2000, 2000);
      expect(fitted.scale).toBe(MAX_SCALE);
    });
  });

  it('reports the visible world rect', () => {
    const rect = visibleWorldRect(camera, 800, 600);
    expect(rect).toEqual({ x: 100, y: 50, width: 400, height: 300 });
  });

  it('detects rectangle overlap and rejects mere adjacency', () => {
    const a: Rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectsIntersect(a, { x: 50, y: 50, width: 1, height: 1 })).toBe(false);
  });
});

describe('scene', () => {
  const layout: LayoutGraph = {
    width: 1000,
    height: 1000,
    droppedEdgeCount: 2,
    nodes: [
      node('outer', { x: 0, y: 0, width: 400, height: 300 }, {
        isContainer: true,
        depth: 0,
      }),
      node('outer.inner', { x: 50, y: 60, width: 140, height: 40 }, {
        parentId: 'outer',
        depth: 1,
      }),
      node('far', { x: 700, y: 700, width: 140, height: 40 }),
    ],
    edges: [
      {
        id: 'e1',
        sourceId: 'outer.inner',
        targetId: 'far',
        data: {
          eventType: 'GO',
          displayEvent: 'GO',
          guard: null,
          guardPrefix: '',
          actions: [],
          isTargetless: false,
        },
        points: [
          { x: 190, y: 80 },
          { x: 600, y: 80 },
          { x: 600, y: 720 },
          { x: 700, y: 720 },
        ],
        label: null,
        isSelf: false,
      },
    ],
  };

  const scene = buildScene(layout, fakeMeasure);

  it('carries the dropped-edge count through for the UI to surface', () => {
    expect(scene.droppedEdgeCount).toBe(2);
  });

  it('pre-fits header text so drawing never measures', () => {
    const long = buildScene(
      {
        ...layout,
        nodes: [node('x'.repeat(200), { x: 0, y: 0, width: 140, height: 28 })],
        edges: [],
      },
      fakeMeasure,
    );
    expect(long.nodes[0].headerText.endsWith('…')).toBe(true);
    expect(long.nodes[0].headerText.length).toBeLessThan(200);
  });

  it('gives containers no body rows of their own', () => {
    expect(scene.nodeById.get('outer')!.rows).toEqual([]);
  });

  describe('hitTestNode', () => {
    it('returns the deepest node under the point', () => {
      // This point is inside both `outer` and its child.
      expect(hitTestNode(scene, { x: 100, y: 70 })?.id).toBe('outer.inner');
    });

    it('falls back to the container outside the child', () => {
      expect(hitTestNode(scene, { x: 300, y: 250 })?.id).toBe('outer');
    });

    it('returns null over empty space', () => {
      expect(hitTestNode(scene, { x: 500, y: 500 })).toBe(null);
    });
  });

  describe('hitTestEdge', () => {
    it('finds an edge the pointer is near', () => {
      expect(hitTestEdge(scene, { x: 400, y: 82 }, 6)?.id).toBe('e1');
    });

    it('finds a segment far from the edge’s first cell', () => {
      // Guards against indexing only the edge's bounding box or start point.
      expect(hitTestEdge(scene, { x: 601, y: 500 }, 6)?.id).toBe('e1');
    });

    it('returns null beyond the tolerance', () => {
      expect(hitTestEdge(scene, { x: 400, y: 200 }, 6)).toBe(null);
    });

    it('respects the tolerance it is given', () => {
      expect(hitTestEdge(scene, { x: 400, y: 90 }, 4)).toBe(null);
      expect(hitTestEdge(scene, { x: 400, y: 90 }, 20)?.id).toBe('e1');
    });
  });
});

function edge(
  id: string,
  sourceId: string,
  targetId: string,
  data: Partial<LayoutEdge['data']> = {},
): LayoutEdge {
  return {
    id,
    sourceId,
    targetId,
    data: {
      eventType: 'GO',
      displayEvent: 'GO',
      guard: null,
      guardPrefix: '',
      actions: [],
      isTargetless: false,
      ...data,
    },
    points: [],
    label: null,
    isSelf: sourceId === targetId,
  };
}

describe('choice-state detection', () => {
  const build = (edges: LayoutEdge[], data = {}) =>
    buildScene(
      {
        width: 100,
        height: 100,
        droppedEdgeCount: 0,
        nodes: [
          node('pick', { x: 0, y: 0, width: 140, height: 28 }, {
            data: {
              key: 'pick', type: 'atomic', entry: [], exit: [],
              invocations: [], initialId: null, ...data,
            },
          }),
          node('a', { x: 200, y: 0, width: 140, height: 28 }),
          node('b', { x: 200, y: 60, width: 140, height: 28 }),
        ],
        edges,
      },
      fakeMeasure,
    ).nodeById.get('pick')!;

  const guardedAlways = (id: string, target: string, guard: string) =>
    edge(id, 'pick', target, { eventType: '(always)', displayEvent: '', guard });

  it('marks an atomic state whose exits are all guarded always-transitions', () => {
    expect(build([guardedAlways('e1', 'a', 'isNew'), guardedAlways('e2', 'b', 'isOld')]).isChoice)
      .toBe(true);
  });

  it('does not mark a state with a single exit', () => {
    expect(build([guardedAlways('e1', 'a', 'isNew')]).isChoice).toBe(false);
  });

  it('does not mark a state with an unguarded always-transition', () => {
    expect(
      build([
        guardedAlways('e1', 'a', 'isNew'),
        edge('e2', 'pick', 'b', { eventType: '(always)', displayEvent: '', guard: null }),
      ]).isChoice,
    ).toBe(false);
  });

  it('does not mark a state that also reacts to a named event', () => {
    expect(
      build([guardedAlways('e1', 'a', 'isNew'), edge('e2', 'pick', 'b')]).isChoice,
    ).toBe(false);
  });

  it('does not mark a state that invokes something', () => {
    expect(
      build(
        [guardedAlways('e1', 'a', 'isNew'), guardedAlways('e2', 'b', 'isOld')],
        { invocations: ['fetchUser'] },
      ).isChoice,
    ).toBe(false);
  });
});

describe('outgoing edge index', () => {
  it('groups edge ids by source so hover can emphasise them', () => {
    const scene = buildScene(
      {
        width: 100, height: 100, droppedEdgeCount: 0,
        nodes: [
          node('a', { x: 0, y: 0, width: 10, height: 10 }),
          node('b', { x: 20, y: 0, width: 10, height: 10 }),
        ],
        edges: [edge('e1', 'a', 'b'), edge('e2', 'a', 'b'), edge('e3', 'b', 'a')],
      },
      fakeMeasure,
    );
    expect(scene.outEdgeIds.get('a')).toEqual(['e1', 'e2']);
    expect(scene.outEdgeIds.get('b')).toEqual(['e3']);
    expect(scene.outEdgeIds.get('missing')).toBeUndefined();
  });
});

describe('measureEdgeLabel', () => {
  const data = (over: Partial<LayoutEdge['data']>) => edge('e', 'a', 'b', over).data;

  it('sizes a plain event label', () => {
    const label = measureEdgeLabel(data({}), fakeMeasure)!;
    expect(label.text).toBe('GO');
    expect(label.width).toBeGreaterThan(0);
  });

  it('reserves width for the category glyph', () => {
    const plain = measureEdgeLabel(data({ eventType: 'GO' }), fakeMeasure)!;
    const timed = measureEdgeLabel(
      data({ eventType: 'xstate.after(500).s', displayEvent: 'GO' }),
      fakeMeasure,
    )!;
    expect(timed.width).toBeGreaterThan(plain.width);
  });

  it('reserves width for a guard', () => {
    const plain = measureEdgeLabel(data({}), fakeMeasure)!;
    const guarded = measureEdgeLabel(data({ guard: 'isReady' }), fakeMeasure)!;
    expect(guarded.width).toBeGreaterThan(plain.width);
  });

  it('shows no text for an always transition — the glyph carries it', () => {
    // Falling back to `eventType` here would print the literal "(always)".
    const label = measureEdgeLabel(
      data({ eventType: '(always)', displayEvent: '', guard: 'isReady' }),
      fakeMeasure,
    );
    expect(label.text).toBe('');
    expect(label.width).toBeGreaterThan(0);
  });

  it('still reserves a glyph box for an empty event type', () => {
    // An empty event type is an always transition, not a missing label.
    const label = measureEdgeLabel(data({ eventType: '', displayEvent: '' }), fakeMeasure);
    expect(label.text).toBe('');
    expect(label.width).toBeGreaterThanOrEqual(EDGE_ICON_WIDTH);
  });
});

describe('self and targetless transitions', () => {
  const sceneWith = (edges: LayoutEdge[]) =>
    buildScene(
      {
        width: 100, height: 100, droppedEdgeCount: 0,
        nodes: [node('idle', { x: 0, y: 0, width: 140, height: 28 })],
        edges,
      },
      fakeMeasure,
    );

  it('collapses several self transitions into one labelled loop', () => {
    // Drawn per-edge they would all land on the same spot and overdraw into
    // a single unreadable ring.
    const scene = sceneWith([
      edge('e1', 'idle', 'idle', { displayEvent: 'RETRY' }),
      edge('e2', 'idle', 'idle', { displayEvent: 'POKE' }),
    ]);
    expect(scene.selfLoopLabels.size).toBe(1);
    expect(scene.selfLoopLabels.get('idle')).toBe('RETRY, POKE');
  });

  it('includes the guard so two transitions on one event stay distinct', () => {
    const scene = sceneWith([
      edge('e1', 'idle', 'idle', { displayEvent: 'RETRY', guard: 'canRetry' }),
      edge('e2', 'idle', 'idle', { displayEvent: 'RETRY', guard: 'isFatal' }),
    ]);
    expect(scene.selfLoopLabels.get('idle')).toBe('RETRY [canRetry], RETRY [isFatal]');
  });

  it('deduplicates identical entries', () => {
    const scene = sceneWith([
      edge('e1', 'idle', 'idle', { displayEvent: 'RETRY' }),
      edge('e2', 'idle', 'idle', { displayEvent: 'RETRY' }),
    ]);
    expect(scene.selfLoopLabels.get('idle')).toBe('RETRY');
  });

  it('records no loop for a node without self transitions', () => {
    const scene = buildScene(
      {
        width: 100, height: 100, droppedEdgeCount: 0,
        nodes: [
          node('a', { x: 0, y: 0, width: 140, height: 28 }),
          node('b', { x: 200, y: 0, width: 140, height: 28 }),
        ],
        edges: [edge('e1', 'a', 'b')],
      },
      fakeMeasure,
    );
    expect(scene.selfLoopLabels.size).toBe(0);
  });
});
