# Art pipeline

Two pipelines, because the two asset classes have different failure modes.

| Asset | Tool | Why |
|---|---|---|
| Terrain, props, textures | `mflux` (local image model) | One image at a time; consistency is enforceable in post |
| Unit sprite sheets | Blender, headless | ~120 images that must agree with each other; only a renderer gives that |

## The split, and why it is not negotiable

`ARCHITECTURE.md` section 9 names directional unit animation as the likeliest thing to
stall this project: four factions x six unit types x eight directions x ~15 frames is
about 2,880 frames, against roughly 1,024 per 4096-square atlas page.

Image generation does not solve that, and the reason is consistency rather than volume.
A soldier asked for from eight angles across fifteen frames comes back as a hundred and
twenty slightly different men — different proportions, different shield, different
shade of ochre. A rotated 3D model comes back as one man a hundred and twenty times.

So: generation makes surfaces, Blender makes units. Generation still helps with units
indirectly, by producing the textures the models wear and concept art to model from.

If modelling is not a skill you want to acquire, buying low-poly packs (Kenney, Synty
and similar) and rendering those is a legitimate shortcut that skips the hard part
entirely. The render script does not care where the model came from.

## Setup

Already installed by the session that wrote this:

```bash
brew install --cask blender                 # 5.2.1
python3 -m venv tools/art/.venv
tools/art/.venv/bin/pip install mflux       # pulls MLX, Apple Silicon native
```

The default model is `mflux-community/flux-1-schnell-mflux-q4`, and both halves of that
name matter.

**Pre-quantised.** `-q 4` on a full-precision repo quantises at LOAD time, so the full
weights are read into memory first — a 22GB model needs 22GB of RAM to become a 6GB one,
which fails on any ordinary machine. A repo that is already 4-bit loads at its own size.
This is the constraint that decides which models are usable locally, and it is not
obvious from the flag.

**Ungated.** `black-forest-labs/FLUX.1-schnell` returns `GatedRepoError` without a
licence acceptance and an auth token. FLUX.1-schnell is Apache-2.0, so this community
redistribution is legal and needs neither — the pipeline runs without credentials, and
this project does not handle tokens.

Two attempts failed before this one, and both failures are worth knowing about.
`black-forest-labs/FLUX.1-schnell` is gated. `z-image-turbo` is ungated but pulled 31GB
and then raised `FileNotFoundError: No safetensors files found in .../text_encoder_2` —
a repo layout mflux could not load. Check `?blobs=true` on the HuggingFace API for size
and `gated` before starting a large download.

The default model is about 9GB in `~/.cache/huggingface`. Smaller pre-quantised repos
exist if that is too much — `Runpod/FLUX.2-klein-4B-mflux-4bit` is 4.3GB — and every
mflux built-in name that is *not* pre-quantised is 22GB or more.

## Terrain and props

```bash
python tools/art/generate_tiles.py --out tools/art/raw --variants 4
python tools/art/postprocess.py tile --in tools/art/raw --out public/assets/terrain
```

`generate_tiles.py` pins light direction, palette and projection in every prompt, and
derives seeds rather than randomising them, so the same invocation reproduces the same
set. `postprocess.py tile` then does the work that makes the output usable: toning each
image toward a height band from the palette in `tuning/presentation.json`, masking to
the exact 64x32 diamond, and scoring each tile for seam disagreement so the worst of a
batch can be thrown back.

**Toning, not snapping.** The first version replaced every pixel with the nearest
palette entry, and it was wrong in a way only the output showed: the palette is an
eight-step ramp for shading height bands, so snapping a texture to it collapsed a rich
red-dust-and-scrub surface to flat khaki with no texture at all. Harmonising keeps each
pixel's luminance — where all the detail lives — and takes the hue from the band.
`--strength` sets how far to pull, from 0 (keep the generation's own colour) to 1.

**Honest limitation:** diffusion has no notion of edge wrap, so seamless tiling is luck.
The seam score tells you how lucky. Where seams matter more than richness, procedural
noise beats this outright and costs nothing.

## Unit sprite sheets

The pipeline needs a model. If you do not have one, generate a placeholder:

```bash
blender -b -noaudio -P tools/art/make_unit.py -- \
    --kind impi --anim walk --render tools/art/raw/units --mirror
```

`make_unit.py` builds a low-poly figure from primitives and keyframes a cycle — no
armature, just parented limbs with keyframed rotations, which is a fraction of the code
of a rig and indistinguishable at 128 pixels. It is placeholder art and looks it, but it
has real silhouettes, real facing and a real walk, which is enough to attempt Gate 2
without commissioning anything.

With a model of your own:

```bash
blender -b unit.blend -P tools/art/render_sprites.py -- \
    --out tools/art/raw/units --name impi --anim walk --frames 15 --mirror
python tools/art/postprocess.py mirror --in tools/art/raw/units
python tools/art/postprocess.py sprite --in tools/art/raw/units --out public/assets/units
```

`--mirror` renders five of eight directions and fills the rest by reflection, which is
what AoE2 did and cuts the atlas budget by 37 percent. It costs asymmetric detail — a
shield on the left arm appears on the right in mirrored frames — so it is a choice per
unit, not a global setting.

`postprocess.py sprite` trims each frame to its opaque bounding box **and records the
offset**. That offset is load-bearing: the renderer positions a sprite by its foot, so
discarding transparent margin without recording how much silently moves every unit.

### The camera angle is 30 degrees

Not 35.264. That is *true* isometric, where all three axes foreshorten equally, and
games almost never use it because it makes tiles 2:1.732. This project's 2:1 diamond
needs 30 degrees of elevation at 45 degrees of azimuth. The derivation is in the header
of `render_sprites.py`; it is worth reading before changing the number, because half the
tutorials on the subject are wrong about it.

## What still has to be decided

Three things `ARCHITECTURE.md` section 9 lists as making the budget survivable, of which
only the first is implemented here:

1. Mirror three of eight directions — done, `--mirror`.
2. **Palette-swap player colour in a shader**, not by pre-tinting per faction. Pre-tinting
   multiplies the atlas by faction count. Not built yet.
3. Share silhouettes across factions where historically defensible. A content decision,
   not a tooling one — see `docs/CONTENT.md`.
