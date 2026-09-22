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
npm run perf:pathing                    # asserts mean tick cost and request latency, scaled to the machine (ADR-0016)
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

**Gate 2 — legibility (with real sprites) — PASSED**

Is a 40-cattle stampede readable as 2:1 isometric sprites? Does the depth sort flicker under
a dense herd? Can a player tell at a glance which way the herd is turning?
Passing Gate 1 does not imply Gate 2 — a mechanic that works as circles can be illegible as
overlapping sprites. This is a rendering and art risk, not a design one, and it is the
reason the hysteresis comparator in `ARCHITECTURE.md` §4 exists.

*Flicker — measured, `test/gate2.test.ts`.* Forty cattle, real flocking, positions
interpolated at the render rate as the renderer interpolates them, counting how often each
PAIR reverses its draw order. A stampede produced **zero reversals in 210 frames**; a
grazing herd, which turns out to be the harder case, produced a worst pair of **two in
600**. The stampede is easy for the sort because the whole herd moves one way and the
motion preserves relative depth; the mill of a grazing herd is what the dead band is
actually earning its keep against.

The first version of that test asserted on the comparator's own swap counter and failed at
135. That counter reports insertion-sort shifts, so one beast genuinely overtaking the herd
scores about forty of them — indistinguishable from forty animals shimmering. Shimmer is a
pair that keeps changing its mind, so pairs are what is counted.

*Legibility — assessed by looking, in a browser.* Individual animals are distinguishable in
a packed herd. This passes **because of** the separation widened from 0.9 to 1.5 in the same
session; at 0.9 the herd read as a single mass and this gate would have failed. Two hide
colourings and the pale belly do most of the rest.

*Direction — assessed by looking.* Each beast carries its facing in eight directions with a
clear head-and-horns end, and a stampeding animal is ringed in the panic colour. Which way
the herd is going is readable; which way it is *turning* is readable only from watching it
move, not from a still.

**What Gate 2 turned up that is not about legibility.** Chasing a herd with a single threat
saturates **one animal at a time** — measured identically at herd spacings from 0.9 to 1.8,
so it is not a consequence of the separation change. Stress comes only from nearby people;
a panicking neighbour contributes nothing. There was no contagion, so "stampede" meant
"some cattle panic independently" rather than "the herd goes". **Fixed** — panic now
spreads, and spreads on stress rather than on geometry so the cascade follows something
the player controls and can see. Measured in the browser afterwards: 21 of 30, against 1
before. See ADR-0017.

**Also found:** the camera does not follow a stampede. Driven from the player's units, the
herd ran to the edge of the screen and partly behind the minimap panel. A stampede you
cannot see is not one you can aim, which bears directly on Gate 1's open question about
precise aiming.

---

## Phase 6 — Economy and factions

**Status: complete.** Ledger, tick-driven upkeep, seasonal drought and four faction
configurations. Two decisions worth carrying forward: drought severity is derived by
hashing the year index rather than by drawing from the simulation RNG, so a query cannot
change the sequence every other system sees; and the player's economic position crosses
the boundary in the snapshot message as `PlayerState` rather than being read from the
ledger, because the ledger is simulation state and per-viewer is what fog of war will
need anyway.

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

1. ~~**Fog of war**~~ — **done.** The `viewerId` argument carried since Phase 3 made it a
   change to `buildSnapshot`'s body rather than to the boundary. Three states per tile so
   ground stays remembered once seen; line of sight is height-aware, so a ridge blocks and
   high ground sees further. Recomputed on a vision interval rather than per tick, and the
   fog crosses to the renderer only when it changes.
2. ~~**Save/load**~~ — **done.** It was cheap, as predicted. The decisive test saves a
   busy game, restores it into a *fresh* simulation already at a different state, and runs
   both forward for 400 ticks comparing hashes — so anything the save left behind shows up
   as divergence rather than as a subtle wrongness later.
3. ~~**Worker flip**~~ — **done**, and it was the file it was supposed to be: one host
   implementation, nothing in `src/render` touched. Hosts moved out of `src/sim` to
   `src/host` in the process, because a host translating wall-clock time into ticks is not
   simulation logic and should not need an exception carved out of the determinism ban.
   Verified against a production build, which is the specific divergence ADR-0004 warned
   about.
4. ~~**Combat resolution**~~ — **done.** Target acquisition, cooldowns, melee versus
   firearms, and death. The care went into "nearest enemy": every argmin ends on an
   explicit entity-index tie-break, because that query is the single most common source of
   lockstep desync in shipped RTS games. Reaping is deliberately separate from whatever
   did the damage, since crushing, starvation and combat all reduce health and none should
   carry its own copy of the rules for dying.
5. ~~**Buildings and construction**~~ — **done**, and the note was the whole point: a
   foundation changes the navigation grid, so placement goes through `blockTile` (which
   updates the derived tables ADR-0013 warned about) and then invalidates cached fields.
   Cost layers are *not* discarded on invalidation — they now carry the buildings written
   into them, so they are state rather than a derived cache.
6. ~~**AI opponent**~~ — **done**, and the prediction held: it is a command source and
   nothing else, which a test pins by hashing the world either side of a decision. It also
   reads through its own fog, so it plays the same game the player does. The free dividend
   arrived as promised — a headless AI-vs-AI soak that exercises movement, pathing,
   combat, construction and the economy together, and reproduces exactly.
7. ~~**Audio**~~ — **done**, and it is the consumer the event stream was designed for: a
   death cannot be heard by diffing snapshots, because the entity simply stops appearing.
   Sounds are synthesised rather than sampled, since the audio pipeline is deferred — an
   oscillator and a noise burst prove the routing, spatialisation and voice limiting, and
   are replaced by swapping one function.
8. ~~**Map generators**~~ — **done.** All four, and expressing them as heightmaps was
   ADR-0006 paying off: mesas, koppies, poorts and dongas are shapes in one array rather
   than bespoke tile placement with its own passability rules. The tests assert tactical
   character rather than mere output — that Thaba Bosiu's summits are reachable by their
   ramps, that Karoo koppies are not reachable at all, and that the Magaliesberg connects
   north to south only through its poorts.
9. ~~**Tech progression**~~ — **done.** Per-player research with prerequisites, costs and
   multiplicative effects read by combat, vision, movement, the herd and the economy.
   `modifier()` returns 1 for anything unresearched, so a system that forgets to consult
   it behaves exactly as before — the failure mode is "the upgrade does nothing", not "the
   simulation breaks".

**The backlog is clear**, and the single-player game is playable end to end. What has
landed since, and what is left:

- ~~**A victory condition.**~~ **Done.** Measured in cattle rather than corpses, because in
  this setting cattle are wealth, standing and the reason to fight — so a player who
  ignores herding cannot win by being good at everything else. The threshold must be
  *held*, which gives the losing side a window to answer.
- ~~**A real HUD.**~~ **Done.** Command panel (selection, build menu, research, training),
  minimap, victory track and outcome banner. Hotkeys still work; they are no longer the
  only way to find an action.
- ~~**Gate 2 re-run** against real sprites.~~ **Done and passed** — see Phase 5 above for
  the numbers and for what it turned up that was not about legibility.
- ~~**A command vocabulary.**~~ **Done.** Attack-move, stances, an order queue, control
  groups, patrol. Two of those were larger than they looked: stances needed pursuit,
  which did not exist at all — `attack` set a target and nothing ever closed with it — and
  control groups are pure client state by rule, so they carry no command and no world
  field.
- ~~**A game rather than a scenario.**~~ **Done.** A setup screen choosing land, people and
  seed; restart without reloading; pause and speed on the host, where the fixed tick is
  not at risk.
- ~~**The art itself.**~~ **Done**, and it is placeholder art that looks it: procedural
  Blender for units, cattle, buildings and vegetation, local diffusion for ground
  textures, all packed into one atlas page. Proportion, silhouette, kit and colour are
  right; nobody will mistake it for commissioned work, and the renderer is asset-agnostic
  behind the manifest so commissioned work drops in without touching rendering code.
- **Shared silhouettes across factions** — the last atlas-budget mitigation from
  ARCHITECTURE section 9, and currently moot: every faction already draws the same unit
  models. It becomes real the moment faction-specific art exists.
- **Wild animals.** Considered and deliberately not built. Decorative fauna is cheap and
  lifeless; huntable game would touch entities, pathing and possibly the food economy,
  which already has cattle in it. It wants a design decision before any code.
- **Multiplayer.** Every determinism invariant is in place and CI-enforced; none is proven
  across two machines. Surveyed in `docs/MULTIPLAYER.md` rather than started — what is
  left is a transport, advancing on consensus instead of on elapsed time, and a
  two-process soak that would turn the claim into an observation.

---

# Part II — the village

**The game changed shape on 2026-09-15. See ADR-0019.** Two matches were played to an
outcome and neither contained a fight; every decision that mattered in both was economic.
The RTS is not being abandoned so much as its live half is being promoted. What follows
replaces the "what is left" list above, which was written for a war.

The ordering below is deliberate and is the opposite of the intuitive one. Combat retires
**last**. It is the only thing currently standing between the economy and having no
failure condition at all, and a village simulator with nothing to fear is a spreadsheet.

## Phase V1 — an objective that is not a body count

Holding 200 cattle is the only goal the game has, and it is the reason the economy has
teeth. Replacing it comes first because everything after it is balanced against it.

**Done.** The objective is to settle `victory.householdsToSettle` households and hold
them **fed** for `victory.holdTicks` — half a year, raised from a fifth of one after
play showed matches deciding inside the gentle opening season. A village simulator whose
matches end before the village has been through a hard year is not simulating the thing
it is about. The fed clause is the load-bearing half: a village
at full size on a granary that cannot cover the upkeep is a fortnight from empty, and
without it the objective would reward exactly the population spike the hold timer exists
to prevent — train to the target, win before the next upkeep collects.

The number was chosen against the economy rather than picked. Starting plots yield about
92 grain a cycle averaged over a median year; a herd of 148 eats 41 of it. So 40
households (85) is sustainable on the opening position alone — measured, it won in five
minutes with nothing built. 60 needs about 15 more a cycle than the land gives, which is
two granaries and the work to raise them. Measured with both sides played by the AI: 41
households at 2.5 minutes, 58 at ten, settled around seventeen.

Cattle stopped being the objective and did not stop mattering — they are food, wealth and
the thing that eats every ten seconds. The herd-growth guard in `test/economy.test.ts`
was rewritten rather than deleted: a runaway herd no longer wins the game, but it is still
upkeep the player did not plan for.

*Not in this phase, and deliberately:* combat, the AI, and every command survive
untouched.

## Phase V2 — foraging

The veld is currently scenery with collision. Gathering from it is the cheapest new loop
that makes *where* a village sits matter, and it needs no new entity kind — the
vegetation the decoration layer already places can carry it.

**Done, and larger than the phase originally described.** Foraging was going to be
abstract "patches" of rich veld. It became the trees themselves, on the project owner's
call: they grow through sapling and young to mature, marula bear fruit that anyone
standing under them picks, any grown tree can be felled for timber, and a standing wood
seeds new saplings into ground that will carry them. Every building costs wood as well
as grain, which is what makes a wood worth keeping near a village rather than felling to
the last stump.

That **reversed a decision `render/scene/decoration.ts` argued for explicitly** — that
vegetation is render-side and nothing else. The reasoning there is right about scenery
and does not survive trees becoming a resource; the two expensive halves of it were kept,
so trees still do not block movement and are still not entities. Scrub, aloes and stones
remain pure decoration.

Design notes: picking is proximity and felling is a command, because standing under a
tree to eat is reversible and cutting it down is not. One tree does not bear three times
faster for three times as many pickers, which is what keeps foraging worth less per head
than a field. A drought slows growth and fruiting but never stops them; it stops seeding
entirely, which is the part a wood takes years to recover from.

## Phase V3 — farming as a decision

Grain plots are laid out once at map generation and yield forever. They become something
the player places, tends and loses: land committed ahead of a season whose weather is not
yet known.

**Done.** A field is sited by command, costs seed grain at siting, takes work before it
pays anything, and loses condition if nobody tends it. The seed is not refunded when a
field is abandoned, which is what stops committing land being a free option.

**Cattle and crops want the same ground.** A beast standing in a field eats and tramples
it; a villager standing there brings it back; a field that is both worked and grazed nets
the two against each other rather than taking the better, or the herd could simply be
parked in the crops and more people added. The drought treats everyone alike and arrives
on a timer — where the herd grazes is a choice, and it is the first scarcity in this game
the player makes rather than inherits.

The ledger stopped owning the fields with this: it took a static array and yielded from
it forever, and now asks a callback what each field has. The weather stays with the
ledger, the condition stays with the fields, and neither has to learn the other's
business. The old plots were a closure nobody could serialise; fields are saved and
hashed.

Fields are drawn, because a decision whose result the player cannot see is not a
decision: broken earth reads dark and bare, a standing crop reads green, and condition
dims the crop toward the colour of the dirt under it. The tiles are generated from each
band's own ground in the art pipeline, so a field looks like the soil it came out of.

## Phase V4 — trade

**Done.** A neighbour exchanges cattle, grain and timber at a rate set entirely by **its
own** marginal values, never the asking village's. Value falls as a store fills —
`weight * reference / (reference + held)` — so the last bag of grain in an empty store is
worth many times the thousandth in a full one, which is the only property needed to make
scarcity move a price. A linear valuation would be a fixed exchange rate and there would
be nothing to think about.

Refusal is real: a neighbour with nothing to give, or who would be worse off by its own
reckoning, says no and nothing moves. It keeps a reserve of whatever is asked for, and
caps any single deal, so it cannot be bought out — a village that swallowed any quantity
at one rate would be a shop.

Because the rate is the neighbour's private information and the player cannot see their
books, the simulation answers the question on their behalf: `offersFor` returns what each
trade would return right now, and that crosses with the snapshot. Asking is free and
changes nothing, which is what makes it the player's only window onto what a neighbour is
short of.

The AI proposes trades using the same valuation that prices the player's offers, so it
charges dearly for grain for exactly the reason it goes looking for grain, and the two
cannot disagree.

Measured live, one trade of 30 timber for 21 grain moved every rate on the board: timber
offers went from 9 to 10 and 39 to 49 as the neighbour's woodpile filled, and grain offers
fell from 21 to 18 as their granary emptied.

## Phase V5 — alliances

**Done.** A neighbour can be brought into a standing tie. Trade settles and both sides
walk away owing nothing; a tie does not settle, and that is the whole difference. It
costs cattle every season for as long as it stands, and what it returns arrives only if
something goes wrong — so entering one is a bet on the weather and on the other village,
not a price comparison.

**The tithe is symmetric in rule and asymmetric in effect.** Both sides send the same
*fraction* of their own herd each upkeep, so the larger herd pays more and the net flow
runs from the big herd to the small one. That is what *ukusisa* was — cattle placed out
with a poorer household, which bought the lender a claim and the borrower a living — and
it falls out of one rule rather than needing a patron and a client modelled separately.

**What comes back is conditional.** An ally who went hungry at the last upkeep is sent
grain, capped at a tenth of the giver's store; an ally who ate is sent nothing. Relief
runs *before* the ledger charges upkeep, on last cycle's shortfall, so grain from an ally
reaches the granary in time to be eaten rather than arriving a season after the famine it
answers. A test pins that ordering, and moving the call after `economy.update` fails it.

**Breaking it costs standing, not blood.** Standing is what a village thinks of you, it
is not symmetric, and it prices every trade: an oath-breaker is marked up by everybody,
including villages that only heard about it, because word gets around. It starts at 1 —
so the no-regard path in `trade.ts` is the genuinely neutral rate — falls by half on a
break, and returns at 0.004 a season, which is seventy-five seasons before anyone will
have you again.

**Measured badly the first time, and the corrected numbers are worse.** The original
figures here — "seasons spent hungry fell 11→7, 2→0, 4→0" — were taken from a harness that
seeded a map with cattle and no people, so the only upkeep in it was the herd's and the
alliance looked like it was carrying a village it was not. Re-measured on a properly
seeded opening, five seeds at twenty minutes each, allied against not: hungry seasons went
75→77, 49→49, 58→57, 68→71 and 72→66. That is noise. The tie is close to a wash.

The machinery is not what is wrong with it. Relief fires constantly — 48 to 72 seasons out
of 120, moving between 19 and 907 grain — so the conditional return is exercised far more
than the first measurement suggested. It does not help because **both villages are hungry**
in this economy, so relief is a trickle passed between two empty granaries while the cattle
tithe roughly cancels. An alliance between two villages that are each short is worth about
nothing, which is arguably correct and is certainly not what the phase set out to build.

*Open:* whether that is a tuning problem (the economy is too tight for anyone to have a
surplus to lend — see the note at the end of Phase V6) or a design one (relief should be
proportional to the giver's *surplus* rather than to their store, so a village with nothing
spare sends nothing and one with plenty sends more). Not resolved here. The figure below is
the part of the phase that does hold up, because it is a property of the pricing rather
than of the economy around it.

The price of walking out, measured on identical books one tick apart: 8 cattle bought
19.1 grain as an ally, 17.6 as a stranger and 15.6 after the break; 30 timber bought 56.7,
52.3 and 46.4. So a tie is worth about 8% on every deal and breaking one costs about 11%
against the stranger's rate, for seventy-five seasons, from everyone.

The AI asks for a tie when it has gone hungry and has nobody, approaching whoever thinks
best of it. It never walks out on one: an AI that broke faith whenever the tithe looked
expensive would spend a reputation it has no way to value.

## Phase V6 — retire combat

**Done.** `src/sim/combat.ts` is gone, with the stance and pursuit machinery in
`movement.ts`, the AI's fight branch, four commands, five world arrays, one event, one
resource and the whole `tuning.combat` block. The bundle went from 112.69 kB gzipped to
111.25 kB, which is the least interesting thing about it.

**The hazard survey was worth doing and mostly right.** `reap()` was rehomed first, in
its own commit, and the golden replay passed unchanged — which is the only way to prove a
move of that kind is inert rather than to assert it. Retired command, event and order-mode
values were left as numbered gaps rather than renumbered, because they sit in recorded
logs and cross the worker boundary. Resource indices are not durable that way and no
recorded log names one, so the ledger renumbered instead of carrying a dead column.

**Two repurposings rather than deletions, as hazards 4 and 5 asked for.**
`Modifier.CombatDamage` became `Modifier.Labour` and now multiplies build rate, which
makes *amabutho* closer to what it was — the age-set regiments were a labour institution
as much as a military one, and the age grades built and herded for the king. The mounted
commando kept its reach and gained vision, a commando having been a mounted ranging party
before it was anything else. `Resource.Ammunition` was deleted outright: it existed to be
spent per shot, so retiring combat left a column that could only ever go up. The Griqua's
identity moved with it, from mounted gunmen to the thing they actually were — the
intermediaries of the Colony trade — as a `tradeMargin` on the faction config that makes
every neighbour deal with them at a finer margin than with anybody else.

**One acceptance criterion was NOT met, deliberately.** "Nothing in `src/render` draws a
health bar" was recorded on the assumption that a health bar is a combat readout. It is
not one any more. With combat gone the only two things that can take a body's health are
hunger and being trampled, and starvation is now the game's *primary* failure condition
rather than a side effect of one — so deleting the bar would have made the one thing that
can still end a village invisible until the moment it killed somebody. The RTS idiom went
and the information stayed: it is `drawCondition` now, and `EventType.Starved` was added
to the alert bar so hunger says so out loud instead of only shading a bar.

**Retiring combat broke elimination, and only a measurement found it.** A player was
counted out on having no troops *and* no buildings — a conjunction that was only ever
satisfiable because combat could knock a building down. Nothing destroys a building now,
so a village starved down to its last villager left its empty huts standing and could
never be eliminated: four AI matches in five ended with every villager dead and the
outcome still reported as ongoing. Elimination is about people now, with the grace period
doing the work it was always described as doing — a village with a homestead and grain in
it raises a household well inside four hundred ticks, and one that cannot is finished
whatever is still on the ground. All five seeds resolve after the fix.

**There is still something to fear, which was the whole worry.** ADR-0019 put combat last
precisely because removing it first would leave an economy with no failure condition.
Measured over five thirty-minute AI matches on the seeded opening: 1,530–2,130 starvation
events and 90–115 deaths per match, every one of them from hunger, with villages going
short in 86–132 seasons out of 180. Nobody was killed by anybody.

### The win path, and the fog

Five browser playthroughs had never once moved the household count off its starting 24,
against an objective of 60. The economy was not the obstacle and neither was the UI: the
obstacle was that **nothing on screen connected the two numbers that decide the game.**

A village starts able to feed about 38 households. Ten untended fields feed 8; ten tended
feed 38; fourteen tended feed 69. The objective asks for 60. So the answer is always more
LAND — tend what you have, break more ground — and never more people, which is the move
the HUD's "Village 24/60" invites. The resource bar now reads
`Harvest 117 / upkeep 73 · land feeds 63`, in amber whenever the land cannot carry the
village being asked for. That one figure is the whole of the strategy made visible.

Played that way, measured over five seeds: peak households 73, 24, 40, 79 and 89, with
the village winning two outright — seed 11 settling at 11.6 minutes, seed 3 by the
neighbour starving. The computer takes the other three. That is a race rather than a
walk-over, which is the point.

**The fog is off** (`vision.revealAll`), at the project owner's call, and it is a switch
rather than a deletion. A village cannot tend fields it cannot see, and hunting for one's
own herd through a radius of eight tiles is not the interesting part of a game about
herding. The per-viewer snapshot path stays — ARCHITECTURE calls it the highest-retrofit-
cost omission in the brief and lockstep multiplayer still needs it — and `test/fog.test.ts`
switches the fog back on for its own duration, so a system the game no longer uses cannot
quietly rot. The radii went 8 to 18 and 4 to 9 besides, so switching it back on is still a
far wider view than before.

### Assigning work, and taking a herd

Both mechanics already worked and neither was usable, which is a distinction worth
keeping separate from "broken".

**Building has always scaled with the number of people standing at a site**, and nothing
said so: a site with nobody on it and a site with six looked identical, and the only
observable difference was that one of them finished. Right-clicking one of your own
unfinished sites now sends the selection to raise it, `world.builders` records how many
hands are on it, it crosses in the snapshot, and the panel reads either *"umuzi — 33%
built · 1 building"* or *"nobody working it"* in amber. Two details cost an hour each and
are worth writing down: the builders have to be ringed **clear of the footprint**, which
blocks movement from the moment it is placed; and they have to be spread over **three
concentric arcs** rather than one ring, or a crowd shoves itself tangentially out of
`buildRadius` — twenty-one people sent to a single ring had one of them building. The
radius went 2.2 to 3.2 to give them room.

**Herding was a mechanic fighting its own gesture.** Three things were wrong. The people
holding the tethers were themselves the largest source of stress, so the act of driving
cattle wound them toward bolting — a beast under somebody's hand is exempt from that hand
now, and only from that hand, so a stranger still frightens it and raiding is untouched.
Tethering was round-robin, which tore a herd apart the moment it was taken: twelve cattle
split between twelve people each walked off after a different one. And the click had to
land on an animal, in a wood, where the tree answered first.

Now: an animal under the cursor outranks a tree, the click takes the herd around it
rather than the one beast, each beast goes to its nearest drover, and only a few drovers
are detailed — sending two dozen people at a herd is precisely the crowding the stress
curve exists to punish, and it bolted every time. They close from the side they are
already standing on and stop clear of the herd's **edge**, not its centre; ringing it
meant walking through the middle, which panicked seventeen of twenty-three. Measured in
the browser, taking a herd went from a peak stress of 80 to 11, and headless — one herd,
no neighbours — it is 12 of 12 held with zero stampede ticks over 900, even with the
drovers standing among the animals.

*Still true, and deliberately:* marching the rest of the village across a herd panics it.
That is ADR-0014 working, not a defect, and it is why the gesture details four people
rather than everyone.

*A lesson about measuring, recorded because it cost two phases.* The soak harness used for
V5 seeded cattle and no people, so every "village" in it was a ledger with a herd and
nothing that eats grain per head. It produced plausible numbers that were wrong, and they
went into this document as fact. What caught it was an assertion that could not be true —
1,500 hungry seasons and zero starvation deaths — rather than any test. `createDirectSimHost`
does not seed a starting force; `main.ts` does that separately, and a harness that skips it
is not running the game. Both phases' numbers have been re-measured on a seeded opening.

### What three playthroughs found, and what changed because of them

Played to an end three times in the browser, twice more after fixing, and measured either
side. Every one of the first three died at the same tick whatever the player did, so the
player's choices were not the variable — the opening was.

- **Fields decayed invisibly and killed the village.** Condition fell 1.00 to 0.35 in a
  year with nothing on screen about it; one villager standing on each field is the whole
  difference between wipe-out and 3,915 grain banked. Starting fields are sited inside
  vision now (median 5.0 tiles, was 9.2, against a vision radius of 8), a `FieldsFailing`
  alert names the worst field and can be jumped to, and the hint text says what a field
  needs. Warning now arrives at 8.3 min against a first death at 24.5 and a wipe-out at
  27.3, so there is time to act — and ignoring it still loses.
- **Raising households was a trap with no instrument.** The resource bar carries
  `Harvest 113 / upkeep 72` now, which is the number that decision turns on.
- **The herd grew whether the village wanted it or not.** `CommandKind.Cull` slaughters
  ten head for grain. Verified in play: 120 cattle / 400 grain became 110 / 540.
- **40% of openings were a first-year drought above 0.85** — some of them a total crop
  failure against a starting granary of 400. Severity ramps in over three years now: year
  0 never ruinous, year 1 rarely, year 2 onward at full spread.
- **A neighbour could tie the player into an alliance they never agreed to.** Both sides
  have to ask now; see Phase V5.
- **Matches decided inside the gentle opening season** once the weather ramp let the AI
  survive year 0 — 5.5 to 11.8 minutes, before the village had been through anything. The
  hold went from a fifth of a year to half of one; matches now decide at year 0.8-2.1.
- **Defeat arrived with no warning that anyone was close.** A neighbour beginning to hold
  a full village is announced, which the half-year hold leaves time to answer.

*Open, and a tuning question rather than a deletion one:* that is arguably too harsh. Peak
village size reached 41–48 against the 60 needed to settle, and four matches in five ended
in total famine collapse. The AI raises households it has no grain to feed, which is as
much an AI-quality problem as an economy one — see the open items in `tasks/plan.md`. This
phase deliberately did not retune the economy while deleting a system; doing both at once
would leave neither change attributable.

*Kept deliberately:* the stampede. It is a disaster now rather than a weapon — see
ADR-0014 and ADR-0017, neither of which is superseded. The damage flash and the `impact`
sample keyed on `Hit` and `Crushed` and now key on `Crushed` alone, which is the one thing
left that strikes a body.

*Kept deliberately:* patrol. It was built as an attack-move that refuses to finish, but
nothing about walking a beat between two points needs a fight at the end of it, and a
herder covering ground wants exactly that. `orderMode`, `patrolX` and `patrolY` stay with
it; `OrderMode.AttackMove` is a numbered gap beside them.
