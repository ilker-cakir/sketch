# High-performance node graph for live inspection

Date: 2026-09-21
Status: implemented

## Problem

Sketch renders an XState machine as nested DOM divs: `MachineViz` → `StateNodeViz`
(recursive) → `TransitionViz`. Layout is CSS flex-wrap. There are no drawn edges —
transitions are inline text rows inside their source node. Nothing is memoized.

In live inspect mode (`src/routes/inspect.tsx`) every `@xstate.snapshot` event
re-renders the whole tree. For the target workload this is roughly 700 component
renders per keystroke, plus two O(n) `graph.nodes.find` scans per edge in
`getRelativeTarget` (`src/lib/machine.ts:265`) — about 118k array comparisons per
full render.

## Target workload

`@wkda/conversational-carlead-new`'s conversation machine, measured from
`final-initial-state-machine.js` (705 KB):

| Property | Value |
| --- | --- |
| State nodes | 99 (1 parallel root, 22 compound, 75 atomic, 1 final) |
| Transitions | 596 (440 resolvable to an in-graph target) |
| Nesting depth | 3 |
| Snapshot rate | one per user keystroke / transition |

The flow is config-driven, so state count grows with field count.

## Measurements

Taken on the real machine with elkjs, `layered` + `ORTHOGONAL` +
`hierarchyHandling: INCLUDE_CHILDREN`. The first column is an early probe with
uniform node sizes and unlabelled edges; the second is the shipped pipeline,
with measured node sizes, sized edge labels and container padding.

| Measurement | Early probe | Shipped pipeline |
| --- | --- | --- |
| ELK layout time | 232–470 ms | **318 ms** |
| `fromElk` + `buildScene` | — | 2 ms |
| Laid-out world size | 3961 × 9111 px | 3163 × 6255 px |
| Dropped edges | — | 0 |

Two layout options were measured but not adopted: `considerModelOrder=NONE`
takes 186 ms but loses declaration-order stability, and `SEPARATE_CHILDREN`
takes 73 ms but routes cross-boundary edges only at the top level. 318 ms once
per actor is well within budget, so readability wins.

Built client chunks:

| Chunk | Raw | Gzipped |
| --- | --- | --- |
| `layout.worker` (elkjs) | 1.4 MB | 428 KB |
| `elk.bundled` (main-thread fallback) | 1.4 MB | 428 KB |
| `inspect` route | 55 KB | 18 KB |

Both elkjs chunks are loaded only when the Visualization tab is opened, and
only one of the two is ever fetched in a given session.

Two conclusions follow directly.

**Layout is expensive and snapshot-independent.** 300 ms cannot run on the main
thread, and must never re-run on a keystroke. Layout is a pure function of the
machine *definition*, so it is computed once per actor in a Worker and cached.

**Drawing is cheap; React is not.** 99 rects + 2.3k segments + ~540 labels is a
few milliseconds on Canvas 2D, well below the ~5–10k element point where WebGL
starts to win (Horak et al., "Comparing Rendering Performance of Common Web
Technologies for Large Graphs"). The win comes from removing snapshots from the
React path, not from the GPU.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Placement | Its own `/visualize` route, beside `/inspect` | Two addressable modes you can move between, rather than one route with a hidden toggle. |
| Scope | Live inspection only | Editor route `/` keeps the nested-DOM renderer. |
| Interactivity | Pan, zoom, fit, hover highlight, click-to-select, live active highlighting | No editing, no node dragging. |
| Layout engine | elkjs `layered`, in a Worker | Only mainstream engine with compound/hierarchical layout + orthogonal routing with bend points. dagre is deprecated and does not nest; d3-dag does not nest. |
| Render target | Canvas 2D, retained scene | Sufficient to ~5k elements; no SDF text, picking buffers or large dependency. Draw call can be swapped for WebGL later without touching layout, scene or interaction. |

### Route wiring

The graph lives at `/visualize`; `/inspect` keeps its original layout
unchanged — the nested-DOM renderer in the main pane and the
Actors/Sequence/Events sidebar. A shared `InspectHeader` puts an
`Inspect | Visualize` nav on both.

Both routes read one module-level store, `src/lib/inspect-store.ts`, which owns
the `createBrowserReceiver` subscription, the actor map, the bounded event log
and the selected actor. Putting it at module scope rather than in a route
component is what makes switching work: navigating between the two does not
tear down the receiver, drop the actor list, or need the inspector to
reconnect. React reads it through `useSyncExternalStore`.

Either URL can be given to `createBrowserInspector`.

## Architecture

```
MachineGraph ──▶ measure ──▶ to-elk ──▶ [Worker: elkjs] ──▶ from-elk ──▶ LayoutGraph
                                                                             │
                                                               buildScene ◀──┘
                                                                     │
                                               Scene + spatial index │
                                                                     ▼
                                     camera ──▶ renderer ──▶ <canvas>
                                         ▲          ▲
                                    interaction   activeIds
```

### Units

Each has one purpose, a small interface, and is testable in isolation.

| Unit | File | Responsibility | Depends on |
| --- | --- | --- | --- |
| Measure | `src/lib/layout/measure.ts` | `StateNodeData → {width, height}` using a cached `measureText`. Pure, no DOM mutation. | — |
| To-ELK | `src/lib/layout/to-elk.ts` | `MachineGraph → ElkNode` tree. Nests children, hoists each edge into its endpoints' lowest common ancestor container, drops dangling edges, attaches per-node layout options. | `@statelyai/graph` queries |
| Worker | `src/lib/layout/layout.worker.ts` | Lazy-imports elkjs, runs `elk.layout`, posts the result back. | elkjs |
| Layout client | `src/lib/layout/client.ts` | Spawns the worker, tags requests with an id, drops stale results, caches by actor `sessionId`, falls back to main-thread layout on worker failure. | worker |
| From-ELK | `src/lib/layout/from-elk.ts` | ELK result → `LayoutGraph` with **absolute** coordinates. See *ELK coordinate convention* below. Highest-risk logic in the change. | — |
| Scene | `src/lib/canvas/scene.ts` | Draw-ready flat arrays plus a uniform spatial grid (~256px cells) indexing nodes and edge segments for hit-testing. | — |
| Camera | `src/lib/canvas/camera.ts` | Pan, zoom about a point, fit-to-bounds, screen↔world transforms. | — |
| Renderer | `src/lib/canvas/renderer.ts` | `draw(ctx, scene, camera, ui)`. Viewport culling, zoom LOD, device-pixel-ratio handling. | scene, camera |
| Interaction | `src/lib/canvas/interaction.ts` | Pointer and wheel events → camera updates and hit-test results. | scene, camera |
| Canvas component | `src/components/GraphCanvas.tsx` | Owns the `<canvas>` ref, mounts the renderer, exposes an imperative handle (`setActive`, `fit`, `zoomTo`). Renders once. | renderer, interaction |
| Panel component | `src/components/GraphPanel.tsx` | Wires `/inspect` state to `GraphCanvas`. Loading, empty and error states. Toolbar: fit, zoom in/out, reset. | GraphCanvas, layout client |

### ELK coordinate convention

Node coordinates are relative to the parent node. **Edge** coordinates are
relative to the lowest common ancestor of the edge's endpoints — *not* the node
whose `edges` array holds the edge, because ELK normalises edge containment
during hierarchical layout.

The distinction only shows up for an edge between a container and its own
descendant, where the LCA is the container itself. Getting it wrong displaces
exactly those edges by the container's offset while every other edge looks
correct: in the traffic-light fixture, `trafficLight.red → trafficLight.red.flash`
landed 307 px from its source. `toElk` therefore records the LCA per edge in
`edgeOriginById`, and `fromElk` adds back that node's absolute position rather
than the position of wherever the edge turned up in the output tree.

The `fromElk` test asserts the invariant directly: every routed edge's first
point lies within 2 px of its source box and its last point within 2 px of its
target box.

### Why not `@statelyai/graph/elk`

The package ships an ELK converter, but `toELK` sets no node sizes and no layout
options, and `fromELK` discards node `data` and every edge `section`
(`dist/formats/elk/index.mjs:96-118`) — precisely the bend points the renderer
needs. We use its graph queries (`getChildren`, `getOutEdges`, `getRoots`) and
write our own conversion.

## Update strategy

Two paths at very different frequencies.

**Definition change** — on `@xstate.actor`, rare:

```
measure → to-elk → worker layout (~300ms, off main thread) → from-elk → buildScene
```

Cached by actor `sessionId`. Stale responses dropped by request id.

**Snapshot** — on `@xstate.snapshot`, every keystroke:

```
getActiveIds(snapshot) → handle.setActive(ids) → mark dirty → one rAF → draw
```

No layout, no scene rebuild, no React subtree. `GraphPanel` is a single component
that re-renders per snapshot and pushes ids through a ref in a `useEffect`; one
cheap component render replaces today's ~700. Redraws are rAF-coalesced, so a
burst of snapshots within one frame costs one draw.

`getActiveIds` in `src/routes/inspect.tsx` keeps its current behaviour: inspection
events carry a serialized snapshot (`status`/`value`/`context`) with no `_nodes`,
so active ids are derived from `snapshot.value` plus the machine root id.

## What is drawn

Information parity with the Stately visualizer:

- Compound and parallel states as containers with children nested inside
  (ELK `hierarchyHandling: INCLUDE_CHILDREN`).
- Node header: state key plus the existing type affordances — initial arrow,
  parallel bars, final double border, history `H` / `H*`, choice diamond.
- Node body rows: description, invoke, entry, exit.
- Edges: orthogonal polylines with arrowheads, labelled with `displayEvent` and
  guard, positioned at ELK's computed label position.
- Self-transitions and targetless transitions: loop glyph on the node.
- Active states: the existing `primary` colour token, read from CSS custom
  properties so dark mode continues to work.

The canvas deliberately mirrors the DOM renderer's visual language rather than
inventing its own:

| Element | Treatment |
| --- | --- |
| Node card | 1.75px border, rounded, drop shadow, `card` fill — `border-2` in the DOM |
| Container | Translucent `foreground` wash that lightens with depth |
| Parallel region | Dashed border |
| Final state | Concentric inner ring (the DOM's `border-double`) |
| Initial state | Filled dot and stub |
| Choice state | Rotated square, detected the same way `StateNodeViz` does |
| History state | Boxed `H` / `H*` |
| Active leaf | Primary border and 13% primary fill |
| Active ancestor | Primary border at reduced opacity — it is only on the path |
| Entry / exit | Two clipped columns with a divider |
| Transition label | Bordered pill with a category glyph, event name, and guard in primary |
| Self / targetless | Arrowed loop above the node's top-right corner |
| Background | Faint dot grid, so panning empty space still reads as movement |

Hovering a node draws its outgoing transitions at full strength and fades the
rest, the canvas equivalent of the DOM renderer's hover highlighting.

### Zoom level-of-detail

| Zoom scale | Drawn |
| --- | --- |
| `< 0.35` | Node rects and edge lines only |
| `0.35 – 0.7` | Plus node key labels |
| `≥ 0.7` | Plus body rows, edge labels, arrowheads |

With viewport culling on a 3961×9111 world, a typical frame draws a few dozen
nodes rather than 99.

## Error handling

| Condition | Behaviour |
| --- | --- |
| Worker cannot spawn, or elkjs fails to load | Fall back to main-thread layout; log once. Never a blank pane. |
| Actor switched while a layout is in flight | Request ids; late results discarded. |
| Edge referencing a non-existent node | `to-elk` drops it and reports the count as a subtle badge. ELK throws on these — observed with `Referenced shape does not exist: #conversation.dialog.editRouter`. |
| No machine definition | Existing empty state. |
| No 2D canvas context | Message in the pane; the DOM viz stays reachable via the tab. |

## Event buffer cap

The `/inspect` reducer appends every inspection event to an unbounded
`state.events` array, and the Events and Sequence sidebars render all of them. At
keystroke-rate snapshots this grows without limit and re-renders the full list
each time, bottlenecking the session regardless of canvas speed.

`inspectReducer` keeps the most recent **500** events in a ring buffer; older
events drop. This is an observable behaviour change: the Events panel no longer
shows unbounded history.

Virtualizing the sidebar lists is **not** included, and remains a known
bottleneck if 500 rows proves too slow to re-render.

## Testing

### Vitest — pure, no DOM

| Target | Assertions |
| --- | --- |
| `from-elk` | Relative→absolute accumulation for nested children and for edge sections. Highest-value tests in the change. |
| `to-elk` | Hierarchy preserved; edges hoisted to the LCA container; self-edges handled; dangling edges dropped and counted. |
| `camera` | screen↔world round-trip; fit-to-bounds; zoom about a point. |
| `scene` | Hit-test returns the deepest node under a point; returns an edge within tolerance. |
| `measure` | Deterministic size as a function of content. |

Fixtures: the existing `trafficLight` default machine (nested states and a
cross-boundary transition) and a small machine carrying both a self-targeted
and a targetless transition.

Note that `final-initial-state-machine.js` in the funnel repo is a raw
`machine.definition` dump, which `createMachine` rejects (`initial` is an object,
not a state key). It is unusable as a fixture. This is not a limitation of the
live path: `@statelyai/inspect` sends `actorRef.logic.config`, a real machine
config, which `parseMachine` loads correctly.

### Playwright — `e2e/inspect-graph.spec.ts`

`createBrowserReceiver` is a plain `window` `message` listener
(`@statelyai/inspect/dist/index.mjs:237`), so the route can be driven from the
test with `page.evaluate(() => window.postMessage({ type: '@xstate.actor', ... }))`.
The spec asserts the Visualization tab switches the main pane, the canvas mounts,
and active-state highlighting updates when a synthetic snapshot arrives.

### Regression safety

All 8 existing e2e specs exercise `/`, which this change does not touch. The hooks
`machine-root`, `machine-name`, `root-transitions` and `data-sim-active` are
unchanged. The canvas gets its own `data-testid="graph-canvas"`.

## Out of scope

- Editor route `/` — keeps the nested-DOM renderer.
- Node dragging and graph editing.
- WebGL rendering.
- Persisting camera position across reloads.
- Virtualizing the Events and Sequence sidebar lists.

## Constraint

This is a local clone of someone else's OSS repo. Changes stay local. No upstream
PR — their README asks for issues, not AI-generated PRs.
