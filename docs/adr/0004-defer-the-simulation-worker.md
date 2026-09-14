# ADR-0004: Defer the Web Worker behind a SimHost interface

**Status:** Accepted — 2026-09-13
**Relates to:** `ARCHITECTURE.md` §5

## Context

The brief puts the simulation in a dedicated Web Worker from Phase 3, with the rule that
"the main rendering thread must NEVER run simulation logic directly."

That rule is right. The thread boundary is not what enforces it.

## Decision

Define `SimHost` with two implementations — `DirectSimHost` (main thread) and
`WorkerSimHost` — and develop against direct through Phase 5. Flip when profiling shows
pathfinding spikes causing frame jank.

The brief's actual goal is achieved from **Phase 0** rather than Phase 3, by two mechanisms
that do not need a worker:

1. **ESLint import boundaries.** `src/sim/**` cannot import `pixi.js` or anything from
   `src/render/**`. Render and UI read the snapshot and event list, never the world.
2. **Dev-mode `structuredClone()`** on every command and snapshot crossing `DirectSimHost`,
   so a shared-reference leak fails immediately instead of at flip time.

## Correcting two premises

- **A Web Worker needs no COOP/COEP headers.** Those are a `SharedArrayBuffer` requirement.
  Transferable `ArrayBuffer`s give zero-copy `postMessage` with no cross-origin isolation.
  The eventual flip is cheaper than usually assumed.
- **`SharedArrayBuffer` has a worse problem than headers: tearing.** A snapshot read while
  the sim writes yields half-updated positions, requiring a seqlock or double buffer with
  `Atomics` — to save a copy that costs nothing at ~40KB per snapshot. Transferables sidestep
  it entirely.

## What actually makes the flip expensive

Not the message plumbing. It is that developing against a direct implementation invites the
renderer and UI to *pull* from sim state synchronously — selection, hover tooltips, minimap,
hit-testing, fog, debug overlays each quietly accrete a direct read — after which the flip
is a rewrite of the UI layer. The two mechanisms above exist specifically to make that
impossible rather than merely discouraged.

## Consequences

- Phases 0-5 keep straightforward stack traces, breakpoints and profiling.
- The flip is estimated at 1-2 days *conditional on the discipline holding*. If lint
  suppressions accumulate around the boundary, that estimate is void — which is the signal
  to watch for.
- The worker buys jank isolation from pathfinding spikes. That is a Phase 6-ish concern; at
  20Hz with ~2000 entities the sim is single-digit milliseconds.
- Vite's dev-server worker handling and production bundling have historically differed.
  Verify `new Worker(new URL(...), { type: 'module' })` against a **production build** on the
  day of the flip, not at launch.

## Outcome (the flip happened)

The worker is the default now; `?sim=direct` keeps the main-thread host one query
parameter away, because stepping a simulation in a debugger is worth a great deal when
something is wrong.

The prediction held exactly. The flip was one host implementation and nothing in
`src/render` was touched. What made that true was not the `SimHost` interface on its own
but the rule the interface existed to protect — that rendering reads snapshots and events
and never the world — enforced by lint for the whole time the worker did not exist.

One thing this ADR did not anticipate: the hosts had to MOVE, out of `src/sim` and into
`src/host`. A host translates wall-clock time into ticks, and that is not simulation
logic; leaving it under the determinism ban would have meant carving an exception for the
worker's own clock, which is precisely the sort of exception that stops a ban meaning
anything.

Also settled, and recorded here because this ADR is where the worry was written down:
speed and pause live on the host. The tick stays a fixed 50ms — every determinism
guarantee rests on that — and the host only changes how many identical ticks a second of
real time buys.

