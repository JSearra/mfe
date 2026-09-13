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
- [ ] **A3 — Order queue.** Shift-click to append rather than replace. No queue exists at
      all today.
      *Done when:* two queued move orders are executed in sequence, the queue survives the
      unit being re-selected, and an unmodified order clears it.
- [ ] **A4 — Control groups.** Ctrl+N to assign, N to recall. Pure client state.
      *Done when:* assigning and recalling round-trips, a group drops dead members, and a
      test asserts the world hash is unchanged by any of it.
- [ ] **A5 — Patrol.** Move between two points until told otherwise, engaging on the way.
      *Done when:* a patrolling unit reverses at each end and keeps going.

## B. Game lifecycle

It is a scenario, not a game: the map is a URL parameter, two players are hardcoded, and
the outcome banner is the end of the road.

- [ ] **B1 — Restart.** Play again without reloading the tab.
- [ ] **B2 — Setup screen.** Choose map, faction and seed before starting, instead of
      editing the query string.
- [ ] **B3 — Pause and speed.** Pause, and at least one faster setting. Must not touch
      determinism: the tick rate is fixed, so this is a host concern, not a sim one.

## C. Known gaps

- [ ] **C1 — The herd is invisible at start.** Units spawn at the centre with vision 8;
      the herd sits ~16 tiles away. A cattle game that opens with no cattle on screen.
- [ ] **C2 — Buildings have no sprites.** Units and cattle are textured; buildings are
      still `Graphics` primitives.
- [ ] **C3 — Cliff faces are flat-shaded.** They take the tile's average colour; they
      should be textured like the surfaces above them.
- [ ] **C4 — Player colour should be a shader swap**, not baked geometry. The roadmap has
      wanted this since the art pipeline landed, and the pale shield is now the canvas
      for it.
- [ ] **C5 — Mounted units draw the musketeer sprite.** There is no horse, despite
      `Mounted` being a movement class with its own cost profile.
- [ ] **C6 — The `herder` sprite is unused.** Herding is done by any unit; either give
      herders a type or drop the sprite from the atlas.

## D. Multiplayer

Every determinism invariant is in place and CI-enforced; none is proven across two
machines. This is a milestone rather than a task — transport, lockstep stepping, and
desync detection wired to the existing replay hash — and wants its own plan and its own
decision about scope before any of it is written.
