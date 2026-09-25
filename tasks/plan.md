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

---

# Part II of the plan — the 2026-09-23 brief

Source: `SPEC.md`, which takes the project owner's four clauses and costs each against
the code. Tasks are in dependency order; each earns a failing test first, its own commit,
and the Definition of Done in `CLAUDE.md`.

## T. Terrain — ground that does not end in a wall

- [x] **T1 — The ground surface, derived and tested on its own.** Done. A pure module giving
      the four CORNER heights of a tile, each the mean of the tiles meeting at that
      corner, except that a corner touching a real cliff takes the tile's own height so
      the cliff stays a hard edge. No rendering change; the module is not yet called.
      *Done when:* flat ground returns the tile's own height at all four corners, a
      one-level step returns a corner between the two, a cliff corner snaps, and the map
      edge does not slope off toward the out-of-bounds sentinel.
- [x] **T2 — The ground becomes continuous.** Done. Tile tops drawn from T1's corner heights
      as one retained mesh per chunk rather than a sprite per tile, so a single-level
      change is a ramp. Faces are then drawn only where there is a real cliff.
      Render-side only: the simulation keeps per-tile integer heights and movement,
      pathing and cost are untouched.

      *Why this is one task with T1 and not two.* The first cut of this plan had a cheap
      T1 — "a walkable step stops drawing a wall" — ahead of the mesh. It does not work,
      and the projection says why: `worldToScreenY` is `(x+y)·HALF_TILE_H − h·ELEV_STEP`,
      so two tiles sharing a world edge across a one-level step have that shared corner
      drawn `ELEV_STEP` apart on screen. The face is not decoration over flat diamonds,
      it is the only thing filling the gap between them. Deleting it opens an 8px hole
      to the background along every contour on the map. The ground has to be continuous
      before a walkable step can stop being a wall, so it is one change.

      *Done when:* the UV mapping into the terrain page is unit-tested, draw calls do
      not regress against `npm run perf:terrain`, and it is looked at in a browser.
- [x] **T3 — Corner seams.** Done. `transitionsFor` walks four orthogonal neighbours, so
      higher ground meeting a tile only diagonally contributes no blend and leaves a
      notch at every diagonal. Add the corner masks and the art for them.
      *Done when:* a tile whose only higher neighbour is diagonal receives an overlay,
      asserted headlessly, and the notch is gone in a screenshot.
- [x] **T4 — Water gets a bank.** Done. Section T complete. Water is a flat-filled diamond, which is the one
      literal 90-degree edge left on the map: a river or a coast is a hard staircase.
      Give the waterline the same treatment a band seam gets.
      *Done when:* a shore tile emits a bank overlay and open water does not, asserted
      headlessly; looked at on `umfolozi`, which is the map with the most water on it.

## U. Buildings that do something the village needs

- [x] **U1 — `BuildingSpec` can express an effect with a radius.** Done. Four of the five
      existing types differ only in `grainYield`/`cattleYield`/`trains`; the struct has
      no vocabulary for a building that acts on what is near it. Scaffolding only, with
      no new building, so the mechanism and the content land in separate commits.
      *Done when:* an existing building declares a null effect and nothing changes —
      the golden replay proves the scaffolding inert.
- [x] **U2 — Umgodi, the grain pit.** Done. One tile, cheap, yields nothing; buffers instead.
      In a shortfall it pays out before anybody starves and refills from surplus. Aimed
      at the only failure condition the game has.
      *Done when:* a headless village with a full pit survives a shortfall that kills
      the same village without one, and the pit empties and refills across the seasons.
- [x] **U3 — Isiziba, the weir.** Done. Sited only on a shore tile. Fields within its radius
      lose less condition to drought.
      *Done when:* siting off a shore is refused; a field inside the radius holds
      condition through a drought that costs an identical field outside it.
- [x] **U4 — Isibaya sezimbuzi, the small-stock pen.** Done. Section U complete. Cheap and small, a steady modest
      grain yield at low upkeep — the hedge for a village that cannot feed cattle.
      Carries the goats and fowl already placed around the dwellings.
      *Done when:* its yield and upkeep are in tuning and asserted, and it is reachable
      from the build palette with a hotkey.

## V. Village management

- [x] **V7 — A calendar.** Done. Year, season and weather, named. The economy has been
      seasonal since Phase 6 and nothing on screen says so.
      *Done when:* season and year are pure functions of the tick, tested against the
      ledger's own `seasonTicks`, and read out in the HUD.
- [x] **V8 — Rationing.** Done. A village-wide order cutting the ration: less upkeep, slower
      work, nobody dies. The counterplay to a bad year, which does not currently exist.
      *Done when:* a rationed village survives a shortfall that starves an unrationed
      one; the order is reversible; the ledger still serialises.
- [x] **V9 — Fallow.** Done. Section V complete. A field left deliberately unworked recovers condition faster than
      a worked one, so siting more fields than you can tend becomes a decision rather
      than a mistake.
      *Done when:* a fallow field's condition curve is measured against a worked one and
      an abandoned one, all three differing.

## W. A HUD you can play from

- [x] **W1 — Restyle the HUD.** Done. Section W complete, and with it the plan. Grouping, chrome, typography, spacing; the debug overlay
      off by default behind its existing toggle.
      *Done when:* looked at in a browser at 1440x900 and at a narrow width, and the
      `src/ui` string-literal lint still passes.
- [x] **W2 — A build palette that says no out loud.** Done. Cost, affordability, and a stated
      reason when an action cannot be taken — `tasks/plan.md` section F records that the
      panel "offers actions that silently fail". Covers the buildings from section U.
      *Done when:* the reason logic is unit-tested for each way an action can be
      unavailable, and no path leaves a button that does nothing.
- [x] **W3 — The calendar readout**, pairing with V7. Done, with V7 — the readout was V7's own acceptance criterion and splitting it would have landed a season nobody could see.
- [x] **W4 — A selection summary.** Done. — what is selected, how many, what they are doing.
      `src/sim/roles.ts` already computes the last of these for the renderer.
      *Done when:* the counts are asserted headlessly off an interpolated view.

---

# Part III — what Part II exposed

Not new requirements. Every item here is a gap the previous section's work either
created or made visible, found by looking at the running game rather than by reasoning
about it. Same rules: a failing test first, one commit each, the Definition of Done.

## X. The gaps

- [x] **X1 — The three new buildings have no art.** Done. `BUILDING_KINDS` in
      `render/scene/entities.ts` has five entries and the new types are 5, 6 and 7, so
      a grain pit, a weir and a goat fold all fall through to `BUILDING_KINDS[0]` and
      draw as an isibaya. Confirmed in a browser: they are featureless brown ellipses.
      This is a defect the previous section shipped — the panel was checked and the map
      was not, which is exactly the failure `CLAUDE.md` names.
      *Done when:* each has a silhouette of its own through `tools/art/make_building.py`,
      the fallback is a named default rather than "the first building in the list", and
      one of each has been placed and looked at.
- [x] **X2 — The AI cannot build five of the eight types.** Done, with a finding — see X5. Its repertoire is `Umuzi`
      and `GrainStore`; it has never known about the ikhanda or the indlunkulu either,
      and now the pit, the weir and the fold are dead content in every AI match. A
      neighbour that cannot answer a drought is not a neighbour worth racing.
      *Done when:* the AI builds a pit and a fold when its own books say it should, a
      headless match shows it doing so, and the golden replay is re-recorded with both
      proofs.
- [x] **X3 — The ground reads as Karoo, which is the wrong half of the country.** Done.
      `generate_tiles.py` says so in its own prompt notes — "green for much of the year"
      — and the map is orange. The band distribution is even (measured: 15-17% each
      across the middle five), so it is not a generation problem: six of the eight
      SUBJECTS are orange-red, and `harmonise` is too gentle to pull the low bands back
      toward the green their palette entries ask for.
      *Done when:* the low bands read green against the high bands' ochre, measured as
      mean hue per band rather than judged, and looked at on two maps.
- [x] **X4 — Starvation is not proportional to the shortfall.** Done. Open in section F since
      September: being five grain short does the same damage, to every unit the player
      owns, as being five hundred short. Part II made this much more visible — a pit and
      a cut ration both exist to turn a catastrophic shortfall into a small one, and at
      present a small one is just as lethal, so both of them buy less than they should.
      *Done when:* damage scales with the fraction of the upkeep that went unpaid, a
      village one grain short loses nobody, and the replay is re-recorded with proofs.
- [x] **X5 — The neighbour trains itself to death.** Done, and it uncovered X6. Traced over a 24,000-tick match:
      it grows 14 villagers to 63 on land that feeds 64–77 in a good year, pinning its
      granary just above the training floor so it can never reach the build bar and puts
      up exactly ONE homestead in twenty minutes. Then the first real drought takes
      `feeds` to 16 against 63 mouths, every villager dies, and the grain climbs to 1,070
      with nobody left to eat it.

      `tasks/plan.md` section F and the Phase V6 notes both record this as "the AI
      raises households it has no grain to feed"; this is that, measured. It is not a
      balance question and it is not being treated as one: `economy.feeds` is the exact
      number the HUD puts in front of the human — "land feeds 63" — and the fix is to
      make the neighbour obey the rule the game states rather than to retune anything.
      The rule it is currently following, "replacements before anything else
      discretionary", is left over from when there were losses to replace.
      *Done when:* a match shows the village stabilising at a size its land carries
      rather than collapsing to zero, it builds more than one thing, and the replay is
      re-recorded with both proofs.
- [x] **X6 — The neighbour is timber-locked.** Done. With X5 in, a match ends with the AI
      holding 10 timber and two buildings, and it can never build again: it opens with
      90 and has no way to get more, because nothing in `decide` ever fells a tree. The
      woodland is not even passed to it. Everything else about its economy now works —
      it survives the drought, holds 50 villagers and banks 460 grain — and it has
      nothing to spend the grain on.
      *Done when:* the AI fells timber when it is short and builds past its opening
      stock, measured over a match, with the replay re-recorded and proved.
- [x] **X7 — Both villages starve on generated terrain.** Done. Section X complete. Found while measuring X6, and
      NOT caused by it: with felling on and off, at the same tick either way, both AI
      villages on `createHeightmap(64, 64, 0x0a1)` collapse to zero villagers at tick
      18,000 for want of grain. On the harness's flat map the same match survives (X5
      pins that). So it is the fields on real terrain — sited on worse ground, or too far
      from the people to be tended — rather than the economy. The AI now dies holding
      150 timber it cannot spend.
      *Done when:* the cause is identified rather than tuned around, and a match on
      generated terrain ends with both villages standing.

---

# Part IV — smoother ground

Asked for directly on 2026-09-24, with the suggestion to look at how Age of Empires 2
and Red Alert 1 did it. Both were researched before anything was changed, and both
turned out to answer the same way from opposite directions — see the commits for what
each actually does and which parts were worth taking.

- [x] **Y1 — Blend fronts that meander.** The masks were a dead-straight alpha ramp
      parallel to the tile edge, reaching under half a tile, identical on every tile.
      Now: reach 1.3 of a possible 2.0 so the mask decides where the boundary runs
      rather than the grid, and three octaves of noise perturbing the front so it has
      bays and headlands. Calibrated against a measured front-wander figure, and that
      figure is recorded in the manifest and asserted by a test, because a flat blend
      front passes every other gate this project has.
- [x] **Y2 — Four cuts of every boundary-tiling mask.** One cut per configuration
      stamps the same meander tile after tile along a straight seam, which reads as a
      scalloped sawtooth — the repetition is as legible as the straight edge it
      replaced, only at a different frequency. AoE2 carries four cuts of each
      directional mask for exactly this; the choice is hashed rather than taken from the
      low bits of x or y, because an isometric seam runs diagonally and `x & 3` lines up
      with it.

*Left alone deliberately:* the fields. They draw as hard-edged diamonds and that is not
the same defect — a worked field has a definite boundary, as AoE2's farms do. If they
want softening it is a decision about what a field IS, not about how tiles meet.

---

# Part V — the place it is actually set

Asked for on 2026-09-24: look up KwaZulu-Natal grasslands, the Drakensberg, Zulu
buildings, patterns and clothing, and make the terrain and buildings more like them.
The art had been generated from prompts rather than from references, and the references
disagreed with it in specific, correctable ways.

- [x] **Z1 — Ground from the Drakensberg.** The section was upside down: the range is
      Clarens sandstone capped by dark Jurassic basalt, and ours had the rock PALER than
      the sandstone below it. Sandstone is cream and honey now, basalt near-black. The
      low grassland prompt led with "deep orange-red earth" and got the Karoo again; it
      is summer-rainfall sourveld now — dense, tussocky, green.
- [x] **Z2 — Beehive huts with thatch courses.** The one most recognisable feature of an
      iQhugwane and it was entirely absent. Eight rings following the dome's profile, a
      low doorway facing the yard, taller proportions, warmer thatch. The ikhanda and
      indlunkulu with them, because they are the same building larger.

## Left to do, in the order worth doing it

- [ ] **Z3 — Clothing from references.** *Partly done:* the villagers already wore the
      isidwaba, the umutsha/ibheshu and the elder's isicoco; an ordinary `villager` kind
      now wears the umutsha and the umqhele (commit 7a0803f), and the pelvis defect that
      put a ball between every villager's ankles is fixed. Open: the isicholo for married
      women (it competes with the carrier's head-load for the same silhouette). Was: `tools/art/make_unit.py`. The figures wear a
      generic wrap. The vocabulary is specific and well documented: **ibheshu** (the
      calf-skin back apron, knee-length on a young man), **isinene** (the front, rolled
      rope-like hide strings), **umqhele** (the fur headband), **isicoco** (the head-ring
      a married man wears), and for women **isidwaba** (the cowhide skirt) and
      **isicholo** (the wide hat that marks a married woman). Status is legible in it —
      leopard skin is royal and restricted, which is worth honouring rather than
      scattering about.
- [ ] **Z4 — The triangle, for the player's colour.** *Moot for now:* the livery rides
      on the impi's shield overlay, and since ADR-0021 there is one village on the map
      and ordinary villagers are no longer drawn as the impi — only the mounted figure
      shows a livery, with nothing to tell it apart from. The setup screen's "Shields"
      choice is therefore nearly invisible; whether to drop it or move the colour onto
      villagers is the owner's call. Was: Zulu beadwork's basic geometric
      shape is the triangle, and `impi-shield` / `impi-team` already exist as the overlay
      the player's colour is painted on. Worth noting before using it: the orientations
      carry specific meaning — a triangle pointing down is an unmarried woman, up an
      unmarried man, two joined at the base a married woman — so the motif can be taken
      as a visual vocabulary without claiming those meanings for a faction colour. The
      *isishunka* palette (white, light blue, dark green, pale yellow, pink, red, black)
      is the reference for the colours themselves.
- [x] **Z5 — More base-tile variants.** Done: six sources a band (five for riverbed and
      thornveld), 20-24 tiles a band against 12. Thirteen generations were looked at and
      rejected, each recorded in `REJECTED` in generate_tiles.py — including seed 1504,
      which the note there named but the list never held, so widening the set made it
      again; and riverbed 1106, a tiled gravel grid the new stripe score caught at 0.92.
      Thornveld stops at five: four tries at a sixth all came back as one big clump.
      Tone per band unchanged. Was: A large expanse of one ground repeats visibly at
      three variants per band — the sandstone plateau on Thaba Bosiu shows it. Six would
      cost 24 more tiles on a page that is already 427.
- [x] **Z6 — Fields still draw as hard diamonds.** Done: fields are always single
      tiles (minSpacing 1.6), so their outline is a superellipse (FIELD_ROUNDNESS 1.5)
      between the diamond and an oval, keeping its points and its definite dissolving
      edge; spill is measured against that outline. A homestead's insimu is an irregular
      patch, not a surveyed square. Was: Raised twice and deferred twice on the
      grounds that a worked field has a definite boundary, as AoE2's farms do. Against
      the softened ground they are now the most artificial thing on screen, so the
      argument has weakened. A decision about what a field IS, not about how tiles meet.

## Part VI — terrain, continued

Done this pass: the camera is clamped to the map's diamond rather than its bounding box
(it could be parked on an entirely empty screen); the world now fades to background at
the map boundary instead of being cut off; ground tiles are cut with overlapping rather
than quadrant crops, which halved the per-tile contrast spread that made open veld read
as a quilt; savanna-low seed 1501, a ploughed field, is rejected and replaced.

Left open, in the order they seem worth doing:

- [x] **V1 — Water is flat.** Done: a procedural ripple overlay (`make_water_surface` in
      postprocess.py) — sixteen tiles sampling one wave field that repeats every four
      tiles, so it is continuous across tile edges — drawn in the top mesh over the
      unchanged depth-shaded fill. In the game, 31,648 river pixels: luminance sd 7.8,
      2,235 colours. No draw calls added. Was: measured over 15,586 river pixels: luminance sd 1.53 and
      five near-identical colours, against 15 to 21 for land. It reads as a plastic
      sheet. `terrain.ts` records a deliberate decision not to texture it — "at this
      scale a river reads as a colour and a shape, and a textured one would read as more
      dry ground" — which is about a RIVERBED and does not settle whether the surface
      should have any modulation at all. Note the trap already paid for once: per-tile
      variation returns the quilt of blue lozenges that `smoothWaterDepth` was written to
      remove, so anything here has to vary at sub-tile scale, which a flat Graphics fill
      cannot do.
- [x] **V2 — The hard bands are twice the contrast of the soft ones.** Done:
      `lift_shadows` in postprocess.py scales the below-mean half of any tile over a
      spread of 22 by the one factor that brings it to 22. Donga 29.0 -> 22.4 (darkest
      fiftieth 31 -> 58), rock 27.6 -> 22.2 (19 -> 44); highlights, hue and plate size
      untouched. Was: Per-tile contrast
      runs 14 to 21 for bands 0-4 and 29.9 (donga) and 27.2 (rock) for the broken ones,
      whose darkest fifty-first pixel reaches luminance 35 on a base of 175. Large
      expanses of donga dominate any frame they are in. Before touching it: the coarse
      feature scale is SETTLED and documented in generate_tiles.py — finer cracks were
      tried three times and came back as flat orange, because they do not survive an
      eight-to-one downscale. The open question is the contrast of the shadow, not the
      size of the plates.
- [x] **V3 — A periodicity check in the pipeline.** Done: `stripe_score` in postprocess.py
      prints `stripe N @period` for every source beside its seam score, flagging over 0.9
      and refusing nothing; it agrees with `measure.py stripe` to two places. Was: The row/column measure that caught
      seed 1501 lives only in this session's scratch. It belongs in `postprocess.py`
      beside the seam score, printed per source, so a ploughed field is caught when it is
      generated rather than after it ships. It must not become a gate on its own: seed
      1504 scored clean and was unusable.
- [x] **V4 — The remaining lattice.** Resolved by Z5: with twice the sources a band, open
      savanna at close zoom (camera zoomed six steps in) shows no diamond outlines — the
      only diamond in frame was the cursor. Was: Open ground is much improved but faint diamond
      outlines are still visible at close zoom. The overlapping cuts share 80% of their
      source, so a large feature sits at nearly the same tile-relative position in all
      four — the opposite failure to the one just fixed, and the two trade against each
      other at a fixed source size of 512px.

- [ ] **V5 — The river bank is a staircase.** Seen at close zoom beside the default
      veld's river: the darker bank ground on the LAND side of a shore steps along in
      whole diamonds, a sawtooth of lozenges following the tile grid, where the water
      side (V1) and open ground (V4) no longer show the grid at all. The shore masks come
      from the same dissolving transitions as a band seam, so the question is why they
      read as solid steps here — likely the bank's contrast against the grass, which is
      far higher than one grass against another.
      *Investigated (2026-09-25):* a synthetic diagonal coast built from the pipeline's
      own functions reproduces it — the pebble bank on coastal land tiles is a column of
      diamonds with notches between. Tried: where two ADJACENT edges are wet, fade from
      their shared vertex (mean of the two inward distances) instead of taking the max of
      two edge falloffs. It straightens the contour inside each tile and narrows the band,
      but the scallops stay, and they are structural: a bank under a tile wide along a
      diagonal pinches to nothing at every tile point, because the inland tile beyond
      has no water neighbour and draws no bank. Per-tile masks cannot make it straight.
      Two real options, both global: (a) a bank that contrasts less with the ground
      behind it — each band's own ground darkened as wet soil, instead of one riverbed
      set, reversing the "one set, not eight" decision in postprocess.py; or (b) masks
      that look two tiles out, which widens the mask vocabulary. Not done.
      *Then tried (a) cheaply:* one translucent damp-earth wash instead of the pebble
      set, so the bank darkens whatever ground it lies on. The synthetic coast shows the
      same scalloped band, only darker — tone does not hide a shape. That leaves (b).

*Note for whoever picks this up:* `tools/art/generate_tiles.py` drives a local FLUX
model and the weights ARE cached (~9GB in ~/.cache/huggingface), so terrain subjects can
be regenerated — about 45 seconds an image, three per subject. `make_unit.py` and
`make_building.py` need Blender, which is on this machine. The atlas is REPACKED rather
than rebuilt: origins for the 2,600 unit frames are recovered from the shipped
atlas.json, because the origins file they were written with is long gone.
