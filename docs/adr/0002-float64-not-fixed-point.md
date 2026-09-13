# ADR-0002: Float64 sim state, not fixed-point

**Status:** Accepted — 2026-09-13
**Relates to:** `ARCHITECTURE.md` §1

## Context

The game ships single-player but must keep deterministic lockstep multiplayer possible.
The reflexive answer is fixed-point integer math (Q16.16 in `Int32Array`), on the premise
that floating point is non-deterministic across machines.

**That premise is largely false in JavaScript.** IEEE-754 `+`, `-`, `*`, `/` and `sqrt` are
correctly rounded and fully specified, and are bit-identical across V8, JavaScriptCore and
SpiderMonkey on both ARM and x86. JavaScript has no x87 80-bit extended-precision hazard
and no fast-math flag.

The actual non-determinism sits in a short, enumerable list: `Math.sin/cos/tan/atan2/exp/
log/pow` and `**` (implementation-defined by spec), `Math.hypot` (not correctly rounded),
`Math.random`, wall-clock reads, insertion-order-dependent `Set`/`Map` iteration, and
inconsistent `Float32Array`/`Float64Array` rounding.

## Decision

Sim state is `Float64Array`. The hazard list is banned inside `src/sim/**` by ESLint and
replaced with owned implementations: a seeded xoshiro128** RNG with serializable state, and a
sin/cos lookup table. Determinism is then *verified* rather than assumed, by a golden
replay hash test in CI from Phase 0.

## Alternatives rejected

**Q16.16 fixed-point.** Multiplication needs a 64-bit intermediate JavaScript lacks;
`BigInt` is roughly an order of magnitude slower and allocates, and split-multiply via
`Math.imul` is correct but easy to get wrong in the sign and shift. Division and square
root are worse.

The decisive cost is not performance. It is that every steering and physics formula becomes
unreadable, and this project's central risk is **tuning a feel-based mechanic**. Cattle
stress coefficients will be adjusted hundreds of times across Phase 5. Those edits must not
be in fixed-point.

## Consequences

- Roughly 5% of the cost of fixed-point for ~99% of the benefit.
- The lint rule and the replay test are load-bearing. Suppressing either silently removes
  the guarantee, which is why `CLAUDE.md` forbids suppression.
- If cross-engine lockstep ever ships and the hash test proves real divergence, revisit.
  The banned-function discipline makes that a contained change rather than a rewrite.
