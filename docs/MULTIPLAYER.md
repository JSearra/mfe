# Multiplayer: what is already done, and what is actually left

Not a plan to execute. The roadmap calls multiplayer a milestone rather than a task, and
its scope is a decision that has not been taken. This is the survey that decision needs,
written while the codebase is fresh so it does not have to be re-derived.

**Nothing here has been built.** Every determinism invariant is in place and CI-enforced;
none is proven across two machines.

## What already exists

The expensive parts of lockstep are the ones you cannot add later, and they are done:

- **A fixed 20Hz tick**, with hosts translating wall-clock time into ticks outside
  `src/sim` so the simulation never reads a clock.
- **Commands as the sole mutation path**, ordered by `(tick, playerId, seq)`. That total
  order is what makes two machines agree about what happened when.
- **`commandDelayTicks`** on the host, unused at zero in single-player. The mechanism for
  scheduling a command a few ticks ahead — the thing lockstep needs to absorb jitter —
  is already wired through; enabling it is a constant, not a redesign.
- **A state hash and a golden replay.** `hashWorld` plus the checkpoint machinery is
  exactly the desync detector: two clients comparing a hash every N ticks find divergence
  at the tick it happened rather than three minutes later when a unit is visibly in the
  wrong place.
- **Banned non-determinism**, lint-enforced: no `Math.random`, no library trig, no clock
  reads inside `src/sim`. Owned RNG and trig instead.
- **Total-order tie-breaks** on every nearest-target query, which ARCHITECTURE names as
  the single most common desync in shipped RTS games.
- **Selection kept out of the simulation**, including control groups, which were built
  that way deliberately.
- **Snapshots already filtered per viewer**, so a second player's view costs nothing new.

## What is actually left

1. **A transport.** WebRTC data channels for peer-to-peer, or a WebSocket relay. The
   relay is far less work and is also the only one that can act as an authority later;
   peer-to-peer is cheaper to run and harder to secure.
2. **A lockstep step function.** Advance only when every player's commands for tick N
   have arrived. Today the loop advances on elapsed time; under lockstep it advances on
   consensus, and a client that stalls stalls everyone. This is the real work.
3. **Turn scheduling.** Commands issued at tick N execute at N + delay, where delay
   covers the worst round trip. The field exists; choosing the number and adapting it to
   measured latency does not.
4. **Desync detection and what to do about it.** Exchange the state hash periodically and
   compare. Detection is nearly free given the replay harness. Deciding what happens next
   — halt, resync from a save, or drop the offender — is a design decision with no
   obviously right answer for a game of this size.
5. **Lobby and join.** Which map, which factions, who is ready. The setup screen is the
   obvious place to grow this, and it now exists.
6. **A soak test across two processes.** Two headless clients, same command log, hashes
   compared every tick, run for an hour. Until that passes, "deterministic" is a claim
   about the code rather than an observed property. This is the thing that would actually
   close the milestone.

## The decision the scope needs

The cheapest useful version is **two players, one relay, no reconnect, halt on desync**.
That is a weekend of work on top of what exists, and it would prove the invariants across
two machines, which is the part nobody has proven.

Everything past that — reconnection, spectators, more than two players, resync rather than
halt, anti-cheat, matchmaking — is a different project in size, and none of it changes
whether the simulation is deterministic. Build the cheap version first; it is the one that
answers the open question.
