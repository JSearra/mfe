# ADR-0009: Keep presentation constants out of the hashed tuning file

**Status:** Accepted — 2026-09-13
**Relates to:** `ARCHITECTURE.md` section 1, ADR-0002

## Context

`CLAUDE.md` requires that tuning constants live in one data file rather than inline in
systems, and `tuning/tuning.json` is hashed into every replay so that a replay recorded
against different constants reports *that* as its cause instead of an unexplained hash
difference.

Phase 1 introduced the first constants that are not simulation tuning at all: camera pan
speed, zoom limits, edge-pan margin, debug grid radius. Filing them in the same place would
have been the literal reading of the rule, and wrong — every camera tweak would have
invalidated the golden replay and demanded a re-record for a change that cannot alter a
simulation outcome.

A determinism gate that fires on changes which cannot affect determinism is a gate people
learn to re-baseline without reading. That is exactly how this kind of check dies.

## Decision

Two files:

- `tuning/tuning.json` — simulation constants. Hashed into every replay.
- `tuning/presentation.json` — camera feel, debug scene, anything the player sees and the
  simulation never reads. **Not** hashed.

The test is not "is it a magic number" but "can changing it alter a simulation outcome".

## Consequences

- The replay gate keeps its meaning: it fires only for changes that could genuinely diverge.
- A new constant needs that question answered once. Getting it wrong in the safe direction
  (simulation constant filed as presentation) is the dangerous one, because it would let a
  real divergence through unremarked — so when in doubt, it goes in `tuning.json`.
- `src/render/presentation.ts` loads the presentation file. Nothing under `src/sim/` may
  import it, which the existing boundary lint already enforces.
