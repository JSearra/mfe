# ADR-0019: The game is a village, not a war

**Status:** Accepted — 2026-09-15

Supersedes the framing in ADR-0014 (the stress curve is the mechanic) only as to *why*
the herd matters. It does not supersede the mechanic itself; see Decision.

## Context

The brief this project was built from described a real-time strategy game: an army, an
opponent, a map to take. Six phases and a backlog later that game exists and can be played
end to end, and playing it is what produced this ADR.

**Two matches were played to an outcome in September 2026. Neither contained a fight.**

The first ended in defeat at tick 4768 — four minutes — without the player ever meeting an
enemy. The whole impi starved while holding 136 cattle, because the economy was net −7.1
grain per upkeep at tick zero in perfect weather. The second, after that was corrected,
ended in victory at tick 10211 with no order issued at all: the herd grew past the
threshold on its own.

What is striking is not that the balance was wrong twice. It is *what the game was about
on both occasions*. Every decision that mattered was economic — whether grain would last
the dry season, whether a herd was wealth or a liability, whether to put up a granary or
hold the surplus. The combat systems were present, correct, tested, and irrelevant. The
AI opponent never became strong enough to threaten anyone because it could not feed
itself, and the fix for that was economic too.

This is not a complaint about balance. Balance is downstream. The systems carrying the
game were the ones the setting actually suggests, and they carried it without being asked
to.

The setting has been pointing this way from the start. `docs/CONTENT.md` already commits
the project to Cobbing's argument that the Zulu-centric war narrative of the Mfecane was
substantially a colonial construction, used to justify land seizure by depicting the
interior as having emptied itself through violence. A game whose verbs are *raid* and
*destroy* re-tells exactly the story that document says is contested. A game whose verbs
are *plant*, *herd*, *store*, *trade* and *ally* tells the one the historiography
actually supports — displacement, subsistence, and shifting affiliation under pressure.

Building the RTS first was not wasted, and this ADR is not a reversal of it. It is how we
found out which half of it was alive.

## Decision

**The game becomes a village simulator.** The player sustains and grows a settlement
through the seasons rather than defeating an opponent.

What this means concretely:

- **The objective changes** from holding cattle to sustaining a village — see the roadmap
  for the specific form, which is deliberately not fixed here.
- **New systems**: farming as an active choice rather than a passive yield, foraging from
  the veld, trade in resources, and alliances with neighbouring settlements.
- **Cattle herding, flocking and stampedes stay.** They are the defining mechanic
  (ADR-0014) and they are *better* in a subsistence game than a military one: a herd is
  wealth, a food store, a social obligation and a liability that eats every ten seconds.
  What changes is that a stampede is a disaster rather than a weapon.
- **Combat retires last, not first.** It is currently the only thing standing between the
  economy and having no pressure at all — see Consequences.

What is explicitly NOT changing:

- The platform. It stays a browser game; see Consequences.
- Determinism, the command pipeline, the sim/render boundary, the snapshot schema
  discipline, the replay gate. Every one of those is about *simulation*, and a village is
  no less a simulation than an army. They stay hard invariants.
- The art pipeline and the isometric renderer.
- The historical and terminological policy in `docs/CONTENT.md`, which this decision
  serves rather than revises.

## Consequences

**Order of work matters, and the obvious order is wrong.** Removing combat first would
leave a game with no failure condition: the drought is a metronome, and an economy with
nothing to fear becomes a spreadsheet that never says no. So the sequence is to replace
the objective, then build the new loops, and only then retire combat — by which point
scarcity the player's own choices create has taken over the job.

**Pressure has to come from somewhere, and a season is not enough.** Drought arrives on a
timer and every player meets the same one. A village simulator bites when the player's own
decisions create the shortage: land committed to grain that a herd then can not graze,
cattle accepted from a neighbour whose upkeep outruns the harvest, an alliance that costs
more than it returns. Designing that is the real work and it is not a tuning exercise.

**Much of the codebase is already the right codebase.** The economic ledger, upkeep,
drought, grain plots, buildings, construction, technology, the fog, the herd — all of
these were built for the RTS and all of them are village systems that happen to have been
aimed at a war. The parts that go are combat, the stance and pursuit machinery in
movement, and the AI opponent in its present form.

**The AI becomes a neighbour rather than an enemy.** It is already "just another command
source", which is what makes this cheap: a settlement that trades, asks and refuses is the
same plumbing pointed at different decisions.

**Staying in the browser is a deliberate and separate decision.** The production bundle is
340 kB, 106 kB gzipped; nothing in this ADR moves that, because simulation state is cheap
and art loads on demand regardless of platform. The constraints that shaped this codebase
— determinism, the boundary, the frame budget — are ones a desktop build would keep
anyway. If an installable version is wanted later, Tauri or Electron wrap what already
exists without abandoning the web build. That is a packaging decision and it can be taken
at any time; it is recorded here only so a later session does not treat the browser as an
accident.

**The name stays.** `docs/CONTENT.md` already records that "Mfecane" is a contested term
and that naming it is a choice. A game about villages living through the period has at
least as much claim to it as one about armies crossing it.
