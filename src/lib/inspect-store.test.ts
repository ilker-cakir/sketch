import { describe, expect, it } from 'vitest';
import type { StatelyInspectionEvent } from '@statelyai/inspect';
import {
  MAX_EVENTS,
  applyInspectionEvent,
  getActiveIds,
  getSelectedActor,
  type InspectState,
} from './inspect-store';

const EMPTY: InspectState = { actors: {}, events: [] };

const MACHINE = JSON.stringify({
  id: 'checkout',
  initial: 'cart',
  states: {
    cart: { on: { GO: 'payment' } },
    payment: { initial: 'details', states: { details: {}, processing: {} } },
  },
});

function actorEvent(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): StatelyInspectionEvent {
  return {
    type: '@xstate.actor',
    _version: '0.0.1',
    rootId: sessionId,
    sessionId,
    name: sessionId,
    definition: MACHINE,
    snapshot: { status: 'active', value: 'cart', context: {} },
    createdAt: String(Date.now()),
    ...overrides,
  } as unknown as StatelyInspectionEvent;
}

function snapshotEvent(sessionId: string, value: unknown): StatelyInspectionEvent {
  return {
    type: '@xstate.snapshot',
    _version: '0.0.1',
    rootId: sessionId,
    sessionId,
    snapshot: { status: 'active', value, context: {} },
    event: { type: 'GO' },
    createdAt: String(Date.now()),
  } as unknown as StatelyInspectionEvent;
}

describe('applyInspectionEvent', () => {
  it('registers an actor and parses its machine into a graph', () => {
    const state = applyInspectionEvent(EMPTY, actorEvent('a'));
    const actor = state.actors.a;
    expect(actor.machine?.id).toBe('checkout');
    expect(actor.graph?.nodes.map((n) => n.id)).toContain('checkout.payment.details');
  });

  it('selects the first actor it sees and keeps that selection', () => {
    let state = applyInspectionEvent(EMPTY, actorEvent('first'));
    state = applyInspectionEvent(state, actorEvent('second'));
    expect(state.selectedSessionId).toBe('first');
    expect(Object.keys(state.actors)).toEqual(['first', 'second']);
  });

  it('keeps the parsed machine across snapshots', () => {
    let state = applyInspectionEvent(EMPTY, actorEvent('a'));
    state = applyInspectionEvent(state, snapshotEvent('a', { payment: 'processing' }));
    expect(state.actors.a.machine?.id).toBe('checkout');
    expect(state.actors.a.graph).toBeDefined();
    expect(state.actors.a.snapshot?.value).toEqual({ payment: 'processing' });
  });

  it('leaves the actor without a graph when the definition will not parse', () => {
    const state = applyInspectionEvent(
      EMPTY,
      actorEvent('bad', { definition: '{ not json' }),
    );
    expect(state.actors.bad.graph).toBeUndefined();
    expect(state.actors.bad.sessionId).toBe('bad');
  });

  it('ignores event types it does not handle', () => {
    const state = applyInspectionEvent(EMPTY, {
      type: '@xstate.unknown',
      _version: '0.0.1',
    } as unknown as StatelyInspectionEvent);
    expect(state).toBe(EMPTY);
  });

  describe('event log', () => {
    it('records actor, snapshot and event entries', () => {
      let state = applyInspectionEvent(EMPTY, actorEvent('a'));
      state = applyInspectionEvent(state, snapshotEvent('a', 'cart'));
      expect(state.events).toHaveLength(2);
    });

    it('caps the log and keeps the most recent entries', () => {
      let state = applyInspectionEvent(EMPTY, actorEvent('a'));
      for (let i = 0; i < MAX_EVENTS + 50; i++) {
        state = applyInspectionEvent(state, snapshotEvent('a', `s${i}`));
      }
      expect(state.events).toHaveLength(MAX_EVENTS);
      const last = state.events[state.events.length - 1];
      expect((last as { snapshot: { value: string } }).snapshot.value).toBe(
        `s${MAX_EVENTS + 49}`,
      );
    });
  });
});

describe('getSelectedActor', () => {
  it('returns the selected actor', () => {
    let state = applyInspectionEvent(EMPTY, actorEvent('a'));
    state = applyInspectionEvent(state, actorEvent('b'));
    state = { ...state, selectedSessionId: 'b' };
    expect(getSelectedActor(state)?.sessionId).toBe('b');
  });

  it('falls back to the first actor when the selection is gone', () => {
    const state = applyInspectionEvent(EMPTY, actorEvent('a'));
    expect(getSelectedActor({ ...state, selectedSessionId: 'missing' })?.sessionId).toBe('a');
  });

  it('returns undefined with no actors', () => {
    expect(getSelectedActor(EMPTY)).toBeUndefined();
  });
});

describe('getActiveIds', () => {
  it('prefers _nodes when the snapshot carries them', () => {
    const ids = getActiveIds(
      { _nodes: [{ id: 'x.a' }, { id: 'x.b' }] } as never,
      'x',
    );
    expect([...ids].sort()).toEqual(['x.a', 'x.b']);
  });

  it('derives ids from a string state value', () => {
    const ids = getActiveIds({ value: 'cart' } as never, 'checkout');
    expect([...ids].sort()).toEqual(['checkout', 'checkout.cart']);
  });

  it('walks a nested state value', () => {
    const ids = getActiveIds({ value: { payment: 'processing' } } as never, 'checkout');
    expect([...ids].sort()).toEqual([
      'checkout',
      'checkout.payment',
      'checkout.payment.processing',
    ]);
  });

  it('covers every region of a parallel state value', () => {
    const ids = getActiveIds(
      { value: { dialog: 'idle', form: { field: 'editing' } } } as never,
      'conv',
    );
    expect([...ids].sort()).toEqual([
      'conv',
      'conv.dialog',
      'conv.dialog.idle',
      'conv.form',
      'conv.form.field',
      'conv.form.field.editing',
    ]);
  });

  it('returns nothing without a snapshot or a root id', () => {
    expect(getActiveIds(undefined, 'x').size).toBe(0);
    expect(getActiveIds({ value: 'cart' } as never, undefined).size).toBe(0);
  });
});
