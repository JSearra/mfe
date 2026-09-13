# ADR-0013: What made pathing fast, and what that costs

**Status:** Accepted — 2026-09-13
**Relates to:** ADR-0003, `ROADMAP.md` Phase 4

## Context

Phase 4's first working implementation moved 300 units at a mean of **81.9ms per
simulation tick**, against a tick length of 50ms. The simulation could not keep real
time. Five changes brought it to a mean of 0.33ms; each is recorded here because four of
them are invisible in the code's shape and one carries an ongoing obligation.

## The five changes

### 1. Resolve flow fields once per tick, not once per unit

`desiredDirection` looked its unit's field up from the cache on every tick. With fifteen
active destinations against an eight-entry cache, every lookup missed and **rebuilt a
full Dijkstra over the map, inside the movement loop**. Distinct destinations are few — a
300-unit army is a dozen or two groups — so they are now resolved once per tick into a
small map that the per-unit loop reads.

Cost: 81.9ms -> 0.57ms mean.

### 2. Evict the field cache by least-recently-used, not by insertion

Insertion-order eviction looks equivalent and is not. With more live destinations than
slots it evicts fields that are still being followed, guaranteeing a rebuild. The cache
was also raised to 48 entries — a field is about 49KB on a 128x128 map, so the whole
cache is under 2.4MB.

### 3. Precompute step costs into a table

`stepCost` recomputed tile coordinates with `%` and `/` and read two heights through
bounds-checked accessors, inside Dijkstra's innermost loop — roughly 100ns per edge. The
cost of every orthogonal step is now computed once per cost layer into a
`Uint16Array` indexed `tile * 4 + direction`.

Cost: 6.5ms -> 4.8ms per field build.

**This carries an obligation.** `tileCost`, `edges`, `dirs8` and `edgeCost` are derived
from one another, so writing any of them directly leaves the others describing the old
world — a building placed by setting `tileCost` alone is walked straight through.
Changes go through `blockTile`, which updates all of them, or through a rebuild. Two
tests were written against direct mutation and both silently passed while asserting
nothing; they now inject a cost profile instead.

### 4. Dial's bucket queue instead of a binary heap

Step costs are bounded small integers, which is precisely the case a bucket queue exists
for: O(V + E + maxCost) rather than O(E log V). Most of the remaining build time was
sift-up and sift-down, not the relaxations they scheduled.

Cost: 4.8ms -> 3.3ms per field build.

Determinism is unaffected. Entries sharing a bucket share a cost, and the integration
field is the unique shortest-cost solution however equal-cost nodes are ordered; the flow
directions derive from those values with an explicit tie-break on direction index.

One subtlety this introduced: **saturation must be tested before the improvement test.**
The field initialises to `UNREACHABLE` (0xffff), so a cost that overflows the 16-bit
range always compares as "no improvement" and the clamp branch below it is unreachable.
The overflow test passed for two commits while exercising nothing.

### 5. Budget field construction, and split the budget that measures it

Building is now queued and capped at one field per tick, the same treatment path requests
already had. And the assertion is two numbers rather than one:

| Measure | Budget | Actual |
|---|---|---|
| p99 of ticks that only move units | 1.5ms | 0.50ms |
| worst tick that also builds a field | 8ms | 4.34ms |
| fields built in any one tick | 1 | 1 |
| p99 path request latency | 200ms | 100ms |

A single conflated number hides which of the two regressed, and would have read as a
3.5ms p99 that says nothing about whether the simulation hitches.

## Consequences

- Steady-state movement for 300 units costs 0.33ms of a 50ms tick.
- A redirected army waits a tick or two for its field. Until it arrives units steer
  straight at the destination, so an order never looks ignored.
- Cost layers are built lazily on first use, about 8ms each. That is load-time cost and
  is excluded from the steady-state measurement deliberately, the way the render harness
  excludes shader compilation.
- The derived-table obligation in (3) is the one that will bite later, when buildings
  start blocking tiles. `blockTile` is the only safe route.
