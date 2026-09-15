# Remaining work

Source of requirements: the survey of gameplay and engineering gaps agreed with the
project owner, after the roadmap and its backlog were cleared. There is no `SPEC.md`;
these items were enumerated from the code and the roadmap and approved as a list, so
nothing here is invented.

Rules that apply to every task below, from `CLAUDE.md`:

- Commands are the sole path by which simulation state changes.
- **Selection is client state and never enters the sim.** Control groups are therefore a
  render/UI concern with no simulation component whatsoever.
- Every `argmin`/nearest-target query ends on an explicit entity-index tie-break.
- Target by handle, never by position.
- No hardcoded user-facing strings; `t()` only, and **nest** new keys (a flat key
  containing dots typechecks and then renders raw — see `src/core/i18n/index.ts`).
- Definition of done per task: typecheck, lint, tests, golden replay. Tuning changes mean
  re-recording the replay and saying why.

---

## A. Command vocabulary

The army is currently hard to command: the whole set is Spawn, MoveTo, Destroy,
SpawnCattle, Leash, Attack, Build, Research, Train, SetRally.

- [x] **A1 — Attack-move.** Done. A move order that engages what it meets instead of walking
      past it. The most-used order in the genre and the one whose absence is felt first.
      *Done when:* a unit given attack-move toward a point past an enemy stops and fights;
      the same unit given a plain move walks past. Both asserted headlessly.
- [x] **A2 — Stances.** Done, and pursuit with it — it did not exist. Aggressive, defensive, hold ground. Decides whether a unit chases
      what it is fighting, and how far.
      *Done when:* an aggressive unit pursues a fleeing target, a defensive one returns to
      where it was ordered, a hold-ground one never leaves its tile.
- [x] **A3 — Order queue.** Done. Shift-click to append rather than replace. No queue exists at
      all today.
      *Done when:* two queued move orders are executed in sequence, the queue survives the
      unit being re-selected, and an unmodified order clears it.
- [x] **A4 — Control groups.** Done. Ctrl+N to assign, N to recall. Pure client state.
      *Done when:* assigning and recalling round-trips, a group drops dead members, and a
      test asserts the world hash is unchanged by any of it.
- [x] **A5 — Patrol.** Done. Section A complete. Move between two points until told otherwise, engaging on the way.
      *Done when:* a patrolling unit reverses at each end and keeps going.

## B. Game lifecycle

It is a scenario, not a game: the map is a URL parameter, two players are hardcoded, and
the outcome banner is the end of the road.

- [x] **B1 — Restart.** Done. Play again without reloading the tab.
- [x] **B2 — Setup screen.** Done. Section B complete. Choose map, faction and seed before starting, instead of
      editing the query string.
- [x] **B3 — Pause and speed.** Done. Pause, and at least one faster setting. Must not touch
      determinism: the tick rate is fixed, so this is a host concern, not a sim one.

## C. Known gaps

- [x] **C1 — The herd is invisible at start.** Done. Units spawn at the centre with vision 8;
      the herd sits ~16 tiles away. A cattle game that opens with no cattle on screen.
- [x] **C2 — Buildings have no sprites.** Done. Units and cattle are textured; buildings are
      still `Graphics` primitives.
- [x] **C3 — Cliff faces are strata now, deliberately not textured.** They take the tile's average colour; they
      should be textured like the surfaces above them.
- [x] **C4 — Player colour is a tinted overlay off the same page.** Done., not baked geometry. The roadmap has
      wanted this since the art pipeline landed, and the pale shield is now the canvas
      for it.
- [x] **C5 — Mounted units ride.** Done. Section C complete. There is no horse, despite
      `Mounted` being a movement class with its own cost profile.
- [x] **C6 — The `herder` sprite is gone.** Done. Herding is done by any unit; either give
      herders a type or drop the sprite from the atlas.

## D. Multiplayer

Surveyed rather than started, in `docs/MULTIPLAYER.md`: what already exists, what is
actually left, and the scope decision it needs. Not begun, because the roadmap calls it a
milestone rather than a task and its size is a decision nobody has taken.

## E. Open findings (not defects — decisions for the project owner)

- **The two AI players diverge hard in an even match.** Measured over 12,000 ticks of
  `contest(0xf00d)` — identical armies, symmetric starts, mirrored plots — player 1
  ordered 67 buildings and 19 replacements while player 0 managed 2 and one. This
  predates the September review and is not caused by it; correcting the build radius
  only made it more visible, by tipping player 0 from one replacement to none.

  It is a balance question rather than a bug, so nothing here has been tuned to hide it.
  Worth a look before anyone judges the AI's strength from a single match, because half
  of every match is a player that never gets going. The likely suspects are the order of
  the decision branches, which let fighting and herding pre-empt the economy
  indefinitely, and the herd growth compounding upkeep faster than a small economy can
  pay it — player 0's grain hits zero while its ledger herd grows to 195.

- **`tuning.ai.regroupRadius` was dead for the whole of the project's life** until the
  retreat fix used it. Worth a sweep for other tuning keys nothing reads: they are hashed
  into every replay, so each one costs a re-record when touched and buys nothing.

- **`world.flags` is allocated, spawned, saved, hashed and transmitted, and no system
  has ever written it.** One byte per entity carrying nothing. The snapshot byte named
  `flags` is in practice the herd-state byte; only its low nibble is read. Removing the
  world field would be tidy but moves the save schema and every golden checkpoint for no
  functional gain, so it is documented where it is declared rather than deleted. Worth
  folding into the next change that re-records the fixture anyway.

## F. Playtest findings (September, two complete matches)

Two matches played to an outcome in a browser. The first ended **Defeat at tick 4768**,
about four minutes in, without ever meeting an enemy: the whole impi starved while
holding 136 cattle. The second, after the fixes below, ended **Victory at tick 10211**.

Fixed in that pass:

- **The economy was net negative at tick zero.** Income 60 grain per upkeep against 67.1
  for the army and herd every player starts with, in *perfect* weather. The 400 starting
  grain was a countdown, not a buffer. Worse, upkeep scales with cattle held, so closing
  on the 200-cattle victory condition took it to −21.4 — the objective accelerated your
  own starvation. `plotBaseYield` 6 → 12.
- **Drought was a cliff, not a curve.** 37.8 grain a cycle at 74% drought, 8.1 at 75%: an
  86% collapse for a one-point change in a number the player watches tick upward. Now
  falls continuously as `1 − drought²`, with sheltered ground held above a floor.
- **The year was four minutes**, so the first crisis landed ninety seconds in. Now ten.

Still open, and all of them decisions rather than defects:

- ~~The victory condition can be reached by doing nothing.~~ **Fixed:**
  `cattleGrowthPerHundred` 1.5 → 0.4. An idle herd now takes about 28 minutes to reach
  200 rather than eight, so passive growth cannot win a match, while a herd held for
  fifteen minutes still grows 120 → 157 and remains worth keeping.

  The isibaya followed it down, 1.5 cattle an upkeep → 0.5, anchored so that a kraal
  running a full ten minutes breeds exactly the thirty head already grazing on the map:
  building is never faster than going and taking what is there.

- **Massed kraals still beat raiding, because kraals stack and the herd does not.**
  Measured against the real ledger, minutes to carry 120 cattle to the 200 that win:
  passive alone 26.3, raid alone 18.7, raid plus one kraal 8.5, two kraals and never
  raid 8.7 — but **three kraals and never raid, 6.7**. Raiding is now competitive with a
  small build, which is what the yield cut bought, and still loses to a big one.

  It cannot be fixed with another yield number: kraals add linearly and forever, while
  the raidable pool is a fixed thirty. Two levers, and they play differently. Either
  give the veld more cattle to fight over — `STARTING_CATTLE` in `main.ts` is 30 against
  the 80 a player needs, which is thin for a game about cattle — or make kraal cattle
  yield diminish per building so the fourth kraal is worth much less than the first.
- **Starvation damage is not proportional to the shortfall.** Being five grain short does
  the same damage, to every unit you own, as being five hundred short. A small miss
  should be a warning, not the same catastrophe as a collapse.
- **Troops spawn in perfectly straight parade-ground columns**, which is the first thing
  on screen and reads as placeholder.
- **The command panel offers actions that silently fail**: Train on an unfinished
  building, and buildings or techs that cannot be afforded. The click does nothing and
  says nothing.

## G. Two of the four named maps wall the player in — FIXED

Found while checking that the six new herds are reachable, and **not caused by that
change** — measured with eight-way A* from the player's start on each map, counting how
many of the six herd sites can be walked to:

| map | reachable |
|---|---|
| open veld (default) | 6 / 6 |
| thaba-bosiu | 6 / 6 |
| karoo | 6 / 6 |
| **umfolozi** | **1 / 6** |
| **magaliesberg** | **0 / 6** |

On umfolozi the braided river cuts the map into pockets; the start can reach about 5% of
it. On magaliesberg the ridge lines seal it completely — the start reaches about 1% and
cannot walk the eleven tiles to its own doorstep herd. That doorstep site is exactly
where the game's *only* herd sat before there were six, so **magaliesberg has never been
winnable**: the cattle victory is the objective and the cattle were behind a wall.

**The maps were not the problem.** Measuring connected components rather than reachable
points showed the Magaliesberg's valleys form a single walkable region covering 89% of
the map, and the Karoo 98%. What was wrong was that a start position chosen by
arithmetic — "the centre", "nine tiles east of that" — lands wherever the terrain puts
it, and on the Magaliesberg that was a ridge flank: an 80-tile contour ribbon with the
poort's floor four levels below and unreachable. Umfolozi genuinely is cut in three by
its river (53/42/5) and the start sat in the 5%.

Fixed in `src/sim/terrain/placement.ts`: everything a match places — both forces and all
six herds — is first pulled onto the largest walkable region. No map script is changed;
every mesa, ridge and river survives as generated. On an unbroken map it is a no-op, and
a test asserts that.

`test/herds.test.ts` now requires every herd to be reachable by BOTH sides on every named
script, with no exclusions.

## H. The event stream is not filtered by fog

"The herd has broken" fires within the first ten seconds of most matches, for a herd the
player cannot see — usually the enemy's, as its AI walks into its own cattle. Snapshots
are filtered per viewer by `buildSnapshot`, but the event list beside them is sent whole,
so alerts, audio and damage flashes all report things happening under fog. With six herds
and an opponent that herds, this went from a curiosity to a constant.

Filtering events per viewer is the fix, and it belongs next to the snapshot filter.
