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


def _value_noise(shape: tuple[int, int], cells: tuple[int, int], seed: int) -> np.ndarray:
    """Bilinear value noise on a lattice of `cells` across the frame, smoothstepped."""
    rng = np.random.default_rng(seed)
    height, width = shape
    rows, cols = cells
    lattice = rng.random((rows + 1, cols + 1))

    ys = np.linspace(0, rows, height, endpoint=False)
    xs = np.linspace(0, cols, width, endpoint=False)
    y0 = np.floor(ys).astype(int)
    x0 = np.floor(xs).astype(int)
    fy = (ys - y0)[:, None]
    fx = (xs - x0)[None, :]
    # Smoothstepped interpolants, or the lattice shows as a grid of creases.
    fy = fy * fy * (3 - 2 * fy)
    fx = fx * fx * (3 - 2 * fx)

    v00 = lattice[np.ix_(y0, x0)]
    v10 = lattice[np.ix_(y0, x0 + 1)]
    v01 = lattice[np.ix_(y0 + 1, x0)]
    v11 = lattice[np.ix_(y0 + 1, x0 + 1)]
    top = v00 + (v10 - v00) * fx
    bottom = v01 + (v11 - v01) * fx
    return top + (bottom - top) * fy


def _fbm_normalised(
    shape: tuple[int, int],
    seed: int,
    octaves: int = 3,
    base: tuple[int, int] = (2, 4),
) -> np.ndarray:
    """
    `_fbm` rescaled to zero mean and unit standard deviation.

    Raw fbm is the mean of several uniform fields, so it clusters hard around 0.5 — its
    practical spread is about a tenth of its nominal 0..1 range. Scaling a perturbation
    by the raw value therefore does a fraction of what the number says: at a nominal
    roughness of 0.8 the blend front of a single-edge mask wandered 1.4px, measured,
    which is nothing on a 64px tile. Normalising makes the knob mean standard
    deviations, which is a quantity that can be reasoned about and calibrated.
    """
    noise = _fbm(shape, seed, octaves, base)
    spread = float(noise.std())
    return (noise - float(noise.mean())) / (spread if spread > 1e-9 else 1.0)


def _fbm(shape: tuple[int, int], seed: int, octaves: int = 3, base: tuple[int, int] = (2, 4)) -> np.ndarray:
    """
    Octaves of value noise, in 0..1.

    Three octaves rather than one, because the two scales do different jobs. The coarse
    octave makes the boundary MEANDER — a bay here, a headland there — and the fine ones
    make its edge RAGGED, which is the grain of grass ending rather than a line where it
    stops. One octave of either alone reads as a wobble or as static.
    """
    total = np.zeros(shape, dtype=np.float64)
    amplitude = 1.0
    norm = 0.0
    for octave in range(octaves):
        cells = (base[0] * 2**octave, base[1] * 2**octave)
        total += _value_noise(shape, cells, seed + octave * 977) * amplitude
        norm += amplitude
        amplitude *= 0.5
    return total / norm


def edge_falloff(width: int, height: int, mask: int, seed: int = 0) -> np.ndarray:
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

    # Seeded off the mask, so the four edges of a tile do not meander identically and
    # two different configurations never wear the same coastline.
    rough = _fbm_normalised((height, width), seed * 31 + mask * 7 + 1) * TRANSITION_ROUGHNESS

    alpha = np.zeros((height, width), dtype=np.float64)
    for bit, (sx, sy) in enumerate(TRANSITION_EDGES):
        if not mask & (1 << bit):
            continue
        # 0 on the edge itself, rising to 2 at the opposite corner.
        inward = 1.0 - (sx * nx + sy * ny)
        # Perturbed by how far in we already are, so the ROOT of the bleed stays solid
        # against the edge it comes from and only its leading edge wanders. Noise at the
        # root would open gaps along the seam, which is the one place the two grounds
        # must actually meet.
        depth = np.clip(inward / TRANSITION_REACH, 0.0, 1.0)
        near = np.clip(1.0 - (inward + rough * depth) / TRANSITION_REACH, 0.0, 1.0)
        # Smoothstep, so the blend has no visible start or end line.
        alpha = np.maximum(alpha, near * near * (3.0 - 2.0 * near))

    return dissolve(alpha, seed * 31 + mask * 7 + 4409)


def dissolve(alpha: np.ndarray, seed: int) -> np.ndarray:
    """
    Break the fading edge into grain, so the two grounds interleave rather than blend.

    Weighted by `alpha * (1 - alpha)`, which peaks halfway through the fade and is zero
    at both ends. That is the whole trick: the solid part of a mask stays solid and the
    empty part stays empty, so no amount of grain can punch a hole through the middle of
    a ground or leave specks floating in open country. Only the band that is already
    half-transparent — the part a viewer reads as the boundary — gets roughened.

    A FINE lattice — sixteen cells across the tile, halving to two-pixel detail — so the
    grain is the size of a tuft. The first attempt reused the same noise the boundary's
    meander uses, which starts at four cells across a 64px tile: sixteen-pixel blobs,
    which shift the edge about rather than break it up. Speckle has to be near the size
    of a pixel to read as speckle.
    """
    grain = _fbm_normalised(alpha.shape, seed, octaves=3, base=(8, 16))
    band = alpha * (1.0 - alpha) * 4.0
    return np.clip(alpha + grain * TRANSITION_DISSOLVE * band, 0.0, 1.0)


def front_wander(alpha: np.ndarray) -> float:
    """
    How far the blend's leading edge strays from a straight line, in pixels.
    
    Measured and recorded rather than trusted, because a flat blend front is exactly the
    class of art defect this project keeps shipping: it passes every type check, every
    test and every size budget, and it is only visible to somebody looking at the map.
    A regeneration with the roughness reset to zero would be silent without this.
    
    Taken as the standard deviation of where each row crosses half alpha, after taking
    out the straight-line trend — so a front that runs diagonally but straight scores
    near zero, and only genuine meander counts.
    """
    height, width = alpha.shape
    crossings = []
    for row in range(height):
        line = alpha[row]
        hit = np.where(line >= 0.5)[0]
        if hit.size == 0 or hit.size == width:
            continue
        crossings.append((row, float(hit.min() if line[0] < 0.5 else hit.max())))
    if len(crossings) < 4:
        return 0.0
    rows = np.array([c[0] for c in crossings], dtype=np.float64)
    cols = np.array([c[1] for c in crossings], dtype=np.float64)
    # Least squares line through the crossings; the residual is the wander.
    slope, intercept = np.polyfit(rows, cols, 1)
    return float(np.std(cols - (slope * rows + intercept)))


def make_field(tile: Image.Image, broken: bool) -> Image.Image:
    """
    A tile of ground turned over into furrows.

    Drawn from the terrain tile beneath it rather than generated on its own, so a field
    still looks like the ground it was broken out of — the soil of the Karoo is not the
    soil of the thornveld and a field that ignored that would read as a decal.

    Two states, because the player has to be able to tell them apart at a glance: broken
    ground, which is bare and dark and pays nothing yet, and a standing crop, which is
    greener and lighter than the veld around it. Condition is a tint applied at draw
    time; only these two shapes are baked.
    """
    pixels = np.array(tile.convert("RGBA"), dtype=np.float64)
    height, width = pixels.shape[0], pixels.shape[1]

    ys, xs = np.mgrid[0:height, 0:width]
    # Furrows run along the tile's own axis, so they read as ploughed rather than as
    # scanlines: in a 2:1 diamond that is two across for one down.
    ridge = np.sin((xs * 0.5 + ys) * (np.pi / 3.0))
    shade = 1.0 + ridge * (0.16 if broken else 0.10)

    if broken:
        # Turned earth: darker than the veld, and the colour of what is under it.
        pixels[:, :, 0] *= 0.82
        pixels[:, :, 1] *= 0.70
        pixels[:, :, 2] *= 0.58
    else:
        # A standing crop: greener and lighter than the ground it grows on.
        pixels[:, :, 0] *= 0.92
        pixels[:, :, 1] *= 1.16
        pixels[:, :, 2] *= 0.72

    for channel in range(3):
        pixels[:, :, channel] *= shade

    pixels[:, :, :3] = np.clip(pixels[:, :, :3], 0, 255)
    pixels[:, :, 3] = np.where(diamond_mask(width, height), 255, 0)
    return Image.fromarray(pixels.astype(np.uint8), "RGBA")


def make_transition(tile: Image.Image, mask: int, seed: int = 0) -> Image.Image:
    """A tile masked to bleed in from the edges named by `mask`."""
    pixels = np.array(tile.convert("RGBA"))
    falloff = edge_falloff(tile.width, tile.height, mask, seed)
    inside = diamond_mask(tile.width, tile.height)
    pixels[:, :, 3] = np.where(inside, np.clip(falloff * 255.0, 0, 255).astype(np.uint8), 0)
    return Image.fromarray(pixels, "RGBA")


def corner_falloff(width: int, height: int, corner: int, seed: int = 0) -> np.ndarray:
    """
    Alpha for a corner transition: opaque at one diamond POINT, gone a short way in.

    The edge blends cover the case where two grounds share a whole tile side. Ground that
    touches a tile only diagonally shares a single point, and until this existed it
    contributed nothing at all — so every diagonal boundary on the map ended in a sharp
    notch where the two edge blends beside it stopped.

    A wedge rather than a band, and much shorter than an edge's reach: a corner is a
    hint that the other ground is about to arrive, not the arrival. Distance is taken in
    the diamond's own metric, |dx| + |dy|, so the wedge's front runs parallel to the two
    edges it sits between instead of bulging into one of them.
    """
    ys, xs = np.mgrid[0:height, 0:width]
    nx = ((xs + 0.5) - width / 2) / (width / 2)
    ny = ((ys + 0.5) - height / 2) / (height / 2)

    point_x, point_y = TRANSITION_CORNERS[corner]
    distance = np.abs(nx - point_x) + np.abs(ny - point_y)
    # Perturbed like an edge's front, and weighted the same way, so the wedge's tip
    # stays anchored on the point it arrives at and only its far side wanders.
    rough = _fbm_normalised((height, width), seed * 31 + corner * 13 + 101) * TRANSITION_ROUGHNESS
    depth = np.clip(distance / CORNER_REACH, 0.0, 1.0)
    near = np.clip(1.0 - (distance + rough * depth) / CORNER_REACH, 0.0, 1.0)
    return dissolve(near * near * (3.0 - 2.0 * near), seed * 31 + corner * 13 + 7717)


def make_corner(tile: Image.Image, corner: int, seed: int = 0) -> Image.Image:
    """A tile masked to bleed in from one diamond point."""
    pixels = np.array(tile.convert("RGBA"))
    falloff = corner_falloff(tile.width, tile.height, corner, seed)
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

# How far across a tile a neighbour's ground bleeds, in the diamond's own metric, where
# 2.0 is the opposite corner.
#
# It was 0.85 — under half the tile — which left every boundary tile with an unblended
# core of its own ground, so the visible edge fell on the TILE GRID and read as a
# staircase of diamonds however soft the gradient across it was. That is the thing the
# blend exists to hide and it was never hiding it.
#
# The reference here is AoE2's blendomatic, whose masks cover enough of a tile that the
# MASK decides where the boundary runs rather than the grid. Swept at 0.85, 1.3 and 1.8
# against a composed boundary: 0.85 is a staircase, 1.8 floods nine tenths of the tile
# so the lower ground loses its territory and small patches of it vanish, and 1.3 is
# where the boundary meanders while both grounds keep their own.
TRANSITION_REACH = 1.3

# How far the blend's leading edge wanders, in standard deviations of the noise.
#
# Without it the mask is a dead-straight ramp running exactly parallel to the tile edge,
# identical on every tile, which the eye reads as a printed seam rather than as one
# ground giving way to another. Both games this was modelled on solve it the same way
# from opposite directions: AoE2's blendomatic carries nine blend MODES including
# "rough transition, used for dirt, grass" and "rough hard edges, spraylike", and
# Red Alert's LAT tiles are hand-drawn with irregular, dithered boundaries. Neither
# ever draws a straight one.
# Calibrated rather than guessed: the mean front wander of a single-edge mask, which is
# the case that tiles along a long boundary, runs 0.66px at 0.05 and 4.95px at 0.30.
# 0.35 puts it near 6px on a 64px tile — an eighth of a tile of meander. Swept against a
# composed boundary at 0.2, 0.35 and 0.5: 0.2 still shows the tile grid through it, 0.5
# frays the edge into noise, and 0.35 has bays and headlands that hold together.
TRANSITION_ROUGHNESS = 0.35

# How far the fading edge breaks up into grain.
#
# Taken from rubberduck's CC0 isometric ground sheets on OpenGameArt, which are the same
# 64x32 tile this project uses and so are directly comparable. Reading the alpha of one
# of their grass-to-nothing transitions across its fade gives
#
#     @@%%%%@###*+++==++--=:-::...
#
# which is not monotonic. Their edge does not ramp, it DISSOLVES: the alpha breaks into
# speckle so the two grounds interleave pixel by pixel instead of cross-fading. AoE2's
# blendomatic names a mode for the same thing — "rough hard edges, spraylike" — so two
# independent references land on it.
#
# Ours perturbed the POSITION of a smooth ramp, which meanders the boundary but leaves
# the gradient itself clean, and a clean gradient at this size reads as an airbrush.
# This is noise in the alpha itself.
TRANSITION_DISSOLVE = 0.55

# How many cuts of each boundary-tiling mask to bake.
#
# Four, which is what AoE2's blendomatic carries for each of its directional masks and
# selects between on "the lower 2 bits of tile destination x or y". One cut per
# configuration stamps the same meander tile after tile along a straight seam, and the
# result is a regular scalloped sawtooth: the repetition is as legible as the straight
# edge it replaced, only at a different frequency.
#
# Cut only for the masks that actually tile a boundary — the four single-edge ones and
# the four corner wedges. The multi-edge combinations happen at kinks in a boundary and
# are almost never adjacent to a copy of themselves, so cutting them would quadruple a
# third of the page to fix a repetition nobody can see.
BLEND_VARIANTS = 4
TILING_MASKS = (1, 2, 4, 8)

# The four diamond POINTS a diagonal neighbour arrives at, in (nx, ny): east, south,
# west, north. Corner i sits between edges i and (i + 1) % 4, which is the order
# seams.ts walks them in — changing one without the other puts the wedge on the wrong
# side of the tile.
TRANSITION_CORNERS = ((1, 0), (0, 1), (-1, 0), (0, -1))

# Shorter than an edge's reach, and deliberately. Ground that touches only at a point is
# barely arriving; a wedge as long as a full edge band would read as the whole tile
# changing ground because one diagonal neighbour did. Kept at the same proportion of
# TRANSITION_REACH it has always had, so the two were raised together.
CORNER_REACH = 0.85

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

    transition_count = 0
    for band_index in sorted(first_of_band):
        _, tile = first_of_band[band_index]
        for mask in range(1, 16):
            cuts = BLEND_VARIANTS if mask in TILING_MASKS else 1
            for variant in range(cuts):
                name = f"transition-{band_index}-{mask}-{variant}.png"
                seed = band_index * 101 + variant * 7919
                blended = make_transition(tile, mask, seed=seed)
                blended.save(target / name)
                packed.append((name, blended))
                manifest.append(
                    {
                        "file": name,
                        "subject": "transition",
                        "frontWander": round(
                            front_wander(edge_falloff(TILE_W, TILE_H, mask, seed)), 3
                        ),
                        "width": TILE_W,
                        "height": TILE_H,
                        "band": band_index,
                        "mask": mask,
                        "variant": variant,
                        "averageColour": average_colour(blended),
                        "seam": 0.0,
                    }
                )
                transition_count += 1
    print(f"  {transition_count} transition tiles over {len(first_of_band)} bands")

    # --- corners -----------------------------------------------------------------
    #
    # Four per band rather than a second set of mask combinations. Folding the diagonals
    # into the edge mask would take it from four bits to eight -- 255 masks a band, two
    # thousand tiles -- for a wedge that is the same shape however many of them a tile
    # has. They stack instead: a tile with two diagonal neighbours draws two.
    for band_index in sorted(first_of_band):
        _, tile = first_of_band[band_index]
        for corner in range(len(TRANSITION_CORNERS)):
            for variant in range(BLEND_VARIANTS):
                name = f"corner-{band_index}-{corner}-{variant}.png"
                wedge = make_corner(tile, corner, seed=band_index * 101 + variant * 7919)
                wedge.save(target / name)
                packed.append((name, wedge))
                manifest.append(
                    {
                        "file": name,
                        "subject": "corner",
                        "width": TILE_W,
                        "height": TILE_H,
                        "band": band_index,
                        "corner": corner,
                        "variant": variant,
                        "averageColour": average_colour(wedge),
                        "seam": 0.0,
                    }
                )
    print(f"  {len(TRANSITION_CORNERS) * BLEND_VARIANTS * len(first_of_band)} corner tiles")

    # --- shore -------------------------------------------------------------------
    #
    # Water is painted rather than textured -- at this scale a river reads as a colour
    # and a shape, and a riverbed texture would read as more dry ground -- so the whole
    # of a waterline's softness has to live on the LAND side of it. Without this a river
    # is a staircase of blue diamonds with a right angle at every step, which is the
    # most literal instance on the map of ground ending at ninety degrees.
    #
    # Cut from the riverbed tile rather than from each band's own ground, and one set
    # rather than eight: a bank is wet sand and pebbles whatever the hinterland behind
    # it is, and eight tinted variations of damp sand is eight ways of drawing the same
    # thing. Masked exactly like a band seam, so a shore and a contour are built by the
    # same arithmetic and cannot drift apart.
    shore_source = next(
        (tile for name, tile in packed if name.startswith("riverbed")),
        first_of_band[min(first_of_band)][1],
    )
    shore_count = 0
    for mask in range(1, 16):
        for variant in range(BLEND_VARIANTS if mask in TILING_MASKS else 1):
            name = f"shore-{mask}-{variant}.png"
            bank = make_transition(shore_source, mask, seed=97 + variant * 7919)
            bank.save(target / name)
            packed.append((name, bank))
            manifest.append(
                {
                    "file": name,
                    "subject": "shore",
                    "width": TILE_W,
                    "height": TILE_H,
                    "band": 0,
                    "mask": mask,
                    "variant": variant,
                    "averageColour": average_colour(bank),
                    "seam": 0.0,
                }
            )
            shore_count += 1
    for corner in range(len(TRANSITION_CORNERS)):
        for variant in range(BLEND_VARIANTS):
            name = f"shore-corner-{corner}-{variant}.png"
            bank = make_corner(shore_source, corner, seed=97 + variant * 7919)
            bank.save(target / name)
            packed.append((name, bank))
            manifest.append(
                {
                    "file": name,
                    "subject": "shore",
                    "width": TILE_W,
                    "height": TILE_H,
                    "band": 0,
                    "corner": corner,
                    "variant": variant,
                    "averageColour": average_colour(bank),
                    "seam": 0.0,
                }
            )
            shore_count += 1
    print(f"  {shore_count} shore tiles")

    # --- fields ------------------------------------------------------------------
    #
    # One pair per band, from the same representative tile, so a field looks like the
    # ground it was broken out of.
    for band_index in sorted(first_of_band):
        _, tile = first_of_band[band_index]
        for state, broken in (("broken", True), ("crop", False)):
            name = f"field-{band_index}-{state}.png"
            field = make_field(tile, broken)
            field.save(target / name)
            packed.append((name, field))
            manifest.append(
                {
                    "file": name,
                    "subject": "field",
                    "width": TILE_W,
                    "height": TILE_H,
                    "band": band_index,
                    "field": state,
                    "averageColour": average_colour(field),
                    "seam": 0.0,
                }
            )
    print(f"  {2 * len(first_of_band)} field tiles")

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
        # 0.8, measured rather than chosen by eye alone.
        #
        # The palette's job is to say which band a tile belongs to, and at 0.55 it was
        # not doing it: savanna-low's palette entry asks for a green at hue 87 and the
        # tile came out at hue 40, an orange-brown, across 15% of the map. Six of the
        # eight SUBJECTS describe orange-red ground, so at 0.55 -- where 45% of the
        # generation's own colour survives -- the map read as Karoo everywhere, which
        # generate_tiles.py's own prompt notes call the wrong half of the country.
        #
        # Mean hue error against the palette, swept over four values:
        #     0.55  12.0 deg   (savanna-low 46.6)
        #     0.70   8.5       (35.3)
        #     0.80   5.8       (24.6)
        #     0.90   3.1       (12.8)
        #
        # 0.9 scores better and looks worse. `harmonise` ramps ONE band colour by each
        # pixel's luminance, so as strength rises the tile loses its own hue variation
        # and keeps only its grain -- at 0.9 the grasslands go flat and monochrome. 0.8
        # is where the low bands become green and the donga and sandstone stay orange,
        # which is the distinction the ramp exists to draw.
        default=0.80,
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
