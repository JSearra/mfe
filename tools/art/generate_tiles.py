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
    "no text, no border, no vignette"
)

SUBJECTS = {
    "savanna-low": "dry red-brown dust and gravel with sparse tufts of grass",
    "savanna-mid": "sun-bleached tall grass over dry earth, scattered stones",
    "savanna-high": "pale yellow sourveld grass, thin and wind-combed",
    "rock": "weathered ironstone and broken shale, grey-brown",
    "sandstone": "warm banded sandstone, horizontal strata, dry",
    "donga-floor": "cracked dry clay with fine erosion channels, deep shadow in cracks",
    "thornveld": "low thorny acacia scrub over dry ground, small dark leaves",
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
        "-q", str(args.quantize),
        "--steps", str(args.steps),
        "--width", str(args.size),
        "--height", str(args.size),
        "--seed", str(seed),
        "--prompt", f"{subject}, {STYLE}",
        "--output", str(out),
    ]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    print(f"  {out.name}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--out", default="tools/art/raw")
    parser.add_argument("--variants", type=int, default=3, help="Variants per subject")
    parser.add_argument("--model", default="z-image-turbo")
    parser.add_argument("--quantize", type=int, default=4)
    parser.add_argument("--steps", type=int, default=8)
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

    written = []
    for index, (name, subject) in enumerate(sorted(subjects.items())):
        print(f"{name}:")
        for variant in range(args.variants):
            # Derived, not random: the same invocation reproduces the same tiles, which
            # is what lets a set be regenerated after a prompt tweak without churning
            # every unrelated image.
            seed = args.seed + index * 100 + variant
            written.append(str(generate(name, subject, seed, args)))

    manifest = pathlib.Path(args.out) / "generated.json"
    manifest.write_text(json.dumps({"style": STYLE, "images": written}, indent=2) + "\n")
    print(f"\n[generate_tiles] {len(written)} images -> {args.out}")
    print("next: python tools/art/postprocess.py tile --in %s --out public/assets/terrain" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
