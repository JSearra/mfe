"""
Lay every terrain subject out as the map lays it out, and write one reviewable PNG.

    tools/art/.venv/bin/python tools/art/contact_sheet.py --in public/assets/terrain

A tile that looks good alone can still be unusable. The defects that have actually
shipped in this project were all invisible in the source image and obvious the moment
the tile was repeated: a centred bush becomes a grid of identical bushes, a gravel
ring becomes a hoop pattern marching across the veld, banded rock becomes plywood.
None of them are detectable from the file, its size, its palette, or any test that
does not involve looking. So this renders the thing that has to be judged.
"""

import argparse
import pathlib
import sys

from PIL import Image

ROWS = 4
COLS = 5
SCALE = 2


def sheet_for(paths: list[pathlib.Path]) -> Image.Image:
    tiles = [Image.open(p).convert("RGBA") for p in paths]
    w, h = tiles[0].size
    half = h // 2
    # The staggered layout of the isometric grid, so seams and repeats fall where they
    # fall in game rather than in a rectangular grid that hides them.
    out = Image.new("RGBA", (w * COLS, half * ROWS + half), (18, 18, 20, 255))
    for row in range(ROWS):
        for col in range(COLS):
            tile = tiles[(row * COLS + col) % len(tiles)]
            x = col * w + (w // 2 if row % 2 else 0)
            out.paste(tile, (x, row * half), tile)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="src", default="public/assets/terrain")
    parser.add_argument("--out", default="tools/art/out/contact-sheet.png")
    parser.add_argument("--only", default="", help="One subject by name")
    args = parser.parse_args()

    src = pathlib.Path(args.src)
    subjects: dict[str, list[pathlib.Path]] = {}
    for path in sorted(src.glob("*.png")):
        # Skip anything that is not a `subject_seed` tile — the directory also holds the
        # packed page the renderer actually loads, and counting that as a ninth terrain
        # type puts a sheet of the whole atlas at the bottom of the review.
        subject, _, seed = path.stem.rpartition("_")
        if not subject or not seed.isdigit():
            continue
        subjects.setdefault(subject, []).append(path)
    if args.only:
        subjects = {k: v for k, v in subjects.items() if k == args.only}
    if not subjects:
        print(f"no tiles in {src}", file=sys.stderr)
        return 1

    panels = {name: sheet_for(paths) for name, paths in subjects.items()}
    label = 12
    width = max(p.width for p in panels.values())
    height = sum(p.height + label for p in panels.values())
    sheet = Image.new("RGBA", (width, height), (18, 18, 20, 255))

    from PIL import ImageDraw

    draw = ImageDraw.Draw(sheet)
    y = 0
    for name, panel in panels.items():
        draw.text((2, y + 2), f"{name}  ({len(subjects[name])})", fill=(200, 200, 200))
        y += label
        sheet.paste(panel, (0, y), panel)
        y += panel.height

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.resize((sheet.width * SCALE, sheet.height * SCALE), Image.NEAREST).save(out)
    print(f"[contact_sheet] {len(panels)} subjects -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
