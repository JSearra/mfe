# ADR-0008: Derive i18n keys from types, not a codegen step

**Status:** Accepted — 2026-09-13
**Refines:** `ROADMAP.md` Phase 1

## Context

Phase 1 called for "a codegen step producing a TypeScript key union from `en.json`", so
that `t('does.not.exist')` fails at compile time rather than rendering a blank string.

The goal is right. The mechanism has a flaw: a generated file is a second source of truth.
It goes stale whenever someone edits the dictionary without re-running codegen, and keeping
it honest needs a CI check that regenerates and diffs — more machinery than the problem.

## Decision

Derive the key union from the imported JSON with a recursive mapped type:

```ts
type LeafPaths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafPaths<T[K]>}`;
}[keyof T & string];
```

No build step, no generated file, and no way for the union to disagree with the dictionary —
they are the same artifact. Non-leaf keys are rejected too: `t('debug')` fails alongside
`t('a.missing.key')`, because an intermediate object is not a message.

## Consequences

- One less build step and one less CI check.
- The dictionary must stay a statically-imported JSON literal. Loading locales over the
  network at runtime would erase the literal type and with it the checking. That is fine for
  `en`; a second locale is checked against `typeof en` rather than becoming a second source
  of keys, which is the behaviour we want anyway — locales must not invent keys.
- Deeply nested dictionaries cost compile time. At a few hundred keys nested three or four
  deep this is not measurable. If it ever is, flattening the dictionary is the cheaper fix.
