# Roadmap

Engine-first ordering. Each phase ends at a runnable state with acceptance criteria that
are commands exiting non-zero on failure — this is what lets an agent session verify its
own work without line-by-line review.

Rules for every phase: the Definition of Done in `CLAUDE.md` applies, the "not in this
phase" list is binding, and a decision that reverses `docs/ARCHITECTURE.md` needs a new ADR.

| Phase | Delivers | Gate |
|---|---|---|
| 0 | Invariants, tick loop, replay harness | Replay hash reproduces |
| 1 | Pixi bootstrap, iso camera, i18n | Camera + `t()` under test |
| 2 | Tilemap with elevation | Draw-call budget |
| 3 | Sim core, snapshot boundary | Boundary lint + interpolation |
| 4 | Movement and pathfinding | Pathing perf budget |
| 5 | **Cattle** | **Two design gates** |
| 6 | Economy and factions | Ledger determinism |

---

## Phase 0 — Invariants

**Status: complete.** All acceptance criteria verified, including the two lint gates and the
tuning-mismatch gate proven end-to-end rather than only through `lintText`.

No rendering. No Pixi. Pure TypeScript and tests.

**Deliverables**

- `package.json`, `tsconfig.json` (strict), `vite.config.ts`, `vitest.config.ts`,
  `eslint.config.js`, `index.html`, CI workflow.
- ESLint rules that are the point of this phase:
  - `no-restricted-imports`: `src/sim/**` cannot import `pixi.js`, `src/render/**`,
    `src/ui/**`. `src/render/**` and `src/ui/**` can import types only from `src/sim/**`.
  - `no-restricted-globals`/`no-restricted-properties` for the banned determinism list in
    `CLAUDE.md`, scoped to `src/sim/**`.
  - No hardcoded user-facing string literals in `src/ui/**`.
- `src/sim/math/rng.ts` — seeded xoshiro128**, state in a `Uint32Array`, serializable.
- `src/sim/math/trig.ts` — sin/cos lookup table with linear interpolation.
- `src/shared/iso.ts` — world<->screen projection including the elevation term.
- `src/sim/loop.ts` — fixed 20Hz tick, command queue as the sole mutation path,
  commands sorted by `(playerId, sequence)`.
- `src/sim/world.ts` — SoA stores, `(index: u24, generation: u8)` handle allocator,
  `isAlive()`, deterministic sorted destroy flush.
- `src/sim/replay.ts` + `test/replay.test.ts` — `(seed, tuning hash, command log) ->
  state hash every 100 ticks`.
- `tuning/` — one data file for all magic numbers.

**Acceptance criteria**

```
npm run typecheck                       # exits 0
npm run lint                            # exits 0
npm test                                # exits 0
npm run replay                          # 10,000 ticks, hash matches the committed golden
```

Plus tests that must exist and pass:
- The same seed produces the same RNG sequence across two fresh instances.
- A deliberately introduced `Math.random` in `src/sim/` fails `npm run lint`.
- A deliberately introduced `import 'pixi.js'` in `src/sim/` fails `npm run lint`.
- Spawning, destroying and respawning an entity yields a handle that fails `isAlive()`
  against the stale handle.
- Editing `tuning/` changes the replay hash and the test reports the tuning mismatch as the
  reason, not a bare hash difference.

**Not in this phase:** rendering, Pixi, entities with behaviour, pathfinding, i18n.

---

## Phase 1 — Pixi bootstrap, isometric camera, i18n

**Status: complete.** Verified in a real browser as well as by unit test: 60fps, correct
retina backing store, zoom clamping at both ends, grab-style drag panning exact to
`-delta/zoom`, edge panning, keyboard panning, the focus-loss stuck-key guard, and a clean
console. The key-union codegen step was replaced by a type-level derivation (ADR-0008), and
presentation constants were split out of the hashed tuning file (ADR-0009).

**Deliverables**

- Pixi 8 application, resize handling, a fixed render loop separate from the tick.
- `src/render/camera.ts` — translation, zoom clamped 0.5x-2.0x, edge panning, keyboard
  panning, screen<->world conversion including elevation.
- `src/core/i18n/index.ts` — `t(key, params?)`, nested keys, token replacement,
  `src/core/i18n/locales/en.json`.
- A codegen step producing a TypeScript key union from `en.json`, so `t()` is type-checked
  and a missing key is a compile error rather than a runtime blank.
- `en` only. No second locale until the UI settles.

**Acceptance criteria**

```
npm run typecheck && npm run lint && npm test
npm run build                           # production build succeeds
```

- `t('a.missing.key')` is a **typecheck** failure, not a runtime one.
- Camera unit tests: zoom clamps at both ends; `screenToWorld(worldToScreen(p)) === p`
  for a sampled set of points at several heights and zoom levels.
- Token replacement and nested-key lookup covered.

**Not in this phase:** tilemap, sprites, entities, HUD.

---

## Phase 2 — Tilemap with elevation

**Status: complete.** Terrain, cliff derivation, elevation-aware picking, chunk culling
and the performance gate all land. Two deviations, both in ADR-0010: chunks hold retained
`Graphics` geometry rather than `RenderTexture` bakes (the bakes cost ~595MB of VRAM at
devicePixelRatio 2), and the frame budget was re-expressed as main-thread cost plus
dropped frames, because an interval-based budget measures vsync rather than the renderer.

**Deliverables**

- 128x128 `Uint8Array` heightmap, deterministic generation from a seed.
- Terrain baked into 16x16-tile `RenderTexture` chunks; chunk-level frustum culling.
- Cliff derivation: `|Δheight| > MAX_CLIMB` between adjacent tiles marks an impassable edge.
  Visualized as cliff faces in the dynamic pass, not in the terrain bake.
- Elevation-aware tile picking and an isometric cursor highlight on the hovered tile.
- Debug overlay: FPS, frame time p99, draw calls, visible chunk count, hovered tile
  coordinates and height.
- Performance harness: scripted 60s camera sweep with frame-time and draw-call sampling.

**Acceptance criteria**

```
npm test -- terrain                     # picking round-trips across heights and zoom levels
npm run perf:terrain                    # asserts the budget, exits non-zero on breach
```

Budget asserted by `perf:terrain`: p99 frame < 16.6ms, draw calls <= 60, zero longtasks
> 50ms, bounded heap delta over 600 frames.

- Picking correctness on a slope is the test that matters: the tile under the cursor must
  account for height, or every click in hilly terrain is wrong.
- A hand-authored heightmap fixture produces the expected impassable edge set.

**Not in this phase:** units, pathfinding, the sim boundary.

---

## Phase 3 — Sim core and the snapshot boundary

**Status: complete.** The renderer now reads snapshots and events, never the world, with
the rule lint-enforced. Verified in a browser as well as by unit test: marquee selection,
right-click orders reaching the simulation as commands, and interpolation measured at 59
moving frames out of 59 — a non-interpolating renderer would leave two thirds of frames
static. Two refinements, ADR-0011 (blend the bracketing pair, not the two newest
snapshots) and ADR-0012 (commands cross as primitives, so the command clone is dropped).

**Deliverables**

- Entity kinds with real fields; systems as plain functions over explicit array refs.
- `SimHost` interface; `DirectSimHost` with dev-mode `structuredClone` on every command
  and snapshot crossing it.
- Snapshot schema declared once, encoder and decoder **derived** from that declaration,
  versioned.
- `buildSnapshot(world, viewerId)` with an identity filter.
- Event stream channel alongside snapshots.
- Render-side interpolation: two-snapshot lerp at a 75ms delay, tick-slaved clock with
  clamped drift correction, shortest-arc facing, `animStartTick` phase derivation.
- Producer-side coalescing to the newest undelivered snapshot.
- Marquee selection (left-click drag) with hit-testing against **interpolated** positions,
  resolving to handles.

**Acceptance criteria**

```
npm run lint                            # boundary rules now have real code to catch
npm test -- snapshot interpolation
npm run replay
```

- Encoding then decoding a snapshot round-trips every field.
- A schema version mismatch is rejected with a clear error, not misread.
- Interpolation test: a unit decelerating to a stop never overshoots its final position
  (the extrapolation guard).
- Clock test: injected jittery snapshot arrival times produce smooth render positions.
- Backpressure test: a stalled consumer does not grow the queue beyond one snapshot.
- Stale-handle test: a command targeting a dead handle is dropped, not misapplied.

**Not in this phase:** the worker (see ADR-0004), fog of war, pathfinding.

---

## Phase 4 — Movement and pathfinding

**Deliverables**

- Uniform grid spatial hash, bucket traversal in index order, candidates sorted by entity ID.
- Cost layers keyed by movement class (infantry / cattle / mounted), including slope cost
  and impassable height deltas.
- Flow fields first: `Uint8Array` cost field, **`Uint16Array` integration field** with clamp
  and assert.
- Weighted A* with a budgeted request queue; open-list ties broken on `(f, h, nodeIndex)`.
- `requestPath(from, to, class) -> handle` / `consumePath(handle)` — **async by interface
  even while it returns synchronously**.
- Separation steering, soft push-apart, stuck-timer repath, idle-yields-to-moving.

**Acceptance criteria**

```
npm test -- pathfinding
npm run perf:pathing                    # asserts <= 3ms/tick, p99 request latency < 200ms
npm run replay                          # paths are deterministic across runs
```

- Determinism test: identical seed and command log produce an identical path node sequence
  over 1,000 runs of a tie-heavy scenario.
- Integration-field overflow test: a pathological high-cost map does not wrap.
- Chokepoint test: two 40-unit columns meeting in a 2-tile gap resolve without deadlock
  within N ticks.
- No unit ends a tick inside an impassable tile.

**Not in this phase:** combat, formations beyond separation, group command UI polish.

---

## Phase 5 — Cattle

**Status: complete, with both gates assessed below.**

The design gate. Everything before this is known-solvable engineering; this is not.

**Deliverables**

- Cattle components: `isHerded`, `tetheredUnitId`, `stressLevel`, `HerdState`.
- Boids: separation, cohesion, alignment — with substepping (3x at 16.7ms) or hard
  acceleration clamping, whichever the wobble test shows is needed.
- Herder units exert directional avoidance vectors; right-clicking a neutral herd enters
  LEASHED mode.
- Stress accumulation and decay.
- Stampede: at 100% stress, movement forced opposite the threat, with crush damage and
  knockback to infantry, resolved by **swept** collision.

**Acceptance criteria**

```
npm test -- cattle
npm run replay
```

- Wobble test: a herd moving to a fixed point converges without oscillation at 20Hz.
- Tunnelling test: a cow at maximum stampede speed crossing an infantry unit registers the
  crush on every run, at every sub-tile offset. This is the test that catches "sometimes the
  stampede passes through people".
- Stress is monotonic under sustained threat and decays without it.

**Gate 1 — control (playable with placeholder shapes) — PASSED**

Driven in a real browser, not argued from the code: right-clicking one cow leashed all 30;
driving troops into the herd saturated stress to 255 and put 13 cattle into a stampede;
the herd fled away from the pressure and crushed what it ran over.

What makes it a game rather than a coin flip is the curve gap in ADR-0014 — stress rises
with the square of proximity while the steering push stays linear, so there is a band
where you can drive cattle without panicking them. Herding is holding that distance;
triggering a stampede is deliberately closing it.

**Honest limits at this gate.** Aiming was verified as "the herd runs away from pressure",
which is directionally controllable but not yet precise — steering a stampede into a
specific target has not been demonstrated. Counterplay is untested because there is no
opponent yet; it becomes answerable when the AI lands.

**Gate 2 — legibility (with real sprites, separate risk)**
Is a 40-cattle stampede readable as 2:1 isometric sprites? Does the depth sort flicker under
a dense herd? Can a player tell at a glance which way the herd is turning?
Passing Gate 1 does not imply Gate 2 — a mechanic that works as circles can be illegible as
overlapping sprites. This is a rendering and art risk, not a design one, and it is the
reason the hysteresis comparator in `ARCHITECTURE.md` §4 exists.

---

## Phase 6 — Economy and factions

**Deliverables**

- `src/sim/economy/ledger.ts` — Cattle, Grain, Ammunition, Drought. Upkeep every 10s
  (200 ticks), driven by the tick counter, never a wall clock.
- Drought: deterministic seasonal timer. At >= 75% drought, open savanna grain plots yield 0.
- `src/shared/factions/` — AmaZulu, BaSotho, AmaNdebele, Griqua starting parameters.
- All economy UI strings through `t()`.

**Acceptance criteria**

```
npm test -- economy
npm run replay                          # 10k ticks; ledger totals are exactly reproducible
npm run lint                            # no hardcoded strings
```

- Upkeep fires on exact tick multiples across a long run — no drift.
- Drought crossing 75% zeroes the correct plot yields on the correct tick.
- Faction configs validate against a schema; a malformed config fails a test, not runtime.

---

## Backlog, ordered by retrofit cost

1. **Fog of war** — highest. Changes the snapshot signature; propagates into minimap,
   hit-testing and AI. The `viewerId` argument from Phase 3 is what keeps this affordable.
2. **Save/load** — same problem as determinism. Cheap if all mutable state is in typed
   arrays plus RNG state; a rewrite if state has leaked into closures or object maps.
3. **Worker flip** — 1-2 days if Phases 0 and 3 stayed disciplined. See ADR-0004.
4. **Combat resolution**
5. **Buildings and construction** — note construction invalidates path fields.
6. **AI opponent** — cheap *if* commands remained the sole mutation path, because the AI is
   then just another command source, and it gives headless AI-vs-AI soak tests for free.
7. **Audio** — consumes the Phase 3 event stream.
8. **Map generators** — the four scripts from the brief, expressed as heightmaps.
9. **Tech progression**
