# ADR-0021: Neighbours live on their books

**Status:** Accepted — 2026-09-24

Carries out the part of ADR-0020 that moved neighbours off the map, and decides the three
questions that ADR left for roadmap Phase B4. It also settles the question ADR-0020 left
open about lockstep multiplayer.

## Context

Until now the neighbour was a second village simulated on the map. It had its own huts,
fields and herds, and the AI in `src/sim/ai/opponent.ts` ran it by issuing commands like
a player. Once the race was gone (ADR-0020), it did two things that matter: it traded
and it allied. Both happen on its ledger. `trade.ts` prices every deal from the
neighbour's own stores, and `alliance.ts` moves cattle and grain between ledgers.

On the map it also did harm. Soaked on the real opening, the AI's herding branch sent
every spare villager at the herds. That began 115–140 stampedes over five years and
crushed 75–107 of its own people. It also exposed two bugs in the opening: the
neighbour's village was founded for player 0, and every AI build was founded free (see
the Phase B2 notes in `docs/ROADMAP.md`).

ADR-0020 asked three things of this phase:

1. What are a neighbour's stores when nobody simulates its village?
2. What happens to alliances, whose tithe and relief assumed two herds on the map?
3. Is lockstep multiplayer still worth keeping possible?

## Decision

**A neighbour is a ledger row with no village on the map.** `Economy.offMap` marks it.
The ledger's upkeep skips it, the census never counts or announces it, and
`src/sim/neighbours.ts` runs its season on the upkeep cycle:

- **Grain goes back toward a full granary and is pushed around by the same weather as
  the player's.** Each season it closes a share of the gap to `grainHeld`. Then it gains
  or loses `harvestSwing × (open − meanHarvest)`, where `open` is the same `1 − d²` an
  open field reaps. In a wet season it puts grain by. In a dry one it eats into the store.
  In a full-severity drought its granary runs out, it goes hungry, and grain is the
  dearest thing on the trade screen, in the same bad year the player has. Scarcity that
  hits everyone at once is what makes trade worth anything.
- **Herd and wood recover a share of the gap toward what a village like it holds.** Trade
  and tithe can strip them, but not for good, and not for free: after buying all its
  timber, the next load costs more.
- **It answers and asks for ties the way the AI did.** It accepts an offer from anyone it
  thinks well enough of while it has no ally. It asks for a tie itself only when it has
  gone hungry with nobody to turn to. It never breaks a tie and never starts a trade,
  because both of those take from the other side without that side agreeing.

**Alliances stay as they are.** Tithe and relief only ever touched the ledger. The tithe
is a fraction of the ledger herd, which a neighbour still has. Relief goes to whoever
went hungry, and a neighbour can now go hungry on its books. Nothing in `alliance.ts`
changed.

**The AI no longer runs in the game, and is kept.** No match starts it. It stays as an
autoplayer, a village "played well", for the soak harness (`SOAK_POLICY=ai`) and for its
own tests. ADR-0020 warned that the AI was the only thing exercising a second player in
soaks. The soak now seeds the player's own opening through the same function `main.ts`
calls, and can put the AI in the player's seat.

**Lockstep multiplayer is shelved, not removed.** With no rivals and no race, there is
nothing for a second human to do in the same valley. The determinism rules, the
command pipeline, the replay gate and the sim/render boundary all stay. They are how
bugs get caught here whether or not a second player ever joins. The per-viewer fog path
and `docs/MULTIPLAYER.md` are left as they are, with no further work planned. Removing
them would take more effort than leaving them, for no benefit.

## Consequences

- The map belongs to the player. The six herds stay, now as wild herds at a range of
  distances. The one that was penned in the neighbour's kraal grazes in the open.
- Stampedes in a five-year soak fell from 115–140 to 0–9, and an AI-played village lost
  nobody. What killed people on the map was the second village.
- Trade prices now move with the season in a way a player can plan around. The
  neighbour's granary swings roughly 200–670 through a year and runs out in the worst
  droughts.
- `Build` founds for the owner it names (`d − 1`) and only during the opening. That fix
  came with Phase B2 and has to stay: with no neighbour village, the only thing that
  founds anything is the match script.
- The match still has two factions, and the second is the neighbour. The setup screen
  gives it the first people the player did not choose. That sets how it deals, since
  trade margins are per faction.
