import { describe, expect, it } from 'vitest';
import { createMachine } from 'xstate';
import { machineToGraph, type MachineGraph } from '@/lib/machine';
import {
  hashGraph,
  readPersistedLayout,
  writePersistedLayout,
} from './cache';
import type { LayoutGraph } from './types';

const build = (config: Parameters<typeof createMachine>[0]): MachineGraph =>
  machineToGraph(createMachine(config));

const base = {
  id: 'm',
  initial: 'a',
  states: {
    a: { description: 'first', entry: ['track'], on: { GO: { target: 'b' } } },
    b: { on: { BACK: { target: 'a' } } },
  },
} as const;

describe('hashGraph', () => {
  it('is stable across rebuilds of the same machine', () => {
    // The point of the cache: a reconnecting actor gets the same digest.
    expect(hashGraph(build(base))).toBe(hashGraph(build(base)));
  });

  it.each([
    [
      'a renamed state',
      base,
      {
        id: 'm',
        initial: 'renamed',
        states: {
          renamed: { ...base.states.a, on: { GO: { target: 'b' } } },
          b: { on: { BACK: { target: 'renamed' } } },
        },
      },
    ],
    [
      'a changed description',
      base,
      { ...base, states: { ...base.states, a: { ...base.states.a, description: 'changed' } } },
    ],
    [
      'a changed entry action',
      base,
      { ...base, states: { ...base.states, a: { ...base.states.a, entry: ['other'] } } },
    ],
    [
      'a retargeted transition',
      base,
      { ...base, states: { ...base.states, a: { ...base.states.a, on: { GO: { target: 'a' } } } } },
    ],
    [
      'an added state',
      base,
      { ...base, states: { ...base.states, c: {} } },
    ],
  ])('changes for %s', (_label, left, right) => {
    expect(hashGraph(build(left as never))).not.toBe(
      hashGraph(build(right as never)),
    );
  });

  it('separates layouts computed with different options', () => {
    const graph = build(base);
    expect(hashGraph(graph, '{"direction":"RIGHT"}')).not.toBe(
      hashGraph(graph, '{"direction":"DOWN"}'),
    );
  });

  it('produces a short key safe to use as a store key', () => {
    expect(hashGraph(build(base))).toMatch(/^[0-9a-z]+$/);
  });
});

describe('persistence without IndexedDB', () => {
  // Node has no IndexedDB, which is the same situation as a browser in private
  // mode or with storage blocked: the cache must degrade to a no-op rather
  // than take the graph down with it.
  it('reads as a miss', async () => {
    await expect(readPersistedLayout('nope')).resolves.toBeNull();
  });

  it('writes without throwing', async () => {
    const layout: LayoutGraph = {
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
      droppedEdgeCount: 0,
    };
    await expect(writePersistedLayout('nope', layout)).resolves.toBeUndefined();
  });
});
