# ADR-0020: The game is a builder, not a race

**Status:** Accepted — 2026-09-24

Supersedes the objective in Phase V1 of the roadmap (settle a number of households and
hold them fed) and the framing of neighbours as rivals in ADR-0019. It does not supersede
ADR-0019's central decision — the game is a village, not a war — and it takes that
decision further.

## Context

ADR-0019 turned an RTS into a village simulator, but it kept the shape of a match: two
villages race to settle sixty households and hold them fed for half a year, and whoever
gets there first wins. Playing it showed that the race was left over from the RTS rather
than something the village needed:

- Four AI matches in five ended in total famine, with villages peaking at 41–48 households
  against the 60 needed. The target was pushing every village into raising households it
  could not feed.
- The "Village 24/60" readout asked for more people. The actual strategy was always more
  land, and the resource bar had to be built specially to point back at that.
- The only reason anything in the game was a rival was the win condition. Trade and
  alliances, the two things neighbours actually do, are cooperative.

Asked directly on 2026-09-24, the project owner said: *"The goal of the game is to build
up your village. We don't need a population cap. The challenge is in managing all the
various aspects of the village, such as the cattle, the farming, fishing, etc. It's more
of a city builder than a real time strategy game. More like Tropico or SimCity."*

## Decision

**The game is an open-ended village builder.** There is no win condition and no
population cap. A game has no end.

Concretely, answered by the owner in the same session:

- **Nothing ends a game.** Starvation shrinks the village without ending it, and a village
  that shrinks can grow again. If a village empties completely the player is told, and
  offered a fresh start, but the simulation is not stopped.
- **Starvation should be rare when the player plays well.** It stays the thing to be
  afraid of, but it should be a consequence of bad decisions, not the normal way a game
  goes. The current tuning, where famine collapse is the usual ending, is too harsh.
- **Work is assigned indirectly, with a manual override.** Fields, kraals and fishing
  spots take people from nearby homesteads without being told to. The player decides what
  exists and where it goes. Selecting people and giving direct orders stays for urgent
  jobs, like taking a herd before it bolts.
- **Neighbours move off the map.** They become a trade screen rather than villages
  simulated on the map, and there is no longer anyone to race.
- **Pressure comes from the land, the weather and the player's own decisions.** Nothing
  comes from outside the valley: no refugees, no forced moves, no traders arriving.
- **The player's attention is on the village as a whole, not on named individuals.**
  People stay anonymous, and the land has to show what state things are in.
- **The veld changes strongly with the seasons**: green in the wet season, gold then
  grey-brown in the dry, and harsher still in a drought.
- **Alliance relief stays as it is** until the economy has been retuned. The open question
  from Phase V5 is deferred and not answered here.

What is explicitly NOT changing:

- Cattle herding, flocking and stampedes. They remain the defining mechanic (ADR-0014,
  ADR-0017).
- Determinism, the command pipeline, the sim/render boundary and the replay gate. These
  are how bugs get caught here, whether or not multiplayer ever ships.
- The platform, the art pipeline and `docs/CONTENT.md`.

## Consequences

**The order of work is the same argument as ADR-0019's, applied again.** The win
condition goes first, because everything else is balanced against it. Tuning an economy
towards sixty households and then removing the sixty would mean tuning it twice.

**Indirect labour comes before the retune.** The single largest cause of death found in
play was fields left untended. Assigning work automatically changes who tends them, so it
moves every number a retune would be aiming at. Retuning first would have to be done again
afterwards.

**Taking neighbours off the map removes the AI as a command source on the map.** The AI
was also the only thing that exercised a second player's worth of the simulation in soak
tests. Whatever replaces it has to keep the soak harness honest. The rule in `CLAUDE.md`
that a harness must seed a starting force applies to a single village as well.

**Lockstep multiplayer is an open question and is not decided here.** Most of the hard
discipline in this codebase exists for it, including the per-viewer fog path and
`docs/MULTIPLAYER.md`. With no rivals and no race it has less obvious use. Determinism
stays either way, for the replay gate. Whether the fog and the multiplayer plan are still
worth maintaining is for a later ADR.

**Water is already built.** Rivers with dry crossings, coastlines and fishing came in with
commit `4f7d310`, before this decision. They already fit it: fishing is a steady income
that the weather does not touch, which makes a village's site matter.
