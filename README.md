# Mfecane RTS

A browser-based 2D isometric real-time strategy game in the Age of Empires II lineage, set
in southern Africa roughly 1815-1840. Its defining mechanic is cattle: herding, flocking,
and stampedes that can be aimed at an enemy line.

TypeScript, Vite, Pixi.js. Simulation runs at a fixed 20Hz, decoupled from the render loop
and built to keep deterministic lockstep multiplayer possible.

**Status: pre-implementation.** The design is settled; no code has been written yet.

## Documentation

| Document | Purpose |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Invariants and rules loaded into every development session |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The design and the reasoning behind it |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases 0-6 with machine-checkable acceptance criteria |
| [`docs/CONTENT.md`](docs/CONTENT.md) | Historical framing, terminology and orthography policy |
| [`docs/adr/`](docs/adr/) | Decision records — read before re-opening a settled choice |

Start at `docs/ROADMAP.md` Phase 0.
