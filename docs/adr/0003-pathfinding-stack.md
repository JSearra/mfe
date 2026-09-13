# ADR-0003: Flow fields and weighted A*; no JPS, no RVO

**Status:** Accepted — 2026-09-13
**Relates to:** `ARCHITECTURE.md` §7

## Context

The brief specified "Jump Point Search (JPS) or optimized A*" for single units, flow fields
for groups, and "Reciprocal Velocity Obstacles (RVO) or basic separation steering" for local
avoidance, against a 0-255 weighted terrain cost grid, benchmarked at 300 simultaneous unit
path updates within 10ms.

## Decision

Flow fields first, weighted A* with a budgeted request queue second, separation steering
for local avoidance. Cost layers keyed by movement class. Integration field `Uint16Array`.

### Why not JPS

1. **Its pruning rules are only valid on uniform-cost grids.** Pairing it with a 1-254
   weighted cost grid is incoherent — the two specifications in the brief contradict
   each other.
2. **RTS grids are dynamic.** JPS's speedup comes from expanding few nodes on a *static*
   grid; construction invalidates it, and JPS+ precomputation would be rebuilt constantly.
3. **Cost is per movement class**, not per tile — infantry, cattle and mounted Griqua differ
   over slope, drifts and thornveld. Any JPS+ precomputation would multiply by class count.

### Why not RVO

Beyond being fiddly: **RVO is reciprocal by definition and a stampede is definitionally
non-reciprocal.** The headline mechanic requires cattle to plough through infantry while
infantry fail to avoid them. RVO's formulation assumes both agents share avoidance
responsibility, so we would be building a system whose axioms contradict the feature the
game is named for, then special-casing around it.

The real failure of naive separation steering is also not what is usually assumed. It is
**deadlock and wall-pinning** at chokepoints, not unit stacking — and the fixes for that are
cheap and non-RVO: soft push-apart after integration, a stuck-timer triggering repath,
idle-units-yield-to-moving, and group-level shared destinations rather than N independent
goals.

### Two corrections carried from the brief

- **The integration field must be `Uint16Array`.** The brief's `Uint8` encoding (255 as
  impassable sentinel) is correct for the *cost* field, but the integration field
  accumulates cost-to-goal and overflows `u8`. Clamp and assert.
- **The "300 paths in 10ms" benchmark targets a workload that never occurs.** A 300-unit
  army is 6-20 groups sharing flow fields; steady state is 5-20 requests per tick plus
  collision repaths. Chasing the phantom burst is precisely what pushes a design toward JPS.
  Replaced by: pathing subsystem <= 3ms/tick, p99 request latency < 200ms.

## Consequences

- `requestPath()` is **async by interface even while it returns synchronously**, so moving
  to a budgeted queue or a second worker is never a caller-side change.
- Two steering models coexist permanently: boids for cattle, formation/separation for
  infantry. Unifying them is a mistake, not an optimization.
- HPA*-style cluster abstraction stays available if 128x128 proves slow. It probably will not.
