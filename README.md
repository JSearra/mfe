# Mfecane RTS

A browser-based 2D isometric real-time strategy game in the Age of Empires II lineage, set
in southern Africa roughly 1815-1840. Its defining mechanic is cattle: herding, flocking,
and stampedes that can be aimed at an enemy line.

TypeScript, Vite, Pixi.js. The simulation runs at a fixed 20Hz in a Web Worker, behind a
snapshot boundary, and is built so deterministic lockstep multiplayer stays possible.

## Status

Phases 0-6 and the whole backlog are complete: determinism invariants, isometric terrain
with elevation, the snapshot boundary, pathfinding, the cattle mechanic, economy and
factions, fog of war, save/load, the worker flip, combat, buildings, an AI opponent,
audio, the four scripted maps, and tech progression.

What remains is content and polish rather than architecture — see the end of
[`docs/ROADMAP.md`](docs/ROADMAP.md).

```bash
npm install
npm run dev          # then open the printed URL
```

`?map=thaba-bosiu` (or `umfolozi`, `karoo`, `magaliesberg`) picks a scripted landscape.
`?sim=direct` runs the simulation on the main thread, which is far easier to debug.

**Controls.** Left-drag selects. Right-click moves, herds a cow, or attacks an enemy,
depending on what is under it. Middle-drag, the arrow keys or the screen edges pan, the
wheel zooms. `1`-`3` place buildings, `R` researches.

## Commands

```
npm run dev            npm run build          npm run preview
npm run typecheck      npm run lint           npm test
npm run replay         npm run replay:record
npm run perf:pathing   npm run perf:terrain
```

## Documentation

| Document | Purpose |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Invariants and rules loaded into every development session |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The design and the reasoning behind it |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases and backlog, with what each one actually found |
| [`docs/CONTENT.md`](docs/CONTENT.md) | Historical framing, terminology and orthography policy |
| [`docs/adr/`](docs/adr/) | Decision records — read before re-opening a settled choice |

Fourteen ADRs record where the implementation contradicted the original plan and why.
The ones worth reading first are
[0002](docs/adr/0002-float64-not-fixed-point.md) (determinism without fixed-point),
[0010](docs/adr/0010-terrain-chunking-and-the-frame-budget.md) (what a frame budget
actually measures) and
[0013](docs/adr/0013-pathing-performance.md) (an 81ms tick brought to 0.33ms, and the
obligation that created).

## A note on the setting

The Mfecane is contested historiography involving real mass death and displacement, with
living descendant communities. [`docs/CONTENT.md`](docs/CONTENT.md) states this project's
position on framing, terminology and depiction limits. It is worth reading before adding
content.
