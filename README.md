# Stately Sketch

Stately Sketch is a simple, responsive state machine visualizer and simulator for XState.

<img width="2306" height="1523" alt="localhost_3000_ (3)" src="https://github.com/user-attachments/assets/61cae159-b6bd-49b5-b9e3-3dd9ac9e65f4" />

## What It Does

- Visualizes nested XState machines as responsive diagrams
- Simulates transitions, guards, and delayed events
- Lets you edit machine code and see updates immediately
- Supports XState code, Sketch DSL, JSON, YAML, and Mermaid input

## Run It Locally

```bash
# Install dependencies
pnpm install

# Run it
pnpm dev
```

Open [`http://localhost:3000`](http://localhost:3000)

## Try Inspector Locally

<!-- local inspect example command from examples/inspect/package.json -->

```bash
cd examples/inspect
npm start
```

This starts Sketch at [`http://127.0.0.1:3000/inspect`](http://127.0.0.1:3000/inspect), opens the example app, and streams `@statelyai/inspect` events to Sketch.

## Run Checks

```bash
pnpm test # runs unit tests
pnpm test:e2e # runs Playwright E2E tests
pnpm build 
```

## Open Source

Issues and (non AI-generated) pull requests are welcome. Start with `CONTRIBUTING.md`, use the issue templates, and keep changes scoped and well-tested. 

> [!IMPORTANT]
> Open an issue with context/prompt instead of opening an AI-generated PR. I can run Codex/Claude/etc myself.

## License

MIT
