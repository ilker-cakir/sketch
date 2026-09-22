import { describe, expect, it, beforeEach } from 'vitest';
import { createMachine } from 'xstate';
import { machineToGraph } from '@/lib/machine';
import { layoutMachine, resetLayoutClient } from './client';
import type { MeasureText } from './measure';

const measureText: MeasureText = (text, font) => {
  const size = Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 12);
  return text.length * size * 0.6;
};

const machine = (target: string) =>
  machineToGraph(
    createMachine({
      id: 'm',
      initial: 'a',
      states: {
        a: { on: { GO: { target } } },
        b: { on: { BACK: { target: 'a' } } },
      },
    }),
  );

describe('layoutMachine caching', () => {
  beforeEach(() => {
    resetLayoutClient();
  });

  it('reuses one layout for two separately built copies of a machine', async () => {
    // The live case this exists for: an actor reconnects under a new session
    // id, so the graph object is new but the definition is not.
    const first = await layoutMachine(machine('b'), { measureText });
    const second = await layoutMachine(machine('b'), { measureText });
    expect(second).toBe(first);
  });

  it('joins a request already in flight rather than laying out twice', async () => {
    const [first, second] = await Promise.all([
      layoutMachine(machine('b'), { measureText }),
      layoutMachine(machine('b'), { measureText }),
    ]);
    expect(second).toBe(first);
  });

  it('does not serve one machine the layout of another', async () => {
    const first = await layoutMachine(machine('b'), { measureText });
    const other = await layoutMachine(machine('a'), { measureText });
    expect(other).not.toBe(first);
  });

  it('lays out a machine correctly on a cache miss', async () => {
    const layout = await layoutMachine(machine('b'), { measureText });
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['m', 'm.a', 'm.b']);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.edges.every((e) => e.points.length > 0 || e.isSelf)).toBe(true);
  });
});
