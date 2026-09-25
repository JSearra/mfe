# Mfecane RTS

A browser-based 2D isometric village builder set in southern Africa roughly 1815-1840.
It began as a real-time strategy game in the Age of Empires II lineage and is no longer
one: there is no combat (ADR-0019) and no win condition (ADR-0020). You settle a
homestead and keep it fed through the seasons, for as long as you like. Its defining
mechanic is still cattle: herding, flocking, and stampedes, which are a disaster rather
than a weapon.

TypeScript, Vite, Pixi.js. The simulation runs at a fixed 20Hz in a Web Worker, behind a
snapshot boundary, and stays deterministic: a golden replay catches any divergence.

## Status

Built on the original engine: isometric terrain with elevation and rivers, pathfinding,
the cattle mechanic, fog, a worker-hosted simulation, buildings, research, audio, four
scripted maps and generated art. Over it, the village game:

- **Work finds its own people.** Fields, kraals, granaries, folds and building sites near
  a homestead take the nearest free villagers; the player decides what exists and where.
  A direct order overrides it for urgent jobs, such as taking a herd.
- **The land and the weather are the pressure.** Fields decay unless worked, droughts
  come and go with the year, and a herd that outgrows the land shrinks. Starvation
  follows from raising more households than the land feeds, and shrinks a village
  rather than ending it.
- **Neighbours live off the map.** A trade screen priced by the neighbour's own scarcity,
  and standing ties that cost cattle and send grain to whoever goes hungry (ADR-0021).
- **The veld shows the season:** green in the rains, gold in the dry, grey-brown in a
  drought.
- **A village is kept.** It saves itself every minute and on `Ctrl+S`, and the setup
  screen offers to continue it.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) Part III for how it got here, and
[`tasks/plan.md`](tasks/plan.md) for what is open.

```bash
npm install
npm run dev          # then open the printed URL
```

`?map=thaba-bosiu` (or `umfolozi`, `karoo`, `magaliesberg`) picks a scripted landscape.
`?sim=direct` runs the simulation on the main thread, which is far easier to debug.

**Controls.** Left-drag selects. Right-click moves people, or takes a herd. Middle-drag,
the arrow keys or the screen edges pan; the wheel zooms. `1`-`3` place buildings, `F`
plants a field, `G` rests the field under the cursor, `T` raises a household at every
homestead, `R` researches. `` ` `` pauses, `+`/`-` change speed, `Ctrl+S` saves.

## Commands

```
npm run dev            npm run build          npm run preview
npm run typecheck      npm run lint           npm test
npm run replay         npm run replay:record
npm run perf:pathing   npm run perf:terrain
npm run soak           # years of the real opening on several seeds, as a table
```

## Documentation

| Document | Purpose |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Invariants and rules loaded into every development session |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The design and the reasoning behind it |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases and backlog, with what each one actually found |
| [`docs/CONTENT.md`](docs/CONTENT.md) | Historical framing, terminology and orthography policy |
| [`docs/adr/`](docs/adr/) | Decision records — read before re-opening a settled choice |

Twenty-one ADRs record where the implementation contradicted the original plan and why.
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
