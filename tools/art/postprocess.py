"""
Turn generated images into assets the renderer can actually use.

Generation produces a picture. This produces a tile: masked to the exact diamond the
grid expects, snapped to a fixed palette so neighbouring tiles do not disagree, trimmed
with its offset recorded, and checked for whether it actually tiles.

Without this step AI terrain art looks plausible in isolation and wrong in place — every
tile a slightly different green, seams at every edge, and lighting from a different
direction in each one. The post-process is the pipeline; the model is just a brush.

    python tools/art/postprocess.py tile   --in raw/ --out ../../public/assets/terrain
    python tools/art/postprocess.py sprite --in raw/ --out ../../public/assets/units
    python tools/art/postprocess.py mirror --in units/ --directions 8
"""

import argparse
import json
import os
import pathlib
import sys

import numpy as np
from PIL import Image

# Must match TILE_W / TILE_H in src/shared/iso.ts. A mismatch here is invisible until
# tiles are on screen and a pixel out of register at every seam.
TILE_W = 64
TILE_H = 32


def load_palette(path: pathlib.Path) -> np.ndarray:
    """The terrain palette from tuning/presentation.json, as RGB rows."""
    data = json.loads(path.read_text())
    colours = data["terrain"]["palette"]
    return np.array(
        [[int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)] for c in colours], dtype=np.int16
    )


def harmonise(image: Image.Image, target: np.ndarray, strength: float) -> Image.Image:
    """
    Recolour a texture toward a height band's colour while keeping its detail.

    NOT a snap to the nearest palette entry. That was the first implementation and it
    was wrong in a way only visible in the output: the palette is an eight-step ramp for
    shading height bands, so snapping a texture to it collapses every pixel in a tile to
    one or two colours and a rich red-dust-and-scrub surface comes out flat khaki. The
    palette's job is to say which band a tile belongs to; it was never a description of
    what the ground looks like.

    So: keep each pixel's luminance, which is where all the texture lives, and take the
    hue from the band. `strength` controls how much of the source's own colour survives,
    so a generation whose colour is already right is not fought.
    """
    rgb = np.array(image.convert("RGB"), dtype=np.float64) / 255.0

    # Rec. 709 luminance: matches how the eye weights the channels, so detail is
    # preserved rather than the green channel dominating.
    luminance = rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722

    band = target.astype(np.float64) / 255.0
    band_luminance = band[0] * 0.2126 + band[1] * 0.7152 + band[2] * 0.0722
    if band_luminance < 1e-6:
        band_luminance = 1e-6

    # Scale the band colour by each pixel's luminance relative to the band's own, so a
    # bright grain stays bright and a shadow stays dark.
    scaled = band.reshape(1, 1, 3) * (luminance / band_luminance)[:, :, None]
    blended = rgb * (1.0 - strength) + scaled * strength

    out = np.array(image.convert("RGBA"))
    out[:, :, :3] = np.clip(blended * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def diamond_mask(width: int, height: int) -> np.ndarray:
    """A 2:1 diamond: |x/(w/2)| + |y/(h/2)| <= 1 about the centre."""
    ys, xs = np.mgrid[0:height, 0:width]
    nx = np.abs((xs + 0.5) - width / 2) / (width / 2)
    ny = np.abs((ys + 0.5) - height / 2) / (height / 2)
    return (nx + ny) <= 1.0


def make_tile(source: Image.Image, band: np.ndarray, strength: float) -> Image.Image:
    """Resize to the tile footprint, harmonise to the band, and mask to the diamond."""
    resized = source.convert("RGBA").resize((TILE_W, TILE_H), Image.Resampling.LANCZOS)
    toned = harmonise(resized, band, strength)

    pixels = np.array(toned)
    pixels[:, :, 3] = np.where(diamond_mask(TILE_W, TILE_H), 255, 0)
    return Image.fromarray(pixels, "RGBA")


def trim(image: Image.Image) -> tuple[Image.Image, int, int]:
    """
    Crop to the opaque bounding box, returning the offset that was removed.

    The offset matters: the renderer positions a sprite by its foot, so throwing away
    transparent margin without recording how much silently moves every unit.
    """
    bbox = image.getbbox()
    if bbox is None:
        return image, 0, 0
    left, top, _, _ = bbox
    return image.crop(bbox), left, top


def tileability(image: Image.Image) -> float:
    """
    Mean edge disagreement between opposite sides, 0 (seamless) to 1 (jarring).

    Reported rather than enforced. A number lets you reject the worst of a batch without
    pretending there is a threshold that means "good".
    """
    pixels = np.array(image.convert("RGB"), dtype=np.float64) / 255.0
    horizontal = np.abs(pixels[:, 0, :] - pixels[:, -1, :]).mean()
    vertical = np.abs(pixels[0, :, :] - pixels[-1, :, :]).mean()
    return float((horizontal + vertical) / 2)


def command_tile(args: argparse.Namespace) -> int:
    palette = load_palette(pathlib.Path(args.palette))
    source = pathlib.Path(args.input)
    target = pathlib.Path(args.output)
    target.mkdir(parents=True, exist_ok=True)

    manifest = []
    for path in sorted(source.glob("*.png")):
        # Which height band a tile belongs to is a naming decision, not something to
        # infer from its colours. Unprefixed files land in the middle of the ramp.
        band_index = args.band if args.band >= 0 else len(palette) // 2
        band = palette[min(band_index, len(palette) - 1)]

        with Image.open(path) as image:
            seam = tileability(image)
            tile = make_tile(image, band, args.strength)
        out = target / path.name
        tile.save(out)
        manifest.append(
            {
                "file": path.name,
                "width": TILE_W,
                "height": TILE_H,
                "band": band_index,
                "seam": round(seam, 4),
            }
        )
        print(f"  {path.name}: seam {seam:.3f}")

    (target / "manifest.json").write_text(json.dumps({"tiles": manifest}, indent=2) + "\n")
    print(f"[postprocess] {len(manifest)} tiles -> {target}")
    return 0


def command_sprite(args: argparse.Namespace) -> int:
    source = pathlib.Path(args.input)
    target = pathlib.Path(args.output)
    target.mkdir(parents=True, exist_ok=True)

    manifest = []
    for path in sorted(source.glob("*.png")):
        with Image.open(path) as image:
            cropped, offset_x, offset_y = trim(image.convert("RGBA"))
            width, height = cropped.size
            cropped.save(target / path.name)
        manifest.append(
            {
                "file": path.name,
                "width": width,
                "height": height,
                "offsetX": offset_x,
                "offsetY": offset_y,
            }
        )

    (target / "manifest.json").write_text(json.dumps({"sprites": manifest}, indent=2) + "\n")
    print(f"[postprocess] {len(manifest)} sprites -> {target}")
    return 0


def command_mirror(args: argparse.Namespace) -> int:
    """
    Fill in the mirrored directions of a 5-of-8 render.

    Directions 1..3 mirror to 7..5. Halves the render time and cuts the atlas by 37
    percent, which ARCHITECTURE section 9 identifies as one of the three things that
    make the unit-art budget survivable at all.
    """
    source = pathlib.Path(args.input)
    written = 0

    for path in sorted(source.glob("*_[123]_*.png")):
        stem = path.stem.split("_")
        direction = int(stem[-2])
        mirrored = (args.directions - direction) % args.directions
        stem[-2] = str(mirrored)
        out = path.with_name("_".join(stem) + path.suffix)
        if out.exists():
            continue

        with Image.open(path) as image:
            image.transpose(Image.Transpose.FLIP_LEFT_RIGHT).save(out)
        written += 1

    print(f"[postprocess] mirrored {written} frames")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    sub = parser.add_subparsers(dest="command", required=True)

    tile = sub.add_parser("tile", help="Generated image -> isometric terrain tile")
    tile.add_argument("--in", dest="input", required=True)
    tile.add_argument("--out", dest="output", required=True)
    tile.add_argument("--palette", default="tuning/presentation.json")
    tile.add_argument(
        "--band",
        type=int,
        default=-1,
        help="Height band to tone toward (0 lowest). Default is the middle of the ramp.",
    )
    tile.add_argument(
        "--strength",
        type=float,
        default=0.55,
        help="How far to pull colour toward the band. 0 keeps the generation as-is.",
    )
    tile.set_defaults(func=command_tile)

    sprite = sub.add_parser("sprite", help="Rendered frame -> trimmed sprite with offsets")
    sprite.add_argument("--in", dest="input", required=True)
    sprite.add_argument("--out", dest="output", required=True)
    sprite.set_defaults(func=command_sprite)

    mirror = sub.add_parser("mirror", help="Fill mirrored directions of a 5-of-8 render")
    mirror.add_argument("--in", dest="input", required=True)
    mirror.add_argument("--directions", type=int, default=8)
    mirror.set_defaults(func=command_mirror)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
