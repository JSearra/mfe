# ADR-0006: Per-tile elevation, with cliffs as an emergent property

**Status:** Accepted — 2026-09-13
**Relates to:** `ARCHITECTURE.md` §3

## Context

The brief never stated whether terrain is flat, yet all four of its map scripts lean on
verticality: Thaba Bosiu's sandstone mesas with impassable cliffs and narrow passes, Karoo
koppies, Magaliesberg parallel ridges and poorts, and dongas offering projectile cover.

Elevation is load-bearing across projection, depth sorting, pathfinding cost, line-of-sight
and art simultaneously. It cannot be deferred: reserving a height field in the tile record
saves almost nothing, because retrofitting height into depth sorting and pathfinding is
close to rewriting both.

## Decision

`Uint8Array` height per tile, AoE2-style.

```
screenY = (tx + ty) * TILE_H / 2 - height * ELEV_STEP
```

**A cliff is not a tile type.** It is an emergent property of `|Δheight| > MAX_CLIMB`
between adjacent tiles.

This one rule produces every landform the brief asked for:

| Brief's landform | Heightmap expression |
|---|---|
| Thaba Bosiu plateau, impassable cliffs, narrow pass | High-tile plateau ringed by an unclimbable delta, with two tiles where the delta is gradual |
| Karoo dolerite koppies | Isolated height spikes, impassable on every edge |
| Magaliesberg poorts | Gaps where a ridge line drops below threshold |
| Dongas | Negative deltas — impassable across, traversable along, LOS-blocking |

Height additionally drives slope movement cost, line-of-sight blocking, and extended vision
range from high ground — which is most of the tactical interest in those four maps.

## Consequences

- Map generation becomes heightmap generation. The four scripts are height functions, not
  bespoke tile-placement algorithms. This is a significant simplification.
- Tile picking must account for height, or every click in hilly terrain is wrong. This is
  a Phase 2 acceptance criterion, not an afterthought.
- Cliff faces are tall occluders and belong in the depth-sorted dynamic pass, **not** in the
  terrain `RenderTexture` bake — a unit behind a cliff edge must sort against it.
- Art cost: cliff-face variants per height step, and slope/ramp tiles. Folded into the
  Phase 2 asset requirements.
- Line-of-sight needs a height-aware raycast, which interacts with fog of war when that
  lands. Noted in the backlog rather than built now.
