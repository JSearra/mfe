# ADR-0010: Terrain chunking, and what the frame budget actually measures

**Status:** Accepted — 2026-09-13
**Relates to:** `ARCHITECTURE.md` section 4

## Context

Phase 2 called for terrain "baked into 16x16-tile `RenderTexture` chunks" and a budget
of "p99 frame < 16.6ms, draw calls <= 60". Building it surfaced two problems.

## Decision 1: retained Graphics geometry, not RenderTexture bakes

A 16x16 chunk's isometric bounding box is 1024 x 568 px. Sixty-four of them is:

```
64 x 1024 x 568 x 4 bytes  =  149 MB   at resolution 1
                           =  595 MB   at devicePixelRatio 2, which is what we render at
```

That is not a budget a browser game can spend on static terrain. Retained `Graphics`
geometry gives the same "build once, draw cheap" property — the geometry is uploaded
once and re-drawn by transform — for kilobytes instead of hundreds of megabytes.

Chunks are kept, because they are what makes culling cheap: 64 bounding-box tests per
frame rather than 16,384.

**Consequence to watch.** Each chunk is currently one draw call, because separate
`Graphics` objects do not batch with each other. Measured peak is 38 of 64 chunks
visible, so terrain alone can approach the whole 60-call budget at minimum zoom on a
large viewport — leaving nothing for units, cattle and buildings. This is an artifact
of using flat-filled `Graphics` as placeholder art: once terrain is drawn from an atlas,
sprites batch across chunks and the count collapses. Revisit when tile art lands, and
re-measure before assuming it improved.

## Decision 2: frame *cost* and frame *interval* are different measurements

Measuring "p99 frame time" as the interval between frames — `ticker.deltaMS` — is
wrong under vsync. The display pins that interval near 16.67ms no matter how little
work the frame did, so:

- the check can never pass, since 16.67 > 16.6 always; and
- it would not fail for the right reason either, because it measures the monitor.

The first run of `perf:terrain` reported exactly this: p99 of 16.80ms with a mean of
16.67ms, on a frame whose actual main-thread work turned out to be 0.42ms.

The budget's real question — "do we hit 60fps, with headroom" — splits in two:

| Measure | Budget | What it catches |
|---|---|---|
| p99 main-thread cost per frame | 8ms, half the frame | Work growing until it crowds out the GPU |
| dropped frames (interval past a vsync slot) | 1% of frames | Frames actually missed |

Main-thread cost is bracketed across ticker priorities — opened at `HIGH`, closed at
`UTILITY` — because Pixi renders at `LOW`. Timing only our own callback would exclude
the render submission and report a flattering number for most of the frame.

## Decision 3: software rendering is detected, not silently tolerated

Headless Chrome often falls back to SwiftShader, where the CPU does the GPU's work and
frame timings say nothing about real performance. `perf:terrain` reads the unmasked
WebGL renderer string; under a software renderer it reports the frame metrics as
advisory and still enforces draw calls, long tasks and heap growth, which are CPU-bound
and meaningful either way.

The alternative — asserting a frame-time number that depends on whether CI happened to
get a GPU — produces a check that is either always red or quietly meaningless.

## Resolution (tile art landed)

The prediction held. Tile tops are now sprites off a single atlas page, they batch across
chunks, and the count collapsed rather than grew: **25 draw calls of a budget of 60**, with
twelve chunks visible — against a measured 38 when each chunk was one `Graphics`.

Two things learned in getting there, both about batching rather than about chunking:

- **The layers have to be global, not per chunk.** A `Graphics` between every pair of
  sprite batches breaks them, so one face-layer and one top-layer per chunk cost 114 draw
  calls at 38 visible chunks. Split globally — all faces, then all tops — it is 25.
- **Smaller chunks are the wrong lever, measured.** At 16 tiles the frame cost is
  unchanged and the draw calls triple, because each chunk's face geometry is its own
  object. The chunk size stays 32.

The frame budget in this ADR is unchanged and still holds: settled p99 is around 2.3ms of
the 8ms allowed.
