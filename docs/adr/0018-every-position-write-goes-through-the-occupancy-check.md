# 18. Every position write goes through the occupancy check

Date: 2026-09-14

## Status

Accepted.

## Context

A code review looking for writes that bypass the system owning their invariant found
two, both in the cattle system, and both invisible to the whole test suite.

`movement.ts` had always routed every position write through `constrainStep`, which
refuses a destination that is out of bounds, on an impassable tile, or across an edge
the unit's movement class cannot climb. That discipline was real but undocumented, and
it lived inside one module as a private function. Nothing said it was a rule, so nothing
noticed the two places that did not follow it.

**Knockback.** Being run over by a stampede threw the victim forward by writing `posX`
and `posY` directly. At 0.55 tiles a knock crosses a tile boundary about half the time,
and a herd crushing one victim compounds it within a single tick. Measured: a victim at
x=15.7 on a 16-wide map ended at 16.25, and one beside a cliff ended at 12.25 — inside a
column whose outbound direction mask is empty, which it could never walk out of again. A
stampede could remove a unit from the match permanently.

**Cattle movement itself.** Worse, and the same root. `movement.update` skips everything
that is not a `Unit`, so cattle integrate their own steering — and `cattle.ts` contained
no reference to a map, a width, a height, or a bound of any kind. A stampeding cow
charged off a 16-wide map and was measured at x=24, still accelerating, and walked
straight through a sheer cliff. Cattle are the victory condition, so a herd that leaves
the map takes the match with it.

Neither was caught because every cattle test constructed a world and a spatial grid and
no terrain at all. There was nothing for the cattle to be wrong about.

## Decision

Any code that moves an entity it does not own calls `MovementSystem.displace`, which
applies the proposed position through the same `constrainStep` the movement system uses
on itself. Direct writes to `world.posX` / `world.posY` are confined to `movement.ts`
and to `spawn`, which places an entity rather than moving one.

`cattle.update` takes `displace` as a **required** parameter. Optional was the tempting
shape and the wrong one: a default that wrote the position directly is precisely how the
unchecked version survived, because every existing test would have gone on quietly
agreeing with it. Required means a new call site cannot fail to think about it, and the
type checker lists them.

## Consequences

Cattle now stop at cliffs and map edges instead of passing through them, which is the
behaviour the per-class cost layers always implied — `MovementClass.Cattle` existed and
had a layer built for it that nothing consulted.

A stampede driven into a cliff stops dead against it rather than continuing. That is the
same thing that happens to infantry, and it makes terrain a tool: a poort or a mesa edge
is now something a herd can be driven against.

The golden replay hash is unmoved. On open ground within bounds the occupancy check
returns the proposed position unchanged, and the fixture never drives cattle into
anything that would refuse them.

Cost is three `canOccupy` calls per cattle substep in the worst case — 600 for 200 cattle
per tick, each a handful of array reads. It does not register against the pathing budget
in ADR-0013.

## The general lesson

The test that would have caught both is not a cleverer assertion; it is a fixture with
terrain in it. A unit test that constructs the world without the constraint under test
cannot observe the constraint being violated, and it will pass forever while doing so.
