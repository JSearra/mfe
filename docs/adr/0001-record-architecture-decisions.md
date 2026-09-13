# ADR-0001: Record architecture decisions

**Status:** Accepted — 2026-09-13

## Context

This project is developed largely through agent sessions, each starting without memory of
the last. The initial brief contained several technical choices that were reversed after
review. Without a record, a later session will re-derive the original choice from first
principles, re-introduce it, and the reasoning will be lost each time.

## Decision

Every reversal of the original brief, and every subsequent decision that constrains later
work, gets a short ADR here. `CLAUDE.md` instructs sessions to read the relevant ADR before
re-opening a settled decision.

ADRs are immutable once accepted. A changed mind means a new ADR that supersedes the old
one, with the old one marked Superseded and linked.

## Consequences

- Small ongoing cost per decision.
- `docs/ARCHITECTURE.md` describes *what* the system is; ADRs record *why* alternatives
  were rejected. The two are read together.
