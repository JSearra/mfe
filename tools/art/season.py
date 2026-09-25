"""
Seasonal terrain pages: the same tiles, re-toned for the dry season and for drought.

    tools/art/.venv/bin/python tools/art/season.py

Reads the packed terrain page (public/assets/terrain/tiles.png) and its manifest, and
writes one page per season named in `terrain.seasons` in tuning/presentation.json, in the
SAME layout — every tile at the same place — so the renderer can swap or cross-fade a
chunk between them without a second set of UVs. The manifest gains a `seasons` map from
name to page file.

Roadmap Phase B5 asked for seasonal versions from the art pipeline and "not only a tint",
and this is why that distinction matters. A tint multiplies every pixel by one colour, so
green grass under a gold tint goes muddy olive and the red earth of a donga goes brown
with it. This re-tones each tile toward its OWN band's colour for the season with
the transform `postprocess.harmonise` already applies to tone generations to the palette
(see `harmonise_opaque` below), which keeps every pixel's luminance, where the texture lives, and moves the
tile's mean onto the season's band colour. Low green veld turns gold; the red donga
floor, the sand and the rock barely move, because their season colours barely do.

The water-surface overlay has no band and is left as it is: the water does not change
colour with the season.
"""

import argparse
import json
import pathlib

import numpy as np
from PIL import Image


def harmonise_opaque(tile: Image.Image, target: np.ndarray, strength: float) -> Image.Image:
    """
    `postprocess.harmonise`, measured over the opaque pixels only.

    The same transform — keep each pixel's luminance relative to the tile's mean, take the
    colour from the band — but a transition or corner tile is mostly transparent, and its
    empty pixels would drag the mean down and brighten everything that is drawn. So the
    mean is taken where there is something to see.
    """
    rgba = np.array(tile.convert("RGBA"), dtype=np.float64)
    rgb = rgba[:, :, :3] / 255.0
    opaque = rgba[:, :, 3] > 0
    luminance = rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722
    mean = float(luminance[opaque].mean()) if opaque.any() else 1.0
    if mean < 1e-6:
        mean = 1e-6
    band = target.astype(np.float64) / 255.0
    scaled = band.reshape(1, 1, 3) * (luminance / mean)[:, :, None]
    blended = rgb * (1.0 - strength) + scaled * strength
    out = np.array(tile.convert("RGBA"))
    out[:, :, :3] = np.clip(blended * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def colour(hex_colour: str) -> np.ndarray:
    return np.array(
        [int(hex_colour[1:3], 16), int(hex_colour[3:5], 16), int(hex_colour[5:7], 16)],
        dtype=np.int16,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--terrain", default="public/assets/terrain")
    parser.add_argument("--presentation", default="tuning/presentation.json")
    parser.add_argument(
        "--strength",
        type=float,
        default=0.9,
        help="How far each tile moves onto its season colour. The tiles are already toned "
        "to the wet palette, so most of their own hue is the wet season's and wants "
        "replacing; a little is kept so a band's variants still differ.",
    )
    args = parser.parse_args()

    terrain = pathlib.Path(args.terrain)
    manifest_path = terrain / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    presentation = json.loads(pathlib.Path(args.presentation).read_text())
    seasons = presentation["terrain"]["seasons"]

    page = Image.open(terrain / manifest["page"]).convert("RGBA")
    manifest["seasons"] = {}

    for name, palette in seasons.items():
        out = page.copy()
        for entry in manifest["tiles"]:
            band = entry.get("band")
            if band is None or band >= len(palette):
                continue
            box = (entry["x"], entry["y"], entry["x"] + entry["width"], entry["y"] + entry["height"])
            tile = page.crop(box)
            if np.array(tile)[:, :, 3].max() == 0:
                continue
            toned = harmonise_opaque(tile, colour(palette[band]), args.strength)
            out.paste(toned, box)

        file = f"tiles-{name}.png"
        out.save(terrain / file, optimize=True)
        manifest["seasons"][name] = file
        print(f"wrote {terrain / file}")

    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
