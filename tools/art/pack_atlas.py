"""
Pack trimmed sprite frames into atlas pages.

    tools/art/.venv/bin/python tools/art/pack_atlas.py \
        --in tools/art/out/sprites --out public/assets/sprites

Two reasons, and the second is the one that bites.

Draw calls. The budget is 60 a frame (docs/ROADMAP.md). Pixi batches sprites that
share a texture and breaks the batch when one changes, so 1440 separate textures is a
worst case of 1440 batch breaks. One page is one batch no matter how many units are on
screen.

Repo weight. 1440 loose PNGs is 8.2MB of binaries that churn in full every time a
colour changes, and none of it diffs. The atlas is a handful of files, and the frames
are regenerable from the scripts either way.

The JSON records the trim offset per frame. That offset is load-bearing: frames are
cropped to their opaque bounding box, so a raised spear makes one frame taller than the
next, and drawing them at a common origin makes the unit bob. The renderer places by
foot, and the foot is only recoverable with the offset.
"""

import argparse
import json
import pathlib
import sys

from PIL import Image

PADDING = 1


def shelf_pack(sizes: list[tuple[str, int, int]], page: int) -> tuple[list[dict], list[tuple[str, int, int]]]:
    """
    Shelf-pack tallest-first onto one page. Returns placements and what did not fit.

    Shelf rather than MaxRects: these frames are all within a whisker of the same size,
    which is the case shelf packing handles about as well as anything more clever and in
    a tenth of the code.
    """
    placed: list[dict] = []
    x = y = shelf_height = 0

    remaining: list[tuple[str, int, int]] = []
    for name, width, height in sizes:
        if width > page or height > page:
            raise SystemExit(f"{name} is {width}x{height}, larger than a {page}px page")
        if x + width + PADDING > page:
            x = 0
            y += shelf_height + PADDING
            shelf_height = 0
        if y + height + PADDING > page:
            remaining.append((name, width, height))
            continue
        placed.append({"name": name, "x": x, "y": y, "w": width, "h": height})
        x += width + PADDING
        shelf_height = max(shelf_height, height)

    return placed, remaining


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="src", default="tools/art/out/sprites")
    parser.add_argument("--out", dest="out", default="public/assets/sprites")
    # 3072 rather than 2048 or 4096. The set needs 5.5M pixels: 2048 spills to a second
    # page and a second batch, 4096 fits in one but leaves two thirds of a 67MB texture
    # empty. 3072 is one page at 57% and 37MB.
    parser.add_argument("--page", type=int, default=3072, help="Page edge in pixels")
    parser.add_argument("--origins", default="", help="origins.json from the render step")
    args = parser.parse_args()

    src = pathlib.Path(args.src)
    trim = json.loads((src / "manifest.json").read_text())["sprites"]
    offsets = {entry["file"]: entry for entry in trim}

    # Where the foot sits in the untrimmed frame, measured in Blender. Carried through
    # rather than assumed: the camera aims above the ground so the origin is nowhere
    # near the centre of the frame.
    origins_path = pathlib.Path(args.origins) if args.origins else src.parent / "origins.json"
    origins = json.loads(origins_path.read_text()) if origins_path.exists() else {}
    if not origins:
        print(f"warning: no origins at {origins_path}; sprites will be centred", file=sys.stderr)

    images = {path.name: Image.open(path).convert("RGBA") for path in sorted(src.glob("*.png"))}
    if not images:
        print(f"no sprites in {src}", file=sys.stderr)
        return 1

    # Tallest first: shelf packing wastes the difference between the tallest frame on a
    # shelf and every other frame on it, so sorting by height minimises that.
    sizes = sorted(
        ((name, im.width, im.height) for name, im in images.items()),
        key=lambda entry: (-entry[2], entry[0]),
    )

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("atlas-*.png"):
        stale.unlink()

    frames: dict[str, dict] = {}
    pages: list[str] = []
    while sizes:
        placed, sizes = shelf_pack(sizes, args.page)
        if not placed:
            raise SystemExit("nothing fits; increase --page")
        index = len(pages)
        page = Image.new("RGBA", (args.page, args.page), (0, 0, 0, 0))
        for spot in placed:
            page.paste(images[spot["name"]], (spot["x"], spot["y"]))
            stem = spot["name"].removesuffix(".png")
            entry = offsets.get(spot["name"], {"offsetX": 0, "offsetY": 0})
            frames[stem] = {
                "page": index,
                "x": spot["x"],
                "y": spot["y"],
                "w": spot["w"],
                "h": spot["h"],
                "offsetX": entry["offsetX"],
                "offsetY": entry["offsetY"],
            }
        name = f"atlas-{index}.png"
        page.save(out / name)
        pages.append(name)

    # Group by kind and animation so the renderer can build a lookup once at load rather
    # than composing a key string per entity per frame. Nothing outside this file knows
    # an atlas coordinate; ARCHITECTURE section 9 wants the renderer asset-agnostic.
    catalogue: dict[str, dict[str, int]] = {}
    for stem in frames:
        kind, anim, direction, frame = stem.rsplit("_", 3)
        entry = catalogue.setdefault(kind, {})
        entry[anim] = max(entry.get(anim, 0), int(frame) + 1)

    directions = 1 + max(int(stem.rsplit("_", 3)[2]) for stem in frames)
    (out / "atlas.json").write_text(
        json.dumps(
            {"pages": pages, "pageSize": args.page, "directions": directions,
             "origins": origins, "kinds": catalogue, "frames": frames},
            indent=1,
        )
        + "\n"
    )

    used = sum(f["w"] * f["h"] for f in frames.values())
    print(
        f"[pack_atlas] {len(frames)} frames -> {len(pages)} page(s) of {args.page}px, "
        f"{used / (len(pages) * args.page**2):.0%} filled"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
