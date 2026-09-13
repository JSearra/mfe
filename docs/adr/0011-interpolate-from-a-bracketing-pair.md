# ADR-0011: Interpolate from a bracketing pair, not the two newest snapshots

**Status:** Accepted — 2026-09-13
**Refines:** `ARCHITECTURE.md` section 5

## Context

`ARCHITECTURE.md` says "Keep the last two snapshots ... lerp position between snapshot A
and B". That is correct while delivery is even, and those are then the same two
snapshots that bracket the render clock.

Under jitter they are not. Two snapshots can arrive between one pair of render frames —
a GC pause, a scheduling hiccup, and later the worker's message queue will do it
routinely. With a two-slot buffer the second arrival evicts the snapshot the renderer is
currently blending *from*, so the pair jumps forward a tick and the rendered position
lurches by a whole tick of movement.

This was found by a test asserting per-frame smoothness under injected arrival jitter.
It reported a frame step of 1.87 units where the expected step was 0.67. Nothing else
caught it: every field round-trips, no state is wrong, and the entity arrives at the
right place. The only symptom is a visible stutter.

## Decision

Keep a short history — eight snapshots, 400ms at 20Hz — and each frame select the pair
that brackets the render clock, rather than always the two most recent.

Clamping is unchanged and still the extrapolation guard: a clock past the newest
snapshot blends at 1 against the newest pair, never beyond it.

## Consequences

- Bounded and small: eight snapshot buffers at ~20 bytes per entity.
- The bracket search walks back from the newest, so the common case — clock inside the
  newest pair — exits on the first comparison.
- The smoothness test is the thing that protects this. It asserts motion never reverses
  and that no frame step exceeds twice the expected step. Keep it: the failure it catches
  is invisible to every correctness-shaped assertion.
