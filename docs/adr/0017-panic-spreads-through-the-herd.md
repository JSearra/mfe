# 17. Panic spreads through the herd, and it spreads on stress

Date: 2026-09-13

## Status

Accepted. Extends ADR-0014, which set the stress curve but did not consider contagion.

## Context

Running Gate 2 turned up something that was not a legibility problem at all. Chasing a
herd with a single threat saturated stress on **one animal at a time**, however long the
pressure was held. Measured at herd spacings of 0.9, 1.2, 1.5 and 1.8, identical at every
one — so it was not a consequence of the separation widened earlier that day, which was
the first thing suspected and the first thing ruled out.

The cause was in the stress model: stress accumulated only from nearby *people*. A
neighbouring beast contributed separation, cohesion and alignment, and nothing else. A
panicking animal beside a calm one was, as far as the calm one was concerned, just an
animal standing slightly too close.

So "stampede" named several cattle independently deciding to bolt. The word means the herd
goes, and the whole game is built around the word.

## Decision

**A stampeding beast raises the stress of cattle near it**, weighted by proximity, and how
readily a beast catches that panic depends on how wound up it already is.

Two shape choices, both load-bearing:

**Linear falloff with distance, not the square law the threat curve uses.** That curve
exists to make approach distance something a player plays against. This is an animal
noticing its neighbours are running, which is closer to binary. Squared, at a realistic
neighbour distance it was worth about 0.03 stress per tick — arithmetically incapable of
spreading anything before the bolter, at stampede speed, had left the radius.

**Steeply dependent on the receiver's existing stress, with a low floor.** This is the part
that matters. A shallow version — a high floor, so even calm cattle catch easily — makes
the cascade turn on herd *geometry*: whether the first bolter happens to pass close enough
to enough others. Measured over twelve seeds that gave anywhere from **1 to 23 of 30 on
identical input**, which is precisely the coin flip ADR-0014 exists to prevent, and worse
than no contagion because it is unpredictable rather than merely absent.

Steep, the cascade turns on herd *stress* instead. Stress is the thing the player controls
by how closely they work the herd, and the thing the stress rings already put on screen. A
calm herd shrugs off a single bolter; a herd that has been pressed hard goes with it.

## Consequences

- **A calm herd is not a powder keg.** With a lone beast artificially bolted into a settled
  herd, the cascade does not start: ten seeds, one stampeding animal in every one. This is
  the property to protect if these numbers are ever retuned — without it there is no state
  in which a player can work among cattle, and herding stops being a skill.
- **Measured in the browser, with real units driven into the herd: 21 of 30 stampeding,
  against 1 before this change.**
- `panicRadius` and `panicGain` join the tuning table ADR-0014 says to protect. The same
  warning applies and for the same reason: the symptom of getting them wrong is "stampedes
  feel random", which no test catches unless it is looking for variance specifically. The
  two tests in `cattle.test.ts` assert the two ends — calm herd resists, frightened herd
  goes — rather than a magnitude, because the magnitude depends on the scenario.
- Tuning changed, so the golden replay was re-recorded.

## What this does not settle

The exact magnitude under different kinds of pressure is not pinned down. A synthetic test
in which several threats each chase their own nearest animal *scatters* the herd and
produces smaller cascades than a single chaser, which is an artifact of that test rather
than a property of the game — a player drives a formation from one side and holds the herd
together. Real numbers should come from play, not from that harness.
