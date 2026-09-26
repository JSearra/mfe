# ADR-0023: Water is drawn, not held

**Status:** Accepted — 2026-09-26

Settles the question ADR-0022 left open. That ADR named water as a resource and set it
aside, because tracking it meant first deciding who draws it, who drinks it and what a
drought does to it. The project owner decided those on 2026-09-26.

## Context

Rivers already matter in this game. Fields beside them hold up in a drought, fish feed a
village the weather cannot touch, and the weir needs a bank to stand on. But nothing
made a village *need* to be near water. A village on a dry ridge ran exactly as well as
one on the bank.

## Decision

**People drink; cattle and fields do not.** Every upkeep each person needs
`waterPerUnit`. Cattle are taken to drink where they graze. Rain waters the fields, as it
always has.

**Water comes from four places:**

1. **Carriers**, a new job (`Work.Water`) filled by labour the way fishing is. The
   allocator puts carrying spots on riverbanks near the homesteads. A carrier fetches
   `carryPerUpkeep`, less the farther the spot is from the nearest dwelling, since a long
   walk means fewer trips. A river gives less in a drought.
2. **Wells**, a new building. A well can be dug anywhere and needs one person to draw
   from it. It gives a steady amount that falls off in a drought, though never to
   nothing. A village with wells can live away from the river.
3. **The weir** (isiziba) now also holds water back: a reserve that fills from surplus
   and is drawn down in a shortfall, like a grain pit's reserve.
4. **Rain** falls on the roofs. Each dwelling gathers some water in proportion to how
   wet the season is, and none at the height of the dry.

**The sea is salt.** Only a river bank or a lake shore can be drawn from. Water counts as
sea by the rule the beaches already use: a body of 300 tiles or more. River reaches are
cut short by their drifts and never come near that. The rule now lives in
`src/shared/heightmap.ts` (`seaMask`), and both the renderer and the simulation read it
there.

**Water does not keep.** What is held evaporates quickly (`waterEvaporatePerCycle`), so a
village cannot store a season's water in pots. The weir is the one store that holds.

**Thirst slows work; it harms nobody.** A shortfall slows work in proportion to how
short the village fell, multiplied with the ration's own factor. A village half-short of
water works like one on a cut ration. It never damages anyone.

## Consequences

- The ledger gains a water column (index 6, appended). Water is not food and is not
  traded. Save version 8.
- A new `BuildingType.Well` (9) and building specs gain `waterYield` and
  `waterStore`. A new `Work.Water` (8) and a new `EventType.Thirsty` (31) are appended.
- Fishing no longer pays a water carrier who happens to stand on a bank.
- The resource bar carries water and says when the village is thirsty, and the guide
  explains where water comes from (CLAUDE.md: budget for the telling).
- The replay hash changes. It is re-recorded under the CLAUDE.md procedure.
