# 16. Performance budgets scale to the machine, and assert central statistics

Date: 2026-09-13

## Status

Accepted. Amends ADR-0010, which settled the same question for render frame budgets.

## Context

CI had never passed. Every run since the first push failed at the same step —
`npm run perf:pathing` — while typecheck, lint, tests, the golden replay and the build
all succeeded. The failure was invisible locally because the gate passes on a developer
machine in 585ms.

Two assertions were responsible:

```
expect(steadyP99).toBeLessThan(1.5);   // milliseconds, wall clock
expect(worstBuild).toBeLessThan(8);    // milliseconds, wall clock
```

Both are absolute wall-clock budgets calibrated on one laptop. `worstBuild` had under
twice its own headroom there. A shared CI runner is several times slower, so the gate
was not detecting regressions, it was detecting the hardware.

Reproducing it locally under CPU contention gave the exact CI failure and something more
useful: the mean moved 2.6x while the p99 moved 13x, on unchanged code. Both assertions
are extreme-value statistics over sub-millisecond samples, and a single scheduler
preemption lands in one tick and blows them. The third assertion in the same file did not
move at all, because it derives latency from tick counts rather than from a clock.

## Decision

**Enforce central statistics, and scale them to the machine.**

The asserted budgets are a mean of steady tick times and a median of build times. Both
move with the code rather than with a preemption. Each is multiplied by a factor from
`perf/calibrate.ts`, which times a fixed reference workload and compares it against the
machine the budgets were written on.

The extremes are still asserted, as unscaled catastrophe ceilings — 25ms on the steady
p99, 60ms on the worst build — set far above scheduling noise and far below the failure
this gate exists to catch.

The design targets from ARCHITECTURE (steady p99 1.5ms, build 8ms) are printed alongside
the measurements rather than asserted, so drift toward them is visible without being
fatal.

## Consequences

**What this deliberately cannot catch.** A regression under roughly 3.5x is now invisible
to this gate. Measured by injecting deliberate slowdowns: 2.2x passes, 6.6x fails, 29x
fails. That is the price of an assertion that does not fire on unchanged code.

It is the right price here. The regression this gate has actually caught ran at 81.9ms
per tick against a 3ms budget — 25x, not 2x (ADR-0013). At the maximum tolerated
calibration factor the mean budget is 14.4ms, so that failure is still a failure on the
slowest machine this will allow for. And a gate that fails on every commit catches
nothing whatever its sensitivity, because nobody reads it.

**Why not make it advisory in CI.** That is what `scripts/perf-terrain.mjs` does for
frame times, and it is right there: a GPU falling back to software rendering makes frame
times meaningless rather than merely slower, so there is no honest number to assert.
There is no such confound here — only a slower CPU, which is a scale factor. Switching
off the one budget in this project that has already caught a real disaster, in the only
place it runs automatically, would retire the guard that has earned its keep.

**The calibration models a slower CPU, not a contended one.** A uniformly slower machine
scales the reference workload and the measured code together, which is what CI runners
mostly are. Heavy contention is different: it inflates tails far more than throughput,
and no reference workload predicts it — measured, the calibration captured 2x of a 13x
degradation. This is why the assertions had to move to central statistics as well as
being scaled. The two changes cover different failure modes and neither is sufficient
alone.
