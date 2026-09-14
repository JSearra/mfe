# Mfecane RTS — session rules

Browser 2D isometric RTS (Age of Empires II lineage), set in early-19th-century southern
Africa. Defining mechanic: cattle herding, flocking and stampedes.

**Current state: the single-player game is playable end to end.** Phases 0-6 and the whole
backlog are done — fog, save/load, the worker flip, combat, buildings, AI, audio, the four
map scripts, tech, production, victory, a HUD. So is the command vocabulary (attack-move,
stances with pursuit, an order queue, control groups, patrol), the game lifecycle (setup
screen, restart, pause and speed), and the art: terrain, units, cattle, buildings and
vegetation all render from a generated atlas.

What is open is in `tasks/plan.md` and `docs/MULTIPLAYER.md`. Multiplayer is deliberately
not started: the invariants are all in place and none is proven across two machines.

Design reasoning lives in `docs/ARCHITECTURE.md`. Reversals of the original brief are
recorded in `docs/adr/`. Read the ADR before re-opening a settled decision.

## Determinism (hard invariant — lockstep multiplayer must stay possible)

- Sim state lives in `Float64Array`. Not fixed-point. See ADR-0002.
- **Banned inside `src/sim/**` AND `src/shared/**`:** `Math.random`, `Math.sin`, `Math.cos`, `Math.tan`,
  `Math.atan2`, `Math.exp`, `Math.log`, `Math.pow`, the `**` operator, `Math.hypot`,
  `Date.now`, `performance.now`. These are implementation-defined or non-reproducible.
  ESLint enforces this over both trees — anything the simulation shares has to be as
  reproducible as the simulation — and it is not to be suppressed.
- Use `src/sim/math/rng.ts` (seeded xoshiro128**, state is serializable) and
  `src/sim/math/trig.ts` (lookup table + lerp).
- Distance is `Math.sqrt(dx*dx + dy*dy)`. Never `Math.hypot`.
- **Total-order rule:** every `argmin` / `argmax` / nearest-target query ends with an
  explicit `entityId` tie-break. A* open-list ties break on `(f, h, nodeIndex)`.
  A tie resolved by array order is a desync.
- Entity destruction is flushed in a deterministic (sorted) order at the tick boundary.

## Movement

- **Every position write goes through the occupancy check.** `world.posX` / `world.posY`
  are written directly only in `movement.ts` and in `spawn`. Anything that moves an
  entity it does not own — knockback, and cattle steering themselves — calls
  `MovementSystem.displace`, which refuses a destination out of bounds, on an impassable
  tile, or across an edge that movement class cannot climb. Both of those bypassed it
  and neither was caught, because the cattle tests built a world with no terrain in it.
  See ADR-0018.
- A test that constructs the world without the constraint under test cannot observe the
  constraint being broken, and will pass forever while it is.

## Boundaries

- `src/sim/**` may not import `pixi.js`, nor anything from `src/render/**` or `src/ui/**`,
  nor from `src/host/**` — hosts adapt the simulation, not the reverse.
- `src/host/**` adapts the simulation to real time and to a transport. It sits outside
  `src/sim` so the worker's own clock does not need an exception carved out of the
  determinism ban.
- `src/render/**` and `src/ui/**` may import **types only** from `src/sim/**`.
- Render and UI read the snapshot and the event list. They never read the world.
  No synchronous sim reads for hover, minimap, hit-testing or debug overlays — that is
  exactly what makes the later worker flip expensive.
- ESLint `no-restricted-imports` enforces this.

## Mutation

- Commands are the **sole** path by which sim state changes. Systems do not mutate directly.
- Same-tick commands are ordered by `(playerId, sequence)`.
- Selection is client state. It never enters the sim — and that includes control groups,
  which are therefore entirely in `src/render/selection.ts` with no command and no world
  field.
- Entity handles are `(index: u24, generation: u8)` packed into a `u32`. Check `isAlive()`
  at every command dispatch and snapshot decode — a recycled index without a generation
  check retargets an unrelated entity.
  - **The generation occupies the TOP eight bits, bit 31 included.** A handle whose
    generation has reached 128 has its high bit set, so "the high bit is free" is false
    and has already caused one bug. The range that IS free is generation zero: `spawn`
    never issues it, skipping 255 to 1 on wrap.
- Target entities by **handle**, never by position. The player clicks what they see, which
  is ~75ms stale.

## Content & strings

- No hardcoded user-facing strings. `t()` only. `en` is the only locale until the UI settles.
  **Nest new keys.** `LeafPaths` cannot tell a nested path from a flat key containing
  dots, so `"alert.stampede"` written at the top level of the dictionary typechecks and
  then renders the raw key on screen — the one shape the key union does not catch.
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
npm run perf:terrain    # render performance budget, drives a real browser (nightly in CI)
npm run perf:terrain -- --software   # ...on the software renderer CI actually has
npm run perf:pathing    # simulation movement and path-request budgets
node scripts/screenshot.mjs out.png  # drive the running game and photograph it
```

`npm test` includes simulation soaks — the golden replay runs 10,000 ticks — so the Vitest
timeout is raised well past its default. That default is tuned for unit tests and this
suite is not only unit tests; see the note in `vitest.config.ts`.

## Definition of done

Every change: `typecheck` clean, `lint` clean, `test` passes, `replay` hash unchanged.
Anything touching the renderer or the art: **look at it**, in a browser, before believing
it. Every art and rendering defect this project has shipped passed every gate — a palette
that destroyed texture, decapitated sprites, a repeating hoop across the veld, and a
colour overflow that rendered the entire page black. None was reachable from types, tests
or output size.

If `replay` reports a **tuning mismatch**, the tuning file changed: re-record with
`npm run replay:record` and say why in the commit message. If it reports **divergence at
tick N**, determinism broke — that is a bug, not a fixture to re-record.
