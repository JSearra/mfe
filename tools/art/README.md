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

The default model is `z-image-turbo`, chosen because it is **ungated**. FLUX.1-schnell
is the better-known choice and needs a HuggingFace licence click-through and an auth
token; avoiding that keeps the pipeline runnable without credentials. If you would
rather use Flux, accept the licence and run `huggingface-cli login` yourself — this
project does not handle tokens.

Roughly 12GB of model weights land in `~/.cache/huggingface` on first run.

## Terrain and props

```bash
python tools/art/generate_tiles.py --out tools/art/raw --variants 4
python tools/art/postprocess.py tile --in tools/art/raw --out public/assets/terrain
```

`generate_tiles.py` pins light direction, palette and projection in every prompt, and
derives seeds rather than randomising them, so the same invocation reproduces the same
set. `postprocess.py tile` then does the work that makes the output usable: snapping
every pixel to the palette in `tuning/presentation.json`, masking to the exact 64x32
diamond, and scoring each tile for seam disagreement so the worst of a batch can be
thrown back.

**Honest limitation:** diffusion has no notion of edge wrap, so seamless tiling is luck.
The seam score tells you how lucky. Where seams matter more than richness, procedural
noise beats this outright and costs nothing.

## Unit sprite sheets

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
