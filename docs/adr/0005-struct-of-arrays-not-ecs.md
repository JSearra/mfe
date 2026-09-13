# ADR-0005: Struct-of-arrays storage, not an ECS library

**Status:** Accepted — 2026-09-13
**Relates to:** `ARCHITECTURE.md` §2

## Context

The brief specified "an Entity Component System (ECS) using bitECS (or pure typed arrays)".

## Decision

Struct-of-arrays typed arrays per entity kind, systems as plain functions taking explicit
array references. No query engine, no archetypes, no ECS library.

There are six entity kinds — unit, cattle, building, projectile, resource node, effect —
and their shapes are near-static. ECS machinery earns its complexity when composition is
arbitrary. Here it is not.

## Why not bitECS specifically

Its pre-1.0 status (0.4.0, with substantial API change from 0.3.x) is a real risk but a
secondary one.

**The decisive argument is iteration order.** Query iteration order in a general ECS is an
internal implementation detail that can change between versions. Our replay hash depends on
iteration order — damage application order, target-selection tie-breaks, entity ID
allocation all do. A patch-version bump of the ECS would therefore silently invalidate every
stored replay and, once lockstep exists, desync multiplayer. Owning the storage means owning
the order.

A secondary benefit: a hand-rolled SoA layout lets us hand the renderer exactly the fields
we chose, as a typed-array subarray view or a transferable buffer. A generic ECS serializer
is never the shape wanted at a 20Hz boundary.

## Two things this is not

This is **not** "roughly 150 lines". The estimate only holds if the hard parts are omitted,
and they cannot be:

- **Generation-tagged handles.** `(index: u24, generation: u8)` packed into a `u32`, with
  `isAlive()` checked at every command dispatch and snapshot decode. A free-list allocator
  without a generation tag is a use-after-free factory: a unit dies, its index is recycled
  next tick, and a command queued from the UI 75ms earlier retargets an unrelated cow.
  Across a 20Hz boundary with interpolation delay this is a weekly bug.
- **Deferred structural change.** Spawns, destroys and component changes cannot occur
  mid-iteration; they queue and flush in sorted order at the tick boundary.

## Consequences

- Serialization for save/load and snapshots is close to a memcpy of subarrays.
- Adding a genuinely new composition axis means hand-written code rather than a query. If
  that happens more than twice, revisit archetypes — with a new ADR.
- Systems take array references as parameters rather than reading a global `world`, so a
  later storage swap is mechanical rather than archaeological.
