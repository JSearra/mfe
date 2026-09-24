# Reference material, and what was taken from it

This project's art is generated — Blender for figures and buildings, a local diffusion
model for ground. Nothing here is third-party work. But technique has been studied from
other people's art, and this records what was consulted, what was learnt, and what was
deliberately left alone.

It exists for two reasons. Studying somebody's work and then writing your own is normal
practice and needs no permission; **copying it needs a licence**, and the difference is
worth being able to demonstrate rather than assert. And the negative results are the
more useful half — a technique that cannot transfer is worth recording once so nobody
tries it again.

---

## 1. No third-party asset is in this repository

Everything under `public/assets/` is produced by `tools/art/`. There is no imported
sprite, tile or model. The reference material below was downloaded to a scratch
directory outside the repository, read, and not committed.

This matters most for the one item on the list that is **CC-BY-SA 3.0**
(`grassland_tiles.png`, Clint Bellanger et al.). Share-alike is viral: anything that
incorporated it would inherit the licence. It was not opened for that reason, and
nothing derives from it.

---

## 2. Isometric ground — rubberduck, CC0, OpenGameArt

`ground_tiles_sheets.zip`. Eight 512x224 sheets, 8x7 tiles of 64x32 — the same tile this
project uses, so the numbers are directly comparable.

**Taken: the fading edge dissolves rather than ramps.** Reading the alpha of one of their
grass transitions across its fade gives

    @@%%%%@###*+++==++--=:-::...

which is not monotonic. The alpha breaks into speckle, so two grounds interleave pixel
by pixel instead of cross-fading. AoE2's blendomatic names a mode for the same thing —
"rough hard edges, spraylike" — so two independent references arrive at it. Ours
perturbed the POSITION of a smooth ramp, which meanders a boundary but leaves the
gradient clean, and a clean gradient at this size reads as an airbrush. See
`TRANSITION_DISSOLVE` in `tools/art/postprocess.py`.

**Not taken: feathering the tile past the diamond.** Their base tiles are soft for about
two pixels beyond the diamond edge — measured, mean alpha 0.17 in the band just outside
it, where ours is 0.00 — which softens every tile-to-tile join. It cannot transfer.
That works because their renderer draws tiles as overlapping sprites; ours is a
watertight mesh whose quads share corner positions exactly, so a feather would open gaps
to the background rather than overlap a neighbour. The UV inset in
`render/scene/terrainGeometry.ts` is our answer to the same problem.

---

## 3. Isometric buildings — rubberduck, CC0, OpenGameArt

`building_pack_03_sheets.zip`. Blender-rendered medieval timber-framed structures, shipped
in `shaded`, `cloudy` and `no_shadow` variants.

**Taken: a building's shadow is the size of the building.** Every structure on those
sheets is planted by a cast shadow. Ours were not, and the cause was a defect rather
than an omission — `drawDecal` gave a two-tile isibaya the same ellipse as one villager.
Now scaled from the footprint. See `shadowRadius` in `render/scene/entities.ts`.

**Not taken: baked directional shadows.** Theirs fall in the light's direction and carry
each building's actual silhouette. That needs a shadow catcher; EEVEE has none, and
moving the buildings to Cycles to get one would light them differently from the units
standing among them — a worse inconsistency than the one it would fix.

**Not relevant: the buildings themselves.** Timber-framed European barns, against an
1820s southern African village. There is nothing in them this game has a slot for.

---

## 4. Not consulted, and why

- **PixVoxel Wargame** (CC0, 203MB, one archive unpacking to ~10GB) — Red Alert style
  armour and artillery. Combat was retired in Phase V6 (ADR-0019). There is no unit in
  this game those could stand in for.
- **kenney_medievalRTSpack, castle_7, wyrmsun, Sprites.zip** — medieval European
  settings, same objection.
- **grassland_tiles.png** — CC-BY-SA, see section 1.

---

## 5. How AoE2 and C&C actually do it

Read from documentation rather than from art, and recorded because the terrain blending
here is built on it.

**AoE2's blendomatic** carries nine blend MODES of 31 tiles each, 279 masks. The modes
are named for their edge quality — "rough transition, full, used for dirt, grass",
"smooth transition, full length", "rough hard edges, spraylike", "sharp edges" — so the
irregularity is a deliberate, named axis rather than an accident. Terrain priority
decides which of two grounds floods onto the other, and four cuts of each directional
mask are selected on "the lower 2 bits of tile destination x or y" so a long boundary
never repeats one shape.

We take the rough edge and the four cuts. We depart on the selection: `x & 3` repeats
every four tiles along a row and an isometric boundary runs diagonally, so the two line
up and trade a sawtooth every tile for one every four. Ours is hashed — see
`blendVariant` in `render/scene/terrainBand.ts`, which has a test that walks the diagonal.

**Command & Conquer's LAT** ("Lookup Adjacent Tile") uses 16 tiles per terrain pair,
indexed by a four-bit mask of the neighbours — which is the indexing this project
already had — with hand-drawn irregular boundaries rather than alpha blending.

**The deeper lesson from both**, and it took three passes at the blending to see it:
terrain type and elevation are INDEPENDENT in both games. Grass exists at many
elevations; a slope is a slope. Ours had the ground band BE the tile's height, so every
one-level step was also a complete change of texture — 18% of all adjacent tile pairs, a
boundary every 5.5 tiles. No blend can rescue that. See `render/scene/ground.ts`.

Sources: SFTtech/openage `doc/media/blendomatic.md`; ModEnc's LAT system page.

---

## 6. Place and material

For the terrain palette, the buildings and the terminology. Recorded in `CONTENT.md` as
policy; these are the specific references behind the current art.

- **Drakensberg**: cream Clarens sandstone capped by Jurassic flood basalt — the dark
  cliff above the pale rampart. The ramp had rock paler than the sandstone beneath it,
  which inverted the section. (UNESCO, Maloti-Drakensberg Park.)
- **KwaZulu-Natal mistbelt grassland**: summer-rainfall sourveld, short and tussocky and
  green through the wet months. The low band's prompt led with "deep orange-red earth"
  and produced the Karoo. (BirdLife South Africa.)
- **iQhugwane**: dome-roofed, taller than wide, golden-brown thatch in visible
  horizontal courses, with a low doorway. The courses were entirely absent.
  (Wikimedia Commons' iQhugwane category.)
- **umuzi**: beehive huts in a circle around a central cattle enclosure.

Still unused, and listed in `tasks/plan.md` as Z3 and Z4: the clothing vocabulary
(ibheshu, isinene, umqhele, isicoco, isidwaba, isicholo) and Zulu beadwork's triangle.
The triangle carries specific meaning by orientation — unmarried woman, unmarried man,
married woman — so it can be taken as a visual vocabulary without claiming those
meanings for a faction colour. `CONTENT.md` section 1 is the governing position: this is
a live subject with descendant communities, and consultation is a line item rather than
a localisation-time afterthought.
