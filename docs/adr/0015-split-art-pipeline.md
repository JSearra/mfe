# ADR-0015: Generation makes surfaces, Blender makes units

**Status:** Accepted — 2026-09-13
**Relates to:** `ARCHITECTURE.md` section 9

## Context

The project chose "AI-generated tiles + sprites" during planning, with a caveat recorded
at the time: image generation does not reliably produce consistent multi-frame
directional unit animation. `ARCHITECTURE.md` section 9 has carried that as the open
problem — and as the likeliest thing to stall the project — ever since.

Building the pipeline confirmed the caveat rather than dissolving it. The difficulty is
not volume, it is agreement. Four factions x six unit types x eight directions x ~15
frames is about 2,880 frames, and those frames have to be the *same soldier*. A
diffusion model asked for one man from eight angles returns eight men who resemble each
other.

## Decision

Two pipelines, split by failure mode rather than by asset category.

**Generation (`mflux`, local, Apple Silicon) for surfaces** — terrain, rock, thatch,
hides, props, and textures that models will wear. One image at a time, where consistency
is enforceable afterwards: `postprocess.py tile` snaps every pixel to the palette in
`tuning/presentation.json`, masks to the exact 64x32 diamond, and scores seam
disagreement so the worst of a batch can be rejected.

**Blender, headless, for units.** `render_sprites.py` rotates one model through eight
directions and steps its animation, which makes consistency free rather than
enforceable. This is how AoE2 itself was made. Generation still contributes indirectly,
producing the textures the models wear.

## Two findings worth recording

**The camera is 30 degrees, not 35.264.** That second number is *true* isometric, where
all three axes foreshorten equally, and it is what most tutorials give. It produces a
1.732:1 tile. This project's grid is 2:1, which needs 30 degrees of elevation at 45 of
azimuth — the derivation is in `render_sprites.py`. `verify_camera.py` renders a unit
ground square and measures it, because the failure is invisible by eye and permanent in
the assets: it measured 1.982:1, which is 2:1 within antialiasing.

**The default model is `z-image-turbo` because it is ungated.** FLUX.1-schnell is the
better-known choice and returns `GatedRepoError` without a HuggingFace licence
acceptance and an auth token. Depending on a credential would have made the pipeline
unrunnable for anyone who had not personally clicked through a licence, and this project
does not handle tokens. An ungated model of adequate quality is worth more than a
marginally better gated one.

## A constraint that decides the model, not the quantisation

`-q 4` quantises at load time: the full-precision weights are read into memory before
being reduced. So the number that matters on a given machine is the *unquantised* size,
not the quantised one. A 6B model with a large text encoder is over 20GB on disk and
cannot be loaded to be quantised on 16GB of RAM.

The practical consequence is that model choice is bounded by RAM rather than by taste,
and the answer to "it will not fit" is a smaller model rather than a smaller
quantisation. Worth checking before a multi-gigabyte download rather than after.

## Consequences

- The renderer stays asset-agnostic behind a manifest, so neither half of the pipeline
  is visible to it — which is what makes this reversible.
- `postprocess.py sprite` records the trim offset per frame. That is load-bearing: the
  renderer positions a sprite by its foot, so discarding transparent margin without
  recording how much silently moves every unit.
- Two of the three atlas-budget mitigations in ARCHITECTURE section 9 are still unbuilt:
  palette-swapping player colour in a shader (pre-tinting multiplies the atlas by
  faction count) and sharing silhouettes across factions. The mirror trick is
  implemented as `--mirror`.
- Seamless tiling remains luck rather than a guarantee — diffusion has no notion of edge
  wrap. The seam score measures it. Where seams matter more than richness, procedural
  noise beats generation outright and costs nothing.
