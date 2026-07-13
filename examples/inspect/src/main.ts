import { createBrowserInspector } from '@statelyai/inspect';
import { assign, createActor, createMachine } from 'xstate';

const inspector = createBrowserInspector({
  url: 'http://127.0.0.1:3000/inspect',
});

const machine = createMachine({
  id: 'trafficLight',
  initial: 'green',
  context: {
    count: 0,
  },
  states: {
    green: {
      on: { TOGGLE: { target: 'yellow', actions: 'increment' } },
    },
    yellow: {
      on: { TOGGLE: { target: 'red', actions: 'increment' } },
    },
    red: {
      on: { TOGGLE: { target: 'green', actions: 'increment' } },
    },
  },
}).provide({
  actions: {
    increment: assign({
      count: ({ context }) => context.count + 1,
    }),
  },
});

let actor = createActor(machine, { inspect: inspector.inspect });
const snapshotEl = document.querySelector<HTMLPreElement>('#snapshot')!;

function render() {
  snapshotEl.textContent = JSON.stringify(actor.getSnapshot(), null, 2);
}

function startActor() {
  actor = createActor(machine, { inspect: inspector.inspect });
  actor.subscribe(render);
  actor.start();
  render();
}

document.querySelector<HTMLButtonElement>('#toggle')!.addEventListener('click', () => {
  const event = { type: 'TOGGLE' };
  inspector.event(actor, event);
  actor.send(event);
  inspector.snapshot(actor, actor.getSnapshot(), { event });
});

document.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => {
  actor.stop();
  startActor();
});

startActor();
