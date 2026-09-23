# SPEC — village depth, legible ground, a HUD you can play from

Source of requirements: the project owner's brief of 2026-09-23, verbatim —

> new building types and functions, better terrain graphics and terrain tiles that
> don't abruptly end at 90-degree angles, new gameplay features for village
> management, better UI.

Nothing below is invented; each section takes one clause of that brief and costs it
against the code that exists. Where a clause admitted more than one reading, the
reading chosen is stated and why.

The rules in `CLAUDE.md` are binding throughout — determinism, boundaries, commands as
the sole mutation path, `t()` for every user-facing string with **nested** keys, tuning
in the data files, and the Definition of Done per change.

---

## 1. Ground that does not end in a wall

### The finding

The brief says terrain "abruptly ends at 90-degree angles". Measured rather than
assumed, and the first hypothesis was wrong: the heightmap's contours are *not*
axis-aligned. A straightness probe over three seeds found only 2.9–4.7% of band-boundary
edges run straight for six tiles, and a dump of the band map is visibly blobby and
meandering. Domain-warping the noise would fix nothing.

What is actually on screen is this: `MAX_CLIMB` is 1, `ELEV_STEP` is 8px against a 32px
tile height, and `drawTile` draws a vertical face for **any** drop at all —
`if (eastDrop > 0)` — finished with a lip stroked at `shade(base, 1.18)`. So every
single-level step, which is *walkable ground* and the commonest feature on a rolling
map, is drawn as a quarter-tile-tall vertical wall with a bright line on top of it.
The contours are everywhere; therefore so are the walls. That is the 90 degrees.

The transition blending is not broken and is not the problem — a one-level step is not a
cliff, so `transitionsFor` does run — but the blend is laid on the ground *below* an 8px
wall, so the texture gradient is behind a hard edge and cannot be seen doing its work.

### What changes

1. **A walkable step stops being a wall.** Only a real cliff — `isCliff`, a drop past
   `MAX_CLIMB` — draws a face and a lip. ADR-0006 wants cliffs legible at a glance and
   that is preserved exactly; what goes is the wall drawn where there is no cliff.
2. **The ground becomes continuous.** Tile tops are drawn from per-corner heights
   averaged off the tile grid rather than as flat diamonds at one height, so a
   single-level change is a ramp. Corners adjacent to a real cliff snap back to the
   tile's own height, so a cliff stays a hard edge.
   This is **render-side only**: the simulation keeps per-tile integer heights, and
   movement, pathing and cost are untouched.
3. **Corner seams get blended.** `transitionsFor` walks four orthogonal neighbours, so
   higher ground meeting a tile only at a corner contributes no blend and leaves a sharp
   notch at every diagonal. Corner masks close it.
4. **Water gets a bank.** Water is a flat-filled diamond, so a river or a coast is a
   hard staircase — the one place a literal 90-degree edge survives. It gets the same
   treatment as a band seam.

### Acceptance

- A test asserts a face is drawn for a drop greater than `MAX_CLIMB` and not for a drop
  within it.
- A test asserts corner heights are the mean of the tiles meeting at that corner, and
  that a corner touching a cliff takes the tile's own height instead.
- A test asserts a tile whose only higher neighbour is diagonal receives an overlay.
- A test asserts a shore tile emits a bank overlay and open water does not.
- Draw calls at the perf harness's framing do not regress.
- **Looked at in a browser.** Every art defect this project has shipped passed every
  gate; `CLAUDE.md` says so and it is the governing rule for this section.

### Not in this section

Per-corner heights in the *simulation*. Slope-aware movement cost already exists on the
tile grid and reopening it would move the replay, the pathing budget and ADR-0006 for a
picture.

---

## 2. Buildings that do something the village needs

### The finding

Five building types: `Isibaya`, `Umuzi`, `Ikhanda`, `Indlunkulu`, `GrainStore`. Four of
the five differ only in the numbers on `grainYield`, `cattleYield` and `trains` — the
`BuildingSpec` struct has no vocabulary for a building that *does* anything. Since the
pivot the failure condition is starvation and nothing in the catalogue addresses it
except by adding a flat yield.

### What changes

1. **`BuildingSpec` gains a way to express an effect with a radius**, so a building can
   act on the fields, the herd or the people near it instead of only adding to a total.
2. **Umgodi — the grain pit.** Cheap, one tile, yields nothing. It *buffers*: in a
   shortfall the pit pays out before anybody starves, and refills from surplus. Aimed
   squarely at the only failure condition the game has.
3. **Isiziba — the weir.** Sited only on a shore tile. Fields within its radius lose
   less condition to drought. Ties farmland, water and weather together, and makes the
   river worth settling on for a second reason.
4. **Isibaya sezimbuzi — the small-stock pen.** Cheap, small, a steady modest grain
   yield at low upkeep: the hedge for a village that cannot feed a cattle herd. Carries
   the goats and fowl already placed around the dwellings.

Names follow `docs/CONTENT.md`: isiZulu, not translated, glossed once.

### Acceptance

Per building: a headless test that the effect fires and is bounded by its radius; costs
and work in tuning, not inline; an i18n entry under a nested key; a command-panel entry
that says why it cannot be built rather than failing silently; the AI able to choose it;
a sprite, or the documented primitive fallback.

---

## 3. Village management

### The finding

A year is ten minutes and the only window onto it is `Drought 0%`. A shortfall has
exactly one outcome — people die — and the player has no move to make in a bad season
other than the one they should have made ten minutes earlier. Fields decay unless stood
on, which is a chore rather than a decision.

### What changes

1. **A calendar.** Year, season and what the weather is doing, named. The economy is
   already seasonal; nothing says so.
2. **Rationing.** A village-wide order that cuts the ration: less upkeep, slower work,
   nobody dies. The counterplay to a bad year, which at present does not exist.
3. **Fallow.** A field left deliberately unworked recovers condition faster than one
   being worked. Makes siting more fields than you can tend a real decision instead of
   a mistake.

### Acceptance

Each is a command or a pure function of the tick, tested headlessly, with its numbers in
`tuning/tuning.json` and its readout in the HUD. Rationing must be reversible and must
never produce a state the ledger cannot serialise.

---

## 4. A HUD you can play from

### The finding

Screenshotted at 1440x900 and looked at: the debug overlay occupies the top-left
quarter of the screen by default; the command panel is an unstyled vertical stack in
which a trade offer, a slaughter and an alliance are the same object; "NOTHING SELECTED"
is the heading for a panel showing seven actions; the resource bar is one line of text.
`tasks/plan.md` section F already records that the panel "offers actions that silently
fail".

### What changes

1. **The HUD is restyled** — grouping, chrome, typography, spacing — and the debug
   overlay is off by default behind its existing toggle.
2. **A build palette** with cost, affordability and a stated reason when an action is
   unavailable, replacing the silent failure.
3. **The calendar readout** from section 3.
4. **A selection summary** — what is selected, how many, and what they are doing.
   `src/sim/roles.ts` already computes the last of these for the renderer.

### Acceptance

Strings through `t()` with nested keys — the lint rule refuses literals in `src/ui`.
Tests for the affordability and reason logic. Looked at in a browser at 1440x900 and at
a narrow width.

---

## Out of scope

Multiplayer, the AI balance findings in `tasks/plan.md` section E, per-corner heights in
the simulation, and any retuning of the economy that is not a named item above.
