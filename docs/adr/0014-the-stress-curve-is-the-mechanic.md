# ADR-0014: The stress curve is the mechanic

**Status:** Accepted — 2026-09-13
**Relates to:** `ROADMAP.md` Phase 5

## Context

Cattle accumulate stress from nearby people and stampede when it saturates. The obvious
implementation makes stress rise linearly with proximity, matching the avoidance push
that steers the herd.

With that shape there is no game. Every approach is equally dangerous, so herding becomes
"get close enough to steer, but no closer", with no room between the two — and a player
who wants to trigger a stampede has no more control than one trying to avoid it. The
first tuning pass produced exactly this: cattle either ignored the herders or bolted, and
nothing in between was playable.

## Decision

**Stress rises with the square of proximity; the avoidance push stays linear.**

The gap between the two curves is the mechanic:

| Distance | Avoidance (linear) | Stress gain (quadratic) | Net against decay |
|---|---|---|---|
| ~2.5 tiles | weak steer | well below decay | calms — safe herding |
| ~2 tiles | steers | below decay | calms slowly |
| ~1 tile | strong steer | far above decay | panics in seconds |

So a herder at two tiles moves cattle and settles them, and a herder who crowds them
panics the herd. Driving cattle somewhere is a matter of holding a distance under
pressure; triggering a stampede is a matter of deliberately closing it. Both are player
skill rather than luck, which is the thing Gate 1 asks.

Numbers that follow from it: `stressGain` 30, `stressDecay` 6, so saturation takes about
five seconds of crowding and calming takes about eleven.

## Two corrections this phase forced

**The stampede was not fast enough to need the swept collision it had.** At 5.5 tiles per
second a cow covers 0.275 tiles per tick against a crush radius of 0.55 — it cannot
tunnel, and the swept test was decorative. The ROADMAP's tunnelling risk was calculated
at 8 tiles/s. Raised to 8.0 with a 0.35 crush radius, so travel genuinely exceeds the
radius and the test asserts something. A mechanic whose danger cannot outrun its own
hitbox also just reads as slow.

**Selection filtered by faction alone, so marquees scooped up the herd.** Cattle are
neutral stock, not troops. Selection now filters on kind as well, and cattle spawn to a
neutral faction.

## Consequences

- The tuning table above is the thing to protect. Changing `stressGain` or `stressDecay`
  without preserving the gap between the curves removes the playable band, and the
  symptom is "herding feels random" rather than anything a test would catch.
- Cattle substep three times per tick with a clamped acceleration. Boids integrated once
  per 50ms oscillate around their target instead of settling; the herd test asserts the
  late swing stays under a tile.
