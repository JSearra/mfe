# ADR-0007: Pin TypeScript 6, not 7

**Status:** Accepted — 2026-09-13
**Supersedes the toolchain line in:** `ROADMAP.md` Phase 0, `ARCHITECTURE.md` preamble

## Context

`ROADMAP.md` specified TypeScript 7, which is the current stable release (7.0.2) and the
native Go compiler — attractive for an agent-driven project that runs `typecheck` constantly.

It does not work with our lint stack. `typescript-eslint@8.70.0` (latest) declares
`typescript: >=4.8.4 <6.1.0` and hard-refuses at runtime:

```
typescript-eslint does not support TS 7.0.
See https://github.com/typescript-eslint/typescript-eslint/issues/10940
```

This is not a peer-dependency warning that can be ignored; the plugin throws on load, so
`npm run lint` cannot run at all. The lint rules are the entire point of Phase 0 — without
them the determinism and boundary guarantees are prose, not enforcement.

TypeScript's own guidance is to run 6.0 side by side for tooling that needs the old API.

## Decision

Pin `typescript@6.0.3` — the latest stable 6.x, within typescript-eslint's supported range.

The side-by-side arrangement (TS 7 for `tsc`, an aliased TS 6 for the linter) was rejected
for Phase 0: it is two compilers, two resolution paths and a confusing `package.json` to buy
compile speed on a few thousand lines, in the phase whose job is to make the rules legible.

## Consequences

- `npm run typecheck` uses the slower JS compiler. At current size it is well under a second.
  If it becomes a real bottleneck before typescript-eslint ships support, revisit the
  side-by-side arrangement then, with the cost actually measured.
- **Revisit trigger:** typescript-eslint releases TS >=7.1 support (issue #10940). At that
  point this is a two-line version bump, because nothing in the codebase depends on TS 6
  semantics.
- Note for whoever checks: npm's `beta` dist-tag for TypeScript still points at `6.0.0-beta`
  and is stale. 6.0.3 is a real stable release.

## Checked 2026-09-14

typescript-eslint issue #10940 is still open, so the pin stands and nothing here changes.
Recorded so the next session can see the trigger was looked at rather than assumed — the
whole value of a revisit trigger is lost if checking it is itself a research task every
time.

