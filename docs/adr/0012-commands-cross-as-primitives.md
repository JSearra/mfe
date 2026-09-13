# ADR-0012: Commands cross the boundary as primitives, so no runtime clone is needed

**Status:** Accepted — 2026-09-13
**Amends:** ADR-0004

## Context

ADR-0004 specified a dev-mode `structuredClone()` on "every command and every snapshot"
crossing `DirectSimHost`, so that a shared reference into simulation memory fails
immediately rather than at worker-flip time.

The snapshot half is real and is implemented. The command half turned out to be ceremony.
`sendCommand(kind, a, b, c, d)` accepts only numbers, so a command cannot carry a
reference into simulation state in the first place. Cloning a freshly constructed object
made of five numbers proves nothing and costs an allocation per order — and orders are
issued per selected unit, so a 200-unit army is 200 clones per click.

## Decision

Clone snapshots. Do not clone commands; the signature already makes aliasing
unrepresentable, which is a stronger guarantee than a runtime check because it fails at
compile time rather than only on the dev path.

If a command ever grows a payload richer than a number — an entity list, a formation
descriptor, a string — restore the clone along with it. That is the trigger to watch for.

## Consequences

- One less allocation per issued order.
- The guarantee now rests on the type signature, so it must not be widened to `unknown`
  or an object type without revisiting this.
- The snapshot clone still does real work and has a test: a delivered buffer must not
  change while the simulation keeps running.
