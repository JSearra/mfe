# Architecture

The durable technical reference for Mfecane RTS. Records what we build and, more
importantly, why — so later sessions extend the design instead of re-deriving it.

Stack: TypeScript 6.0.3 (strict), Vite 8, Pixi.js 8.20, Vitest 5. No runtime dependencies in
`src/sim/**`.

Fixed constants: 2:1 diamond isometric projection, 64x32px tile footprint, 128x128 tile
maps, simulation at a fixed 20Hz (50ms tick).

---

## 1. Determinism and lockstep readiness

The game ships single-player. It is built so deterministic lockstep netcode can be added
later without rewriting movement, steering or pathfinding.

**Floating point is not the obstacle it is assumed to be.** IEEE-754 `+`, `-`, `*`, `/`
and `sqrt` are correctly rounded and fully specified. They are bit-identical across V8,
JavaScriptCore and SpiderMonkey, on ARM and x86. JavaScript has no x87 80-bit
extended-precision hazard and no fast-math flag. Arithmetic reproduces.

What does not reproduce:

| Hazard | Why | Replacement |
|---|---|---|
| `Math.sin/cos/tan/atan2/exp/log/pow`, `**` | Implementation-defined by spec; differ across engines *and across versions of one engine* | `src/sim/math/trig.ts` — owned LUT + lerp (wanted for performance anyway) |
| `Math.hypot` | Not correctly rounded | `Math.sqrt(dx*dx + dy*dy)` |
| `Math.random` | Obviously | `src/sim/math/rng.ts` — seeded xoshiro128**, state in a `Uint32Array`, serialized into saves |
| `Date.now`, `performance.now` | Wall clock | Tick counter |
| `Set`/`Map` iteration | Order follows insertion, which can follow non-deterministic input | Sorted arrays, or iterate a stable index |
| Mixed `Float32Array`/`Float64Array` | Storing to `f32` rounds; one path storing and another not diverges | `Float64Array` in sim, `Float32Array` **only** in the render snapshot, where precision loss is harmless because values never feed back |

Sim state is therefore `Float64Array`, with the hazard list banned by ESLint.

**Why not fixed-point.** Q16.16 in `Int32Array` is representable for a 128x128 map at 64px
tiles, but multiplication needs a 64-bit intermediate that JavaScript does not have.
`BigInt` is roughly an order of magnitude slower and allocates; split-multiply via
`Math.imul` with manual high/low recombination is correct but easy to get wrong in the sign
and shift. Division and square root are worse. The decisive cost is not speed though — it
is that every steering and physics formula becomes unreadable, and this project's central
risk is tuning a feel-based mechanic. Cattle stress coefficients will be adjusted hundreds
of times. Those edits must not be in Q16.16. See ADR-0002.

### What breaks first if lockstep is retrofitted carelessly

Five failure points, all free to prevent now and painful to fix later:

1. **Nearest/best-target tie-breaks.** The single most common desync in shipped RTS games.
   Two enemies equidistant — which does the impi attack? If the answer depends on spatial-hash
   bucket order or array order, two clients diverge on the first tick of combat.
2. **A\* open-list ties.** A binary heap's behaviour on equal `f` is arbitrary. Break on
   `(f, h, nodeIndex)` explicitly.
3. **Entity ID allocation order.** Free-list order follows destruction order, which follows
   iteration order. Divergence cascades. Fixed by a sorted destruction flush.
4. **Same-tick command ordering.** Lockstep needs a canonical order for commands issued on
   the same tick by different players: sort by `(playerId, sequence)`, execute at tick `N+k`
   with `k` around 3-6 for latency tolerance. Cheap *if* commands are already the sole
   mutation path; a rewrite if they are not.
5. **Selection in sim state.** Every client selects differently, so selection in the sim
   desyncs immediately. Selection is client state.

### The replay harness

`(seed, tuning-file hash, ordered command log) -> state hash every 100 ticks`.

This is built in Phase 0, before there is anything to regress, because it is trivial then
and expensive to bolt on afterwards. One artifact yields determinism enforcement, desync
detection, save/load, regression testing and headless AI-vs-AI soak runs. The tuning file's
hash is part of the replay hash so a stale replay reports *why* it is invalid rather than
failing mysteriously.

---

## 2. Entity storage — struct-of-arrays, no ECS

Six entity kinds: unit, cattle, building, projectile, resource node, effect. Their shapes
are near-static. ECS earns its complexity when composition is arbitrary; here it is not.

Storage is struct-of-arrays typed arrays per kind. Systems are plain functions taking
explicit array references as parameters, not a global `world` object — that keeps a later
storage swap mechanical rather than archaeological.

Two things are not optional:

- **Generation-tagged handles.** `(index: u24, generation: u8)` packed into a `u32`, with
  `isAlive(handle)` checked at every command dispatch and snapshot decode. Without the
  generation counter: a unit dies, its index is recycled next tick, and a command queued
  from the UI 75ms ago against "entity 42" now retargets an unrelated cow. Across a 20Hz
  boundary with interpolation delay this is a weekly bug, not a theoretical one.
- **Deferred structural change.** Spawns, destroys and component changes cannot happen
  mid-iteration. They queue into a command buffer flushed in sorted order at the tick
  boundary.

**Why not bitECS.** Its 0.4.0 pre-1.0 status and API churn are real but secondary. The
decisive argument is that query iteration order is an internal implementation detail. Our
replay hash depends on iteration order — damage application, target selection tie-breaks,
ID allocation all do — so a patch-version bump of the ECS would silently invalidate every
stored replay and, later, desync multiplayer. Owning the storage means owning the order.
See ADR-0005.

Archetypes get revisited only when a genuine composition need appears.

---

## 3. Elevation

`Uint8Array` height per tile, one value per tile.

```
screenX = (tx - ty) * TILE_W / 2
screenY = (tx + ty) * TILE_H / 2 - height * ELEV_STEP
```

**A cliff is not a tile type.** It is an emergent property of `|Δheight| > MAX_CLIMB`
between adjacent tiles. This one rule delivers all four map scripts from the brief:

- **Thaba Bosiu** — a plateau of high tiles ringed by an unclimbable delta, with two tiles
  where the delta is gradual enough to walk. The narrow pass falls out of the heightmap.
- **Karoo koppies** — isolated height spikes, impassable on every edge.
- **Magaliesberg poorts** — gaps in a ridge line where the ridge drops below the threshold.
- **Dongas** — negative deltas; impassable to cross, traversable along, and they block
  line of sight for projectile cover.

Height additionally feeds slope movement cost (a `|Δh| == 1` step costs more), line-of-sight
blocking, and extended vision range from high ground. Elevation therefore touches
projection, depth sorting, pathfinding cost, fog line-of-sight and art simultaneously —
which is why it is decided before Phase 2 rather than reserved as a field. See ADR-0006.

---

## 4. Rendering and depth sort

**Terrain is chunked, but not baked.** The original plan here was 16x16-tile
`RenderTexture` chunks — "roughly 64 quads, not 16,384 sprites". ADR-0010 rejected the
bake on VRAM grounds and the chunks are 32 tiles square, culled as whole chunks.

What actually draws, now that tile art exists, is two global layers rather than one pass
per chunk: every cliff face as retained `Graphics` geometry, and every tile top as a
sprite off one atlas page above it. So it IS the 16,384 sprites the original note set out
to avoid — and they cost less than the bake would have, because they all share a texture
and batch into a single call. ADR-0010 predicted exactly this and said to revisit when
tile art landed; this is that revisit.

**Most of what occludes goes in one depth-sorted dynamic pass**: trees, buildings, units,
cattle. Vegetation joins that sort rather than the terrain, because a tree that cannot be
stood behind is a painted backdrop.

**Cliff faces are the exception, and it is a known gap.** They live in the terrain layer,
so a unit behind a tall cliff draws in front of it. Closing it means pulling faces out of
the chunk geometry and into the dynamic pass, and it has not been worth the cost yet: a
real map carries around 2,600 faces, and they are drawn as per-elevation strata in a
Graphics that was already being built, at no extra display object.

Depth key is `(tileX + tileY)` with an `entityId` tie-break. Three non-obvious requirements:

- **Sort on interpolated positions, not snapshot positions.** Sorting from one set of
  positions while drawing another pops sprites at the exact frame two units cross.
- **Herds need hysteresis.** Forty mutually overlapping co-moving cattle sprites will flip
  order every frame on near-ties and flicker. Only reorder past a depth-delta threshold.
  `Array.prototype.sort` has been stable since ES2019, but stability alone does not fix
  near-tie oscillation.
- **Multi-tile buildings cannot be sorted by a single key.** Three options exist: slice
  buildings into per-tile art strips (art cost, seams), topologically sort pairwise footprint
  occlusion (correct, but admits cycles needing stable arbitrary breaking), or constrain
  footprints and art so ambiguity cannot arise. We take the third.

Pixi's `sortableChildren`/`zIndex` is not used. The sort is applied by re-parenting
children in order, which is what child order means to Pixi — and measured, that is the
expensive part rather than the sorting: `addChild` removes before it appends and the
removal is a linear scan, so re-parenting several hundred objects every frame is
quadratic. It is skipped on frames where the order has not changed, which is most of
them, and that is compared against the previous ORDER rather than against the
comparator's swap count: zero swaps means nothing was reordered, not that nothing
changed, and an entity dying as another spawns shifts the mapping with neither.

### Performance budget

Replacing the brief's "zero memory allocations inside the per-frame render loop", which is
unfalsifiable (Pixi allocates) and aims at the wrong axis. Draw calls and batch breaks
dominate, not GC: the sorted dynamic pass interleaves atlas pages, and page count sets draw
calls.

Measured over a 60s scripted soak at 300 units + 200 cattle:

- p99 **main-thread cost** per frame < 8ms — half the frame, leaving room for the GPU
- dropped frames (interval past a vsync slot) under 1% of frames
- draw calls <= 60
- zero long tasks > 50ms
- bounded heap delta across 600 frames

Frame *cost* and frame *interval* are deliberately separate. Under vsync the interval is
pinned near 16.67ms however little work the frame did, so an interval-based budget
measures the display rather than the renderer — it can neither pass nor fail for the
right reason. Interval is used only to count dropped frames. See ADR-0010.

`npm run perf:terrain` enforces this against a real browser, and downgrades the
GPU-dependent checks to advisory when it detects software rasterisation. It runs nightly
rather than on every push — it needs a browser download and a minute of wall clock, which
is too much to spend guarding a slow-moving axis on every commit. `perf:pathing` is pure
Node and stays on every push.

---

## 5. Simulation / render boundary

A `SimHost` interface with two implementations: `DirectSimHost` (main thread) and
`WorkerSimHost`. Development proceeds against direct; see ADR-0004 for why the worker is
deferred past the brief's Phase 3.

The boundary is enforced by ESLint import rules, not by convention, plus one dev-mode trick:
`DirectSimHost` runs `structuredClone()` on every command and every snapshot it passes. A
shared-reference leak then fails immediately instead of at flip time.

### Snapshot schema

Per entity, roughly 25 bytes. The schema is declared once in `src/shared/snapshot.ts` and
the codec is derived from it, so this table is a description of that declaration and not a
second copy of it — if the two disagree, the file is right.

| field | type | notes |
|---|---|---|
| `handle` | `u32` | index + generation packed |
| `animStartTick` | `u32` | required — see interpolation |
| `x`, `y` | `f32` | position at tick end |
| `facing` | `u8` | quantized to the atlas direction count |
| `animState` | `u8` | idle / walk / stampede |
| `faction` | `u8` | |
| `flags` | `u8` | herd state, and room for more |
| `hpPct` | `u8` | |
| `kind` | `u8` | unit, cattle or building — the discriminator the rest reads through |
| `subtype` | `u8` | movement class for a unit, building type for a building |
| `stressPct` | `u8` | cattle only, and the whole of Gate 1's readout |
| `progressPct` | `u8` | construction, drawn as the building stage |

The last four arrived with the systems that needed them and are worth noting as a pattern:
a kind discriminator plus a few kind-specific bytes has been cheaper every time than a
second entity store or a union keyed on type. 2000 entities is ~50KB per snapshot,
~1MB/s at 20Hz. Structured clone handles that
comfortably; transferable `ArrayBuffer`s make it free when the worker lands. **Do not reach
for `SharedArrayBuffer`** — it adds a tearing problem (a snapshot read while the sim writes
yields half-updated positions) requiring a seqlock or double buffer with `Atomics`, to save
a copy that does not cost anything.

The field layout is declared **once** and the encoder and decoder are derived from it.
Hand-written paired codecs drift, and the resulting bug is a multi-hour debugging session.
The schema is versioned.

### Two channels, not one

State snapshots cannot express events. An entity that dies simply vanishes from the next
snapshot with no signal to play a death animation, and anything that occurs and reverts
inside one tick is invisible entirely. So a parallel event list travels alongside:

```ts
{ tick, type, handle, x, y, payload }
```

Deaths, spawns, hits, stampede-start, construction-complete. This is the channel audio,
VFX and floating combat text all consume.

### Per-viewer snapshots from day one

`buildSnapshot(world, viewerId)` takes a viewer argument immediately, with an identity
filter. Fog of war is the highest-retrofit-cost omission in the original brief precisely
because it changes this signature — from "all entities" to "entities visible to player P,
plus remembered ghosts of buildings in explored-but-not-currently-visible tiles" — and that
change propagates into the minimap, hit-testing and the AI's information model. The argument
costs nothing today.

Filtering is by **player visibility, never camera frustum**. Letting the renderer tell the
sim what to send based on the viewport breaks the minimap and fog memory and makes the
interface camera-dependent. The camera culls on the render side.

### Interpolation

Keep a short snapshot history (eight, ~400ms at 20Hz) and each frame blend the pair that
**brackets** the render clock, at `now - 75ms` (1.5 ticks). The two newest snapshots are
the bracketing pair only while delivery is even; under jitter a two-slot buffer evicts the
snapshot being blended from and the render position lurches a full tick. See ADR-0011.

- **Never extrapolate.** Extrapolating a unit that stops overshoots and then yanks back —
  that *is* rubber-banding. 75ms of visual latency is imperceptible in an RTS.
- **Slave the render clock to tick numbers, not snapshot arrival timestamps.** Arrival is
  jittery under GC and worker scheduling; timing from it produces visible jitter. Maintain a
  local clock advancing at real time, compare against the newest received tick, and correct
  drift at a clamped <= 1ms/frame. **Never snap** — a snap teleports every unit at once.
- **Facing lerps along the shortest arc.** Naive angle lerp spins every unit a full
  revolution at the 359°->0° wrap.

Known failure modes and their causes:

| Symptom | Cause |
|---|---|
| Jitter | Timing from arrival timestamps; or snapping on drift correction |
| Rubber-banding | Extrapolation, or the renderer simulating anything itself |
| Animation popping | `animState` sent without `animStartTick`; at 20Hz a looping walk cycle restarts because the renderer has no phase reference |
| Wrong unit targeted | Sending a position instead of a handle. Hit-test against **interpolated** positions, resolve to a handle, send the handle. The sim handles "that handle is dead or the generation mismatches" gracefully |
| Tab dies after alt-tab | A backgrounded tab stops `requestAnimationFrame` while the producer keeps ticking; the queue grows unbounded. The producer coalesces to the newest undelivered snapshot |

**Local UI feedback fires immediately on click and never awaits the round trip** —
selection highlight, move marker, unit acknowledgement audio. That split (instant local
affordance, interpolated simulated visuals) is what makes a 75ms-delayed renderer feel
responsive.

---

## 6. Spatial index

Absent from the original brief and more performance-critical than pathfinding. Flocking is
an O(n·k) neighbour query at 20Hz over hundreds of cattle; combat targeting, selection and
stampede collision all need it too.

Uniform grid hash sized to the largest query radius. For determinism: traverse buckets in
index order and sort candidate lists by entity ID.

---

## 7. Pathfinding and steering

**Flow fields first.** They cover the dominant RTS case (a group moving to a shared
destination) and are easier to make deterministic than per-unit search. Weighted A* with a
budgeted request queue serves single units and stragglers. HPA*-style cluster abstraction
only if 128x128 proves slow, which it probably will not.

**No JPS.** Its jump-point pruning rules are only valid on uniform-cost grids, and the brief
pairs it with a 1-254 weighted cost grid. It is also invalidated by every construction —
its speedup comes from expanding few nodes on a *static* grid, and RTS grids are dynamic.
See ADR-0003.

**Cost is per movement class, not per tile.** Infantry, cattle and mounted Griqua do not
share a cost function over slope, river drifts and acacia thornveld. So: cost layers keyed
by movement class, or a `cost(tile, class)` function. This alone would have killed any JPS+
precomputation, which would need building and storing per class.

**The integration field is `Uint16Array`.** The brief's `Uint8` is correct for the *cost*
field (255 as the impassable sentinel is the standard flow-field encoding) but the
integration field accumulates cost to goal and overflows `u8` catastrophically. Clamp and
assert.

**Budget.** Not the brief's "300 path vectors in 10ms" — that workload never occurs, because
a 300-unit army is 6-20 groups sharing flow fields, and steady state is more like 5-20
requests per tick plus collision repaths. Optimizing the phantom burst is what pushes you
toward JPS in the first place. Instead: pathing subsystem <= 3ms per tick, p99 path-request
latency < 200ms, requests queued and amortized. Both are testable and match what players
notice.

Those two numbers are the design target. What `perf:pathing` *asserts* is not quite them:
wall-clock budgets that tight are extreme-value statistics on sub-millisecond samples, and
they measure the runner rather than the code — they failed every CI run from the first
push. The gate enforces central statistics scaled to the machine, with catastrophe
ceilings on the extremes, and prints these targets beside the measurements. See ADR-0016.
The latency budget needs none of that: it is derived from tick counts, so it means the
same thing on any hardware.

**No RVO.** Beyond being fiddly, RVO is *reciprocal by definition* and a stampede is
definitionally non-reciprocal — cattle must plough through infantry while infantry fail to
avoid them. Building a system whose axioms contradict the headline feature, then
special-casing around it, is the wrong trade. See ADR-0003.

Instead: separation steering, soft push-apart after integration, a stuck-timer that triggers
repath, and idle-units-yield-to-moving. The real chokepoint failure is **deadlock and
wall-pinning** — two columns meeting in a drift, units pushed into impassable tiles — not
stacking, and these are the mitigations that address it.

**Two steering models coexist permanently**: boids for cattle, formation/separation for
infantry. Do not unify them.

---

## 8. Cattle

The headline mechanic, specified in Phase 5. Two risks are known in advance:

- **Boids at 20Hz may wobble.** Flocking is conventionally integrated at 60Hz. At a 50ms
  step, naive Euler integration of steering forces overshoots. Cattle steering likely needs
  3x substepping (16.7ms) or strict velocity/acceleration clamping. Test this first — it is
  a direct risk to the thing the game is named for.
- **Stampede collision will tunnel.** A stampeding cow at 8 tiles/s on 64px tiles covers
  ~25px per 50ms tick, against a unit radius around 16px. Fast cattle skip over infantry
  entirely on some ticks. The crush check needs swept collision or substepping. "Sometimes
  the stampede just passes through people" is exactly the bug that makes a mechanic feel
  broken and is hard to attribute after the fact.

---

## 9. Art pipeline

AI generation is sound for terrain tiles, static props and UI, behind a strict post-process:
fixed palette, single light direction, exact 64x32 diamond alignment, alpha trim,
tileability check, and per-height-step cliff-face variants.

**Directional unit animation is the open problem.** Image generation does not reliably
produce consistent multi-frame directional sprite sets, and the naive budget is 4 factions x
6 unit types x 8 directions x ~15 frames ≈ 2,880 frames, against roughly 1,024 per 4096²
page at 128px. Page count interacts directly with depth-sort batch breaking, so this is a
rendering-performance problem as much as an asset problem.

Three mitigations, to decide before commissioning anything:

- Mirror 3 of 8 directions — 5 unique, as AoE2 did.
- Palette-swap player colour **in a shader**. Pre-tinted per-faction atlases multiply the
  budget by faction count. **Done**, and the shape of the answer is worth recording: the
  parts carrying player colour render as their own trimmed frames on the SAME atlas page,
  and the renderer draws them over the body with a per-faction tint. Pixi applies tint in
  its batch shader, so that is a shader swap in the one version that does not break the
  batch — a filter per sprite would have cost a draw call per unit. Nearly free in atlas
  terms, because a team frame is a shield marking and nothing else.
- Share silhouettes across factions where historically defensible.

The renderer stays asset-agnostic: an asset-manifest indirection, with no code referencing
an atlas coordinate. The pipeline can then change without touching rendering.

---

## 10. HUD

DOM overlay, not Pixi-drawn. Free text shaping and line breaking for diacritic-heavy isiZulu
and Sesotho strings, accessibility, straightforward i18n, and far less code. Pixi text with
complex orthography is a known pain point and works directly against the i18n goal.

---

## 11. What gets rewritten, and how that is kept cheap

| Component | Rewrite odds | Mitigation |
|---|---|---|
| Pathfinding algorithm | near-certain | Behind `requestPath(from, to, class) -> handle` / `consumePath(handle)`. **Async by interface even when it returns synchronously**, so moving to a budgeted queue or a second worker is not a caller change. No system touches A* internals |
| Steering | near-certain | Pure function `(desiredVel, neighbours, obstacles) -> vel`. No hidden state |
| Snapshot schema | near-certain | Declared once; codec derived; versioned |
| Cattle tuning constants | churns continuously | One data file, HMR in dev, hash folded into the replay hash |
| Entity storage | moderate | Systems take explicit array refs, not a global world |
| Art pipeline / atlas format | near-certain | Asset manifest indirection |
| Depth-sort strategy | likely | One swappable comparator; depth key computed in one place |

**Built properly on day one because they will not be replaced:** the fixed-timestep tick
loop, the command queue as sole mutation path, the seeded RNG, the replay/hash harness, and
the sim/render contract. Spend the care budget there.

---

## 12. Open questions

- **Target platform.** Desktop browser assumed. Touch support would change input, UI, atlas
  sizes and performance budgets.
- **Unit animation pipeline** (section 9) — unresolved, and the most likely thing to stall
  the project.
- **Fog granularity** — per-tile `Uint8Array` (cheap, blocky) versus blurred; and whether
  vision is line-of-sight-blocked, which needs a raycast pass and interacts with elevation.
- **Cultural consultation** — see `docs/CONTENT.md`. A line item, not a localization-time
  afterthought.
