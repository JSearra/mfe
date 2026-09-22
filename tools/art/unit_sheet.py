"""
Lay units out at the size the game actually draws them, and write one reviewable PNG.

    tools/art/.venv/bin/python tools/art/unit_sheet.py \
        --kinds impi herd-boy field-hand carrier elder --out tools/art/out/villagers.png

`contact_sheet.py` does this for terrain, where the thing that has to be judged is how a
tile repeats. For a unit it is a different question, and the answer is smaller than
anyone expects: a sprite is about fifty pixels tall in play, so what a player reads is
the outline and nothing else. Interior detail, shading and hue are almost entirely
thrown away by the downscale.

So this sheet draws three things, and the third is the one that decides the argument.

  1. Every kind at exact play scale, standing on one ground line. Scale comes from the
     atlas the way the renderer computes it — `pixelsPerWorldUnit / pixelsPerUnit` — so
     a cow and a man disagree about size here exactly as much as they do in game, which
     is the point of recording `pixelsPerUnit` in the first place.
  2. The same row magnified with nearest-neighbour, because a defect has to be visible
     to be fixed and 50px is not enough to see one.
  3. **The same row as flat silhouettes.** Colour is removed entirely. If two kinds are
     still tellable apart here they are tellable apart at any distance, on any ground, in
     fog, and under a selection tint. If they are not, they differ by paint, and this
     project has already shipped one pair of assets — two tree species — that differed
     only by a tint and were indistinguishable the moment they were on the map.

Feet are placed through the recorded origin and trim offset, not by bottom-aligning the
frames. Frames are trimmed to their opaque bounding box, so bottom-aligning a raised
hoe against a standing figure silently moves one of them off the ground.
"""

import argparse
import json
import pathlib
import sys

from PIL import Image

# The colour of the ground these stand on: the low end of the terrain palette in
# tuning/presentation.json. Judging a sprite on white is judging a different sprite.
VELD = (74, 96, 47, 255)
# tuning/presentation.json -> sprites.pixelsPerWorldUnit. How big a metre is on screen at
# zoom 1. The camera runs 0.5x to 2x, so this is the honest middle and the fair test.
PIXELS_PER_WORLD_UNIT = 29.0


def load(atlas_dir: pathlib.Path):
    atlas = json.loads((atlas_dir / "atlas.json").read_text())
    pages = [Image.open(atlas_dir / name).convert("RGBA") for name in atlas["pages"]]
    return atlas, pages


def cut(atlas, pages, kind: str, anim: str, direction: int, frame: int):
    """One frame, plus where its subject's foot sits inside it."""
    entry = atlas["frames"].get(f"{kind}_{anim}_{direction}_{frame:02d}")
    if entry is None:
        return None
    image = pages[entry["page"]].crop(
        (entry["x"], entry["y"], entry["x"] + entry["w"], entry["y"] + entry["h"])
    )
    origin = atlas["origins"].get(kind, {"x": 64, "y": 64, "pixelsPerUnit": 58.18})
    scale = PIXELS_PER_WORLD_UNIT / origin["pixelsPerUnit"]
    return image, origin["x"] - entry["offsetX"], origin["y"] - entry["offsetY"], scale


def place(sheet, cutout, foot_x: int, foot_y: int, zoom: float = 1.0, flatten=None):
    image, anchor_x, anchor_y, scale = cutout
    scale *= zoom
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    # BOX, not NEAREST. This is the downscale the GPU does when the sprite is drawn at
    # half size, and a nearest-neighbour preview of it is a different picture that hides
    # exactly the thin features — a stick, a hoe haft — most likely to disappear.
    small = image.resize(size, Image.BOX)
    if flatten is not None:
        alpha = small.getchannel("A")
        small = Image.new("RGBA", size, flatten)
        small.putalpha(alpha)
    sheet.alpha_composite(small, (round(foot_x - anchor_x * scale), round(foot_y - anchor_y * scale)))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kinds", nargs="+", required=True)
    parser.add_argument("--atlas", default="public/assets/sprites")
    parser.add_argument("--out", default="tools/art/out/unit-sheet.png")
    parser.add_argument("--anim", default="idle")
    parser.add_argument("--direction", type=int, default=2)
    args = parser.parse_args()

    atlas, pages = load(pathlib.Path(args.atlas))
    kinds = args.kinds
    missing = [k for k in kinds if k not in atlas["kinds"]]
    if missing:
        print(f"not in the atlas: {', '.join(missing)}", file=sys.stderr)
        return 1

    cell, pad = 120, 18
    width = pad + len(kinds) * cell
    # Four bands: play scale, play scale magnified, silhouettes magnified, and every
    # direction of every kind at play scale.
    bands = [150, 300, 300, 150]
    sheet = Image.new("RGBA", (width, pad + sum(bands) + pad * len(bands)), VELD)

    y = pad
    for band, (label, zoom, flat) in enumerate(
        [("play", 1.0, None), ("magnified", 3.0, None), ("silhouette", 3.0, (16, 12, 8, 255))]
    ):
        for index, kind in enumerate(kinds):
            frames = atlas["kinds"][kind]
            anim = args.anim if args.anim in frames else next(iter(frames))
            cutout = cut(atlas, pages, kind, anim, args.direction, 0)
            if cutout is None:
                continue
            place(sheet, cutout, pad + index * cell + cell // 2, y + bands[band] - 20, zoom, flat)
        y += bands[band] + pad

    # Every direction, so a kind that only works from one angle is caught here rather
    # than in play. Five of eight are rendered and three are mirrored; a mirror that went
    # to the wrong index shows up as a figure facing the wrong way along this row.
    for index, kind in enumerate(kinds):
        frames = atlas["kinds"][kind]
        anim = args.anim if args.anim in frames else next(iter(frames))
        for direction in range(atlas["directions"]):
            cutout = cut(atlas, pages, kind, anim, direction, 0)
            if cutout is None:
                continue
            place(sheet, cutout, pad + index * cell + 14 + direction * 12, y + bands[3] - 20)

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out)
    print(f"[unit_sheet] {len(kinds)} kinds -> {out} ({sheet.width}x{sheet.height})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
