"""
Drive the local image model to produce terrain tiles and props.

    python tools/art/generate_tiles.py --out tools/art/raw --variants 4

Everything here exists to fight the model's natural tendency, which is to make every
image a little different. A tile set whose members disagree about light direction or
green looks worse than flat colours, so the prompt template pins the things that must
not vary and the seed is derived rather than random.

WHAT THIS IS AND IS NOT GOOD FOR

Good: ground textures, rock, scrub, thatch, hides, and anything that becomes a surface.
Poor: anything that must tile seamlessly at the edges — diffusion has no notion of wrap,
and the seam score from postprocess.py will tell you how badly. If seams matter more
than richness, procedural noise beats this outright and costs nothing.
Useless: directional unit animation. See tools/art/README.md.
"""

import argparse
import json
import os
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
MFLUX = HERE / ".venv" / "bin" / "mflux-generate"

# Pinned across every generation. A tile set that disagrees about where the sun is reads
# as broken no matter how good each tile is on its own.
STYLE = (
    "flat overhead texture, orthographic, no perspective, no horizon, no sky, "
    "single light source from the upper left, soft even lighting, no cast shadows, "
    # The land, not the dry season. This is summer-rainfall grassland in the uplands of
    # what is now KwaZulu-Natal and Lesotho: green for much of the year, over the deep
    # orange-red oxidic soil that is most of the region's ground. The first set came out
    # uniformly ochre and read as Karoo everywhere, which is the wrong half of the
    # country — and the Karoo is a map script here, not the default landscape.
    "green summer grassland, orange-red iron-rich soil, "
    "hand-painted 2D game texture, seamless, "
    # An allover pattern, emphatically. The first batch produced a picture OF a bush,
    # centred in frame, rather than a texture OF scrub — which tiles into a grid of
    # identical centred bushes. A texture has no subject, and the model has to be told.
    "allover repeating pattern, evenly distributed detail across the whole frame, "
    "no focal point, no single subject, no centred composition, "
    "no text, no border, no vignette"
)

SUBJECTS = {
    # Careful with "fine detail" anywhere in this file. The source is 512px and the tile
    # is 64x32, so an eight-to-one downscale averages fine detail into flat colour.
    # Whatever should be visible in play has to be big enough in the source to survive
    # that, without being so big it becomes a subject.
    # Rewritten against references for the KwaZulu-Natal midlands rather than for a
    # generic savanna. This is summer-rainfall SOURVELD: short, dense, tussocky grass on
    # acid soil, green through the wet months, with the red-brown earth only glimpsed
    # between tufts rather than dominating. The previous prompt led with "deep orange-red
    # earth" and got exactly that — bare ground with grass on it, which is the Karoo
    # again and not the Midlands.
    "savanna-low": (
        "dense short green grassland, many small tussocks of grass growing close "
        "together and touching, only narrow glimpses of red-brown soil between them, "
        "summer growth, evenly covering the whole frame"
    ),
    "savanna-mid": (
        "lush green summer grassland, dense tufts of green grass over red-brown soil, "
        "scattered small stones, soil visible between the tufts"
    ),
    # "thin and wind-combed" produced exactly that: every blade lying the same way, which
    # reads as brushed fur and, worse, gives the tile a direction — so laying four of
    # them together shows the grain turning at every seam.
    "savanna-high": (
        "pale green and straw sourveld grass growing in small separate tufts on stony "
        "red ground, bare earth visible between the tufts, no combing, no single direction"
    ),
    # The Drakensberg is capped by Jurassic flood basalt sitting on Clarens sandstone,
    # and the dark cliff above the pale rampart is the single most recognisable thing
    # about the range. The old prompt asked for "grey-brown ironstone", which came back
    # PALER than the sandstone below it and inverted the section.
    "rock": (
        "dark grey basalt rock seen from directly above, near-black volcanic stone "
        "broken into angular blocks, deep shadow in the joints between them, patches "
        "of pale grey-green lichen, no soil, no grass"
    ),
    # "banded strata" came back as flat horizontal stripes — plywood, not rock. Broken
    # and mottled gets weathered stone; the word "bands" does not.
    # Pitting and fine cracks do not survive an eight-to-one downscale, which is why
    # three passes at this came out as flat orange. Broken slabs are big enough to.
    # Clarens sandstone, which is cream to honey rather than red — it is the pale
    # rampart the dark basalt sits on, and photographs of the escarpment describe it
    # glowing gold. Asking for "orange-red sandstone" made it a second donga.
    "sandstone": (
        "pale cream and honey-gold sandstone seen from directly above, weathered into "
        "irregular rounded slabs, soft shadowed gaps between them, warm buff and pale "
        "yellow, no red, no stripes, no straight lines, no grain direction"
    ),
    "donga-floor": (
        "cracked dry orange-red clay with fine erosion channels, deep shadow in the "
        "cracks, bare exposed subsoil, no vegetation"
    ),
    # Three attempts. "a thorn bush" gave a portrait of one bush, centred. Correcting
    # that with "tiny and dark", "speckling" and "seen from far above" gave literally
    # that: black specks on a blank plane, no ground at all. The subjects that work
    # describe the substrate first and the vegetation second, so this one now does too.
    "thornveld": (
        "orange-red earth and fine gravel, low grey-green thorn scrub and green grass "
        "tufts growing across it, bare red ground visible between the bushes"
    ),
    # Large pebbles make a tile with a few big shapes in it, and a few big shapes is what
    # the eye picks out and follows when the tile repeats.
    # "dark sand ... green with algae" came back nearly black, which reads as tar rather
    # than as a riverbed. Wet sand is DARKER than dry sand and still pale; the words that
    # matter are the ones naming the colour it is, not the direction it moves.
    "riverbed": (
        "pale damp sand packed with many small rounded pebbles of even size, light "
        "grey-brown, a few patches of green algae, no large stones, no boulders"
    ),
}

# Seeds that came back unusable, and what was wrong with them.
#
# The model does not always give ground. Asked for grassland it sometimes gives a
# PLOUGHED FIELD: regular parallel rows, which tile into corduroy running across the
# open veld and read as farmland from horizon to horizon. savanna-low seed 1501 was one,
# and it shipped — it is the striping visible in any wide shot of the grass.
#
# A rejected seed is SKIPPED and the next one taken, never renumbered, so every other
# tile in the set keeps the seed it already had and a rejection here churns one image
# rather than the whole subject.
#
# Measure first, then look; neither alone is enough. Row-periodicity, as the strength of
# the strongest component between 4 and 64 pixels against the noise, separated 1501
# (1.16) from every other source in the set (0.14 to 0.65) and named the defect exactly.
# It did NOT catch seed 1504, which has no periodicity at all and is a mat of rosette
# plants split by branching orange channels — wrong ground, scored clean. The number
# finds the repeat; the eye finds everything else.
REJECTED: dict[str, dict[int, str]] = {
    "savanna-low": {
        1501: "regular parallel rows - ploughed field, corduroy across the veld",
    },
}


def seeds_for(name: str, base: int, count: int) -> list[int]:
    """`count` usable seeds for a subject, stepping over the rejected ones."""
    rejected = REJECTED.get(name, {})
    out: list[int] = []
    seed = base
    while len(out) < count:
        if seed not in rejected:
            out.append(seed)
        seed += 1
    return out


def generate(name: str, subject: str, seed: int, args: argparse.Namespace) -> pathlib.Path:
    out = pathlib.Path(args.out) / f"{name}_{seed}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and not args.force:
        print(f"  {out.name}: exists, skipping")
        return out

    command = [
        str(MFLUX),
        "--model", args.model,
        "--base-model", args.base_model,
        "--steps", str(args.steps),
        "--width", str(args.size),
        "--height", str(args.size),
        "--seed", str(seed),
        "--prompt", f"{subject}, {STYLE}",
        "--output", str(out),
    ]
    # Only quantise when pointed at a full-precision repo. The default model is already
    # 4-bit, and asking mflux to quantise it again is both wasteful and wrong.
    if args.quantize:
        command[3:3] = ["-q", str(args.quantize)]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    print(f"  {out.name}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--out", default="tools/art/raw")
    parser.add_argument("--variants", type=int, default=3, help="Variants per subject")
    # A PRE-QUANTISED repo, and that is the whole point. Asking mflux to quantise a
    # full-precision model reads the full weights into memory first, so a 22GB model
    # needs 22GB of RAM to become a 6GB one — which fails on any ordinary machine. A
    # repo that is already 4-bit loads at its own size. Ungated too: FLUX.1-schnell is
    # Apache-2.0, so this redistribution needs no licence acceptance and no token.
    parser.add_argument("--model", default="mflux-community/flux-1-schnell-mflux-q4")
    parser.add_argument("--base-model", default="schnell", help="Architecture the repo is based on")
    parser.add_argument(
        "--quantize",
        type=int,
        default=0,
        help="Quantise at load time. Leave at 0 for an already-quantised repo.",
    )
    parser.add_argument("--steps", type=int, default=4, help="schnell is a 4-step model")
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--seed", type=int, default=1000, help="Base seed")
    parser.add_argument("--only", default="", help="Generate a single subject by name")
    parser.add_argument("--force", action="store_true", help="Regenerate images that exist")
    args = parser.parse_args()

    if not MFLUX.exists():
        print(f"mflux not found at {MFLUX}. See tools/art/README.md.", file=sys.stderr)
        return 1

    subjects = {args.only: SUBJECTS[args.only]} if args.only else SUBJECTS
    if args.only and args.only not in SUBJECTS:
        print(f"unknown subject {args.only!r}; known: {', '.join(SUBJECTS)}", file=sys.stderr)
        return 1

    # A subject's seed is derived from its position in the FULL list, not in whatever
    # subset is being generated. Deriving it from the filtered list meant `--only
    # thornveld` reused the seeds of whichever subject sorts first, so a regenerated
    # subject came back under different filenames and sat alongside the originals
    # instead of replacing them. Reproducibility that depends on which flags you passed
    # is not reproducibility.
    order = {name: index for index, name in enumerate(sorted(SUBJECTS))}

    written = []
    for name, subject in sorted(subjects.items()):
        print(f"{name}:")
        # Stale outputs for this subject go, so a regenerated prompt replaces rather
        # than accumulates.
        for old in pathlib.Path(args.out).glob(f"{name}_*.png"):
            old.unlink()

        # Derived, not random: the same invocation reproduces the same tiles, which is
        # what lets a set be regenerated after a prompt tweak without churning every
        # unrelated image. Rejected seeds are stepped over — see REJECTED.
        for seed in seeds_for(name, args.seed + order[name] * 100, args.variants):
            written.append(str(generate(name, subject, seed, args)))

    # The manifest describes the directory, not this invocation. Listing only what this
    # run wrote meant `--only thornveld` left a manifest claiming the set was three
    # images, so anything reading it to find out what exists got a truncated answer.
    manifest = pathlib.Path(args.out) / "generated.json"
    present = sorted(str(path) for path in pathlib.Path(args.out).glob("*.png"))
    manifest.write_text(json.dumps({"style": STYLE, "images": present}, indent=2) + "\n")
    print(f"\n[generate_tiles] {len(written)} images written, {len(present)} in {args.out}")
    print("next: python tools/art/postprocess.py tile --in %s --out public/assets/terrain" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
