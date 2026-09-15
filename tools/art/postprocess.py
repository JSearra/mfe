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

    # Scale the band colour by each pixel's luminance relative to THIS TILE'S MEAN, so
    # the tile's average lands on the band colour and its grain varies around it.
    #
    # The divisor used to be the band's own luminance, which preserved each generation's
    # absolute brightness and so conformed hue without conforming level. One pale
    # riverbed came out at luminance 182 against its neighbour band's 97 — the right
    # green, twice as bright as anything it touched, and a ramp is as much about level as
    # hue. Dividing by the source's mean keeps the grain exactly as it was and moves only
    # where that grain is centred.
    mean_luminance = float(luminance.mean())
    if mean_luminance < 1e-6:
        mean_luminance = 1e-6
    scaled = band.reshape(1, 1, 3) * (luminance / mean_luminance)[:, :, None]
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


def edge_falloff(width: int, height: int, mask: int) -> np.ndarray:
    """
    Alpha for a transition tile: opaque against the edges in `mask`, fading inward.

    Terrain used to change ground with a hard diamond edge, and the renderer hid that by
    having each tile borrow a neighbour's band 38% of the time. Scattering two textures
    into each other does not read as one ground giving way to another; it reads as
    static. This is the blend the borrowing was standing in for — the neighbour's ground
    laid over this tile, opaque where they touch and gone by the far side, so the seam is
    a gradient rather than a line.

    Distance is measured in the diamond's own metric, |nx| + |ny|, so the falloff runs
    parallel to the edge it starts from rather than bulging at the corners. Where two
    edges are both in the mask their falloffs are taken at their maximum, which is what
    makes a corner read as a corner.
    """
    ys, xs = np.mgrid[0:height, 0:width]
    nx = ((xs + 0.5) - width / 2) / (width / 2)
    ny = ((ys + 0.5) - height / 2) / (height / 2)

    alpha = np.zeros((height, width), dtype=np.float64)
    for bit, (sx, sy) in enumerate(TRANSITION_EDGES):
        if not mask & (1 << bit):
            continue
        # 0 on the edge itself, rising to 2 at the opposite corner.
        inward = 1.0 - (sx * nx + sy * ny)
        near = np.clip(1.0 - inward / TRANSITION_REACH, 0.0, 1.0)
        # Smoothstep, so the blend has no visible start or end line.
        alpha = np.maximum(alpha, near * near * (3.0 - 2.0 * near))

    return alpha


def make_transition(tile: Image.Image, mask: int) -> Image.Image:
    """A tile masked to bleed in from the edges named by `mask`."""
    pixels = np.array(tile.convert("RGBA"))
    falloff = edge_falloff(tile.width, tile.height, mask)
    inside = diamond_mask(tile.width, tile.height)
    pixels[:, :, 3] = np.where(inside, np.clip(falloff * 255.0, 0, 255).astype(np.uint8), 0)
    return Image.fromarray(pixels, "RGBA")


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


# Which height band each subject belongs to, low ground to high. This is the "naming
# decision" the band lookup below refers to, and it has to live somewhere: a single
# --band flag applied to a whole directory meant every tile was toned to the middle of
# the ramp, so the whole set came out the same value and a donga floor read like a
# koppie. The ordering is an elevation gradient — river channel, erosion gully, dry
# plain, scrub, grass, sourveld, plateau rim, ironstone cap — and it is what makes the
# height ramp legible as terrain rather than as shading.
# Height band per subject, low ground first.
#
# This was scrambled, and the map showed it: donga-floor — an erosion gully, which is by
# definition low ground — sat at band 1 between the riverbed and the low savanna, while
# savanna-mid sat at 4 ABOVE thornveld and savanna-high at 5 above that. Read up the
# ramp, the ground went green, red, red, olive, green, olive, orange, brown. No amount of
# per-tile blending rescues an order like that, because the two grounds either side of
# any boundary have no reason to resemble each other.
#
# Now it climbs the way the country does: water at the bottom, grass drying as it rises,
# scrub, then soil and stone where nothing holds. savanna low/mid/high finally ascend in
# that order, which is what their names have claimed all along.
TERRAIN_BANDS = {
    "riverbed": 0,
    "savanna-low": 1,
    "savanna-mid": 2,
    "savanna-high": 3,
    "thornveld": 4,
    "donga-floor": 5,
    "sandstone": 6,
    "rock": 7,
}

# Which diamond edge each bit of a transition mask refers to, as the sign of (nx, ny) in
# normalised tile space. Clockwise from the upper right, matching the neighbour order the
# renderer uses: (x, y-1), (x+1, y), (x, y+1), (x-1, y).
#
# Isometric puts tile +x down-RIGHT and tile +y down-LEFT, which is why "north" in tile
# space is the upper-right edge on screen and not the top corner.
TRANSITION_EDGES = ((1, -1), (1, 1), (-1, 1), (-1, -1))

# How far across a tile a neighbour's ground bleeds. Most of the way: a narrow band reads
# as a drawn outline rather than as one ground giving way to another.
TRANSITION_REACH = 0.85

TILE_PAD = 2


def average_colour(tile: Image.Image) -> str:
    """Mean colour of a tile's opaque pixels, as #rrggbb.

    The cliff faces under a tile are flat shaded rather than textured, and they used to
    take their colour from the palette while the top took its colour from the art. That
    disagrees visibly wherever the two meet. Carrying the tile's own average through the
    manifest keeps a face matched to the surface it drops away from, and costs the
    renderer nothing at runtime.
    """
    pixels = np.asarray(tile.convert("RGBA")).astype(np.float64)
    opaque = pixels[..., 3] > 8
    if not opaque.any():
        return "#000000"
    mean = pixels[..., :3][opaque].mean(axis=0)
    return "#%02x%02x%02x" % tuple(int(round(c)) for c in mean)


def pack_tiles(tiles: list[tuple[str, Image.Image]], target: pathlib.Path) -> dict[str, tuple[int, int]]:
    """
    Lay every tile out on one page, in a fixed grid.

    One page because the renderer fills tile tops from it: a separate texture per
    subject would break the sprite batch every time the ground changed underfoot, and at
    a dozen visible chunks that is hundreds of draw calls against a budget of sixty.

    A grid rather than a packer, because every tile is exactly the same size and a
    packer would earn nothing. Padded, so linear sampling at a tile edge cannot reach
    into its neighbour.
    """
    columns = 8
    rows = (len(tiles) + columns - 1) // columns
    cell_w = TILE_W + TILE_PAD * 2
    cell_h = TILE_H + TILE_PAD * 2
    page = Image.new("RGBA", (columns * cell_w, rows * cell_h), (0, 0, 0, 0))

    placement = {}
    for index, (name, tile) in enumerate(tiles):
        x = (index % columns) * cell_w + TILE_PAD
        y = (index // columns) * cell_h + TILE_PAD
        page.paste(tile, (x, y))
        placement[name] = (x, y)

    page.save(target / "tiles.png")
    return placement


def command_tile(args: argparse.Namespace) -> int:
    palette = load_palette(pathlib.Path(args.palette))
    source = pathlib.Path(args.input)
    target = pathlib.Path(args.output)
    target.mkdir(parents=True, exist_ok=True)

    manifest = []
    packed: list[tuple[str, Image.Image]] = []
    for path in sorted(source.glob("*.png")):
        # Which height band a tile belongs to is a naming decision, not something to
        # infer from its colours, so it comes from the subject name. An explicit --band
        # still overrides. Unknown subjects land in the middle of the ramp.
        subject = path.stem.rsplit("_", 1)[0]
        band_index = (
            args.band if args.band >= 0 else TERRAIN_BANDS.get(subject, len(palette) // 2)
        )
        band = palette[min(band_index, len(palette) - 1)]

        with Image.open(path) as image:
            seam = tileability(image)
            tile = make_tile(image, band, args.strength)
        out = target / path.name
        tile.save(out)
        packed.append((path.name, tile))
        manifest.append(
            {
                "file": path.name,
                "subject": subject,
                "width": TILE_W,
                "height": TILE_H,
                "band": band_index,
                "averageColour": average_colour(tile),
                "seam": round(seam, 4),
            }
        )
        print(f"  {path.name}: seam {seam:.3f}")

    # --- transitions -------------------------------------------------------------
    #
    # One set per band, built from that band's first tile rather than from all of them.
    # Fifteen masks against every variant would be a few hundred tiles for variety the
    # player cannot see: a transition is a thin fringe along a seam, and its grain is
    # read as the neighbouring ground's, which the base tile under it already supplies.
    first_of_band: dict[int, tuple[str, Image.Image]] = {}
    for entry, (name, tile) in zip(manifest, packed):
        first_of_band.setdefault(entry["band"], (name, tile))

    for band_index in sorted(first_of_band):
        _, tile = first_of_band[band_index]
        for mask in range(1, 16):
            name = f"transition-{band_index}-{mask}.png"
            blended = make_transition(tile, mask)
            blended.save(target / name)
            packed.append((name, blended))
            manifest.append(
                {
                    "file": name,
                    "subject": "transition",
                    "width": TILE_W,
                    "height": TILE_H,
                    "band": band_index,
                    "mask": mask,
                    "averageColour": average_colour(blended),
                    "seam": 0.0,
                }
            )
    print(f"  {15 * len(first_of_band)} transition tiles over {len(first_of_band)} bands")

    placement = pack_tiles(packed, target)
    for entry in manifest:
        entry["x"], entry["y"] = placement[entry["file"]]

    (target / "manifest.json").write_text(
        json.dumps({"page": "tiles.png", "padding": TILE_PAD, "tiles": manifest}, indent=2) + "\n"
    )
    print(f"[postprocess] {len(manifest)} tiles -> {target}")
    return 0


# Frames that are drawn OVER a body rather than as one. Outlining these would paint a
# dark ring inside the figure, around a shield marking that has no business having an
# edge of its own.
OVERLAY_SUFFIXES = ("-team", "-shield")


def outline(image: Image.Image, colour: tuple[int, int, int] = (26, 20, 14)) -> Image.Image:
    """
    Draw a dark edge around everything opaque.

    This is the single largest thing that makes a small sprite read, and its absence is
    most of what "blobby" meant. A figure fifty pixels tall shares its value range with
    the ground it stands on, so without an outline the silhouette dissolves into the
    terrain and all that survives is a soft lump. Every hand-drawn sprite of this era has
    one for exactly this reason.

    Done by dilating the alpha by a pixel and filling the new ring, so it follows whatever
    shape the render produced and costs nothing in the model.
    """
    alpha = np.asarray(image.getchannel("A")).astype(np.uint16)
    grown = alpha.copy()
    for shift_y, shift_x in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        grown = np.maximum(grown, np.roll(np.roll(alpha, shift_y, axis=0), shift_x, axis=1))
    # Rolling wraps, so a figure touching an edge would smear onto the opposite one.
    if grown.shape[0] > 1:
        grown[0, :] = np.maximum(alpha[0, :], grown[0, :] * 0)
        grown[-1, :] = np.maximum(alpha[-1, :], grown[-1, :] * 0)
    if grown.shape[1] > 1:
        grown[:, 0] = np.maximum(alpha[:, 0], grown[:, 0] * 0)
        grown[:, -1] = np.maximum(alpha[:, -1], grown[:, -1] * 0)

    ring = (grown > 40) & (alpha <= 40)
    pixels = np.asarray(image).copy()
    pixels[ring, 0] = colour[0]
    pixels[ring, 1] = colour[1]
    pixels[ring, 2] = colour[2]
    pixels[ring, 3] = 255
    return Image.fromarray(pixels, "RGBA")


def command_sprite(args: argparse.Namespace) -> int:
    source = pathlib.Path(args.input)
    target = pathlib.Path(args.output)
    target.mkdir(parents=True, exist_ok=True)

    manifest = []
    packed: list[tuple[str, Image.Image]] = []
    for path in sorted(source.glob("*.png")):
        with Image.open(path) as image:
            source = image.convert("RGBA")
            subject = path.stem.rsplit("_", 3)[0]
            if not subject.endswith(OVERLAY_SUFFIXES):
                source = outline(source)
            cropped, offset_x, offset_y = trim(source)
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
