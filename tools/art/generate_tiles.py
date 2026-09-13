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
    "muted ochre and olive palette, hand-painted 2D game texture, seamless, "
    # An allover pattern, emphatically. The first batch produced a picture OF a bush,
    # centred in frame, rather than a texture OF scrub — which tiles into a grid of
    # identical centred bushes. A texture has no subject, and the model has to be told.
    "allover repeating pattern, evenly distributed detail across the whole frame, "
    "no focal point, no single subject, no centred composition, "
    "no text, no border, no vignette"
)

SUBJECTS = {
    # The plainest texture in the set and the most trouble. Left bare it drew a large
    # gravel ellipse in the middle of the frame; told "no rings, no arcs, no curved
    # lines" it drew a squiggle instead. Naming unwanted geometry worked for the
    # sandstone stripes and does not work here, so this describes density instead:
    # ground covered edge to edge leaves nowhere to put a subject.
    "savanna-low": (
        "dense fine red-brown gravel and grit covering the ground completely, small "
        "stones of even size packed across the whole surface, occasional dry grass tuft"
    ),
    "savanna-mid": "sun-bleached tall grass over dry earth, scattered stones",
    "savanna-high": "pale yellow sourveld grass, thin and wind-combed",
    "rock": "weathered ironstone and broken shale, grey-brown",
    # "banded strata" came back as flat horizontal stripes — plywood, not rock. Broken
    # and mottled gets weathered stone; the word "bands" does not.
    "sandstone": (
        "weathered sandstone surface seen from directly above, mottled cream and rust "
        "patches, irregular pitting and fine cracks, broken uneven tone, no stripes, "
        "no straight lines, no grain direction"
    ),
    "donga-floor": "cracked dry clay with fine erosion channels, deep shadow in cracks",
    # Three attempts. "a thorn bush" gave a portrait of one bush, centred. Correcting that
    # with "tiny and dark", "speckling" and "seen from far above" gave literally that:
    # black specks on a blank tan plane, no ground at all. The subjects that work describe
    # the substrate first and the vegetation second, so this one now does too.
    "thornveld": (
        "dry red-brown earth and fine gravel, low grey-green thorn scrub and dry grass "
        "tufts growing across it, bare ground visible between the bushes"
    ),
    "riverbed": "damp sand and rounded pebbles, darker where wet",
}


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

        for variant in range(args.variants):
            # Derived, not random: the same invocation reproduces the same tiles, which
            # is what lets a set be regenerated after a prompt tweak without churning
            # every unrelated image.
            seed = args.seed + order[name] * 100 + variant
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
