# Mfecane RTS — session rules

Browser 2D isometric RTS (Age of Empires II lineage), set in early-19th-century southern
Africa. Defining mechanic: cattle herding, flocking and stampedes.

**Current phase: 4 — not yet started.** Phases 0-3 are complete. See `docs/ROADMAP.md`.
Design reasoning lives in `docs/ARCHITECTURE.md`. Reversals of the original brief are
recorded in `docs/adr/`. Read the ADR before re-opening a settled decision.

## Determinism (hard invariant — lockstep multiplayer must stay possible)

- Sim state lives in `Float64Array`. Not fixed-point. See ADR-0002.
- **Banned inside `src/sim/**`:** `Math.random`, `Math.sin`, `Math.cos`, `Math.tan`,
  `Math.atan2`, `Math.exp`, `Math.log`, `Math.pow`, the `**` operator, `Math.hypot`,
  `Date.now`, `performance.now`. These are implementation-defined or non-reproducible.
  ESLint enforces this; do not suppress it.
- Use `src/sim/math/rng.ts` (seeded xoshiro128**, state is serializable) and
  `src/sim/math/trig.ts` (lookup table + lerp).
- Distance is `Math.sqrt(dx*dx + dy*dy)`. Never `Math.hypot`.
- **Total-order rule:** every `argmin` / `argmax` / nearest-target query ends with an
  explicit `entityId` tie-break. A* open-list ties break on `(f, h, nodeIndex)`.
  A tie resolved by array order is a desync.
- Entity destruction is flushed in a deterministic (sorted) order at the tick boundary.

## Boundaries

- `src/sim/**` may not import `pixi.js`, nor anything from `src/render/**` or `src/ui/**`.
- `src/render/**` and `src/ui/**` may import **types only** from `src/sim/**`.
- Render and UI read the snapshot and the event list. They never read the world.
  No synchronous sim reads for hover, minimap, hit-testing or debug overlays — that is
  exactly what makes the later worker flip expensive.
- ESLint `no-restricted-imports` enforces this.

## Mutation

- Commands are the **sole** path by which sim state changes. Systems do not mutate directly.
- Same-tick commands are ordered by `(playerId, sequence)`.
- Selection is client state. It never enters the sim.
- Entity handles are `(index: u24, generation: u8)` packed into a `u32`. Check `isAlive()`
  at every command dispatch and snapshot decode — a recycled index without a generation
  check retargets an unrelated entity.
- Target entities by **handle**, never by position. The player clicks what they see, which
  is ~75ms stale.

## Content & strings

- No hardcoded user-facing strings. `t()` only. `en` is the only locale until the UI settles.
- Proper nouns and material-culture terms are **not** translated, only glossed.
  See `docs/CONTENT.md` before naming anything.
- Tuning constants live in a data file, never inline in systems. Two files, and the split
  matters: `tuning/tuning.json` is simulation state and is hashed into every replay;
  `tuning/presentation.json` is camera feel and anything the simulation never reads, and is
  not hashed. The test is "can changing it alter a simulation outcome". See ADR-0009.

## Commands

```
npm run dev        # Vite dev server
npm run build      # production build
npm run typecheck  # tsc --noEmit
npm run lint       # eslint (boundaries + banned globals)
npm test           # vitest
npm run replay     # golden replay hash test (the determinism gate)
npm run replay:record  # re-record the golden fixture — deliberate, see below
npm run perf:terrain    # render performance budget, drives a real browser
```

## Definition of done

Every change: `typecheck` clean, `lint` clean, `test` passes, `replay` hash unchanged.

If `replay` reports a **tuning mismatch**, the tuning file changed: re-record with
`npm run replay:record` and say why in the commit message. If it reports **divergence at
tick N**, determinism broke — that is a bug, not a fixture to re-record.
