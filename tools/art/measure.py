#!/usr/bin/env python3
"""
Measure the art instead of only looking at it.

    python tools/art/measure.py stripe                     # periodicity of raw sources
    python tools/art/measure.py bands                      # tone and contrast per ground band
    python tools/art/measure.py profile shot.png X Y DX DY # luminance along a line

WHY THIS EXISTS

docs and CLAUDE.md both say that looking at the output in a browser is the only thing
that has reliably caught this project's art defects. That is true and it is not the
whole truth: three defects were found by measuring screenshots and tile pages after
looking at them had either missed the defect or named the wrong cause.

  - A map-edge gradient rendered at flat full opacity with a hard cut at its inner
    edge. On screen it looked like a soft fade that was maybe still a bit crisp.
    Sampling across the boundary gave 17, 17, 17, then 129, and settled it in one line.
  - Open veld read as a quilt of hard-edged diamonds. The obvious suspect was tone, and
    tone was innocent — postprocess already tones every tile to its band palette, so the
    average colours were within a few units of each other. What differed was per-tile
    CONTRAST, 11.2 spread across the twelve cuts of a subject, and measuring that is
    what pointed at the crop size.
  - One grass tile was a ploughed field: regular parallel rows, tiling into corduroy
    across the veld. Row-periodicity put it at 1.16 against 0.14 to 0.65 for every other
    ground source in the set.

AND WHAT IT CANNOT DO. Seed 1504 scored better than any source that was kept and is
unusable — a mat of rosette plants split by branching orange channels. It has no
periodicity to find, and no number here knows what grassland is supposed to look like.
These measurements find the repeat, the jump and the flat; the eye finds everything
else. Neither is a substitute for the other, and neither is a gate.

No third-party imaging library, deliberately: the PNG reader below is thirty lines and
works in the system Python, so this runs without tools/art/.venv and without anything
being installed.
"""

import argparse
import collections
import json
import math
import os
import pathlib
import statistics
import struct
import sys
import zlib

TERRAIN = pathlib.Path("public/assets/terrain")
RAW = pathlib.Path("tools/art/raw")
# Subjects that are not a ground band in their own right.
DERIVED = ("transition", "corner", "shore", "field", "water")


class Png:
    """Enough of PNG to read 8-bit truecolour, which is all this pipeline emits."""

    def __init__(self, path: str | pathlib.Path) -> None:
        data = pathlib.Path(path).read_bytes()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError(f"{path} is not a PNG")
        pos, idat = 8, b""
        while pos < len(data):
            (length,) = struct.unpack(">I", data[pos : pos + 4])
            kind = data[pos + 4 : pos + 8]
            chunk = data[pos + 8 : pos + 8 + length]
            if kind == b"IHDR":
                self.w, self.h, depth, colour = struct.unpack(">IIBB", chunk[:10])
                if depth != 8 or chunk[12] != 0:
                    raise ValueError(f"{path}: only 8-bit non-interlaced is supported")
            elif kind == b"IDAT":
                idat += chunk
            elif kind == b"IEND":
                break
            pos += 12 + length
        self.channels = {0: 1, 2: 3, 4: 2, 6: 4}[colour]
        self.data = self._unfilter(zlib.decompress(idat))

    def _unfilter(self, raw: bytes) -> bytes:
        n = self.channels
        stride = self.w * n
        out = bytearray(self.h * stride)
        previous = bytearray(stride)
        pos = 0
        for y in range(self.h):
            kind = raw[pos]
            pos += 1
            line = bytearray(raw[pos : pos + stride])
            pos += stride
            if kind == 1:
                for i in range(n, stride):
                    line[i] = (line[i] + line[i - n]) & 0xFF
            elif kind == 2:
                for i in range(stride):
                    line[i] = (line[i] + previous[i]) & 0xFF
            elif kind == 3:
                for i in range(stride):
                    left = line[i - n] if i >= n else 0
                    line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
            elif kind == 4:
                for i in range(stride):
                    a = line[i - n] if i >= n else 0
                    b = previous[i]
                    c = previous[i - n] if i >= n else 0
                    pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                    line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 0xFF
            out[y * stride : (y + 1) * stride] = line
            previous = line
        return bytes(out)

    def rgb(self, x: int, y: int) -> tuple[int, int, int]:
        i = (y * self.w + x) * self.channels
        return self.data[i], self.data[i + 1], self.data[i + 2]

    def lum(self, x: int, y: int) -> float:
        r, g, b = self.rgb(x, y)
        return 0.299 * r + 0.587 * g + 0.114 * b


def periodicity(signal: list[float]) -> tuple[float, int]:
    """
    Strongest periodic component between 4 and 64 samples, as a multiple of the noise.

    Scaled by the signal's own deviation so a busy texture and a smooth one are on the
    same scale, and reported with its period, because the period says what the defect
    IS: a long one is clumping, which every natural ground has, and a short one is a
    weave the model has invented.
    """
    n = len(signal)
    mean = sum(signal) / n
    centred = [v - mean for v in signal]
    spread = statistics.pstdev(centred) or 1e-9
    best, best_period = 0.0, 0
    for period in range(4, 65):
        re = im = 0.0
        for i, v in enumerate(centred):
            angle = 2 * math.pi * i / period
            re += v * math.cos(angle)
            im += v * math.sin(angle)
        amplitude = 2 * math.sqrt(re * re + im * im) / n
        if amplitude > best:
            best, best_period = amplitude, period
    return best / spread, best_period


def cmd_stripe(args: argparse.Namespace) -> int:
    """Row and column periodicity of every raw source, to catch a ploughed field."""
    directory = pathlib.Path(args.directory)
    if not directory.is_dir():
        print(f"{directory} is not there — raw sources are gitignored, so generate first", file=sys.stderr)
        return 1

    print(f"{'source':30s} {'rows':>13s} {'cols':>13s}")
    worst = 0.0
    for name in sorted(p for p in os.listdir(directory) if p.endswith(".png")):
        image = Png(directory / name)
        rows = [
            sum(image.lum(x, y) for x in range(0, image.w, 2)) / (image.w // 2)
            for y in range(image.h)
        ]
        cols = [
            sum(image.lum(x, y) for y in range(0, image.h, 2)) / (image.h // 2)
            for x in range(image.w)
        ]
        row_score, row_period = periodicity(rows)
        col_score, col_period = periodicity(cols)
        worst = max(worst, row_score, col_score)
        flag = "  <-- look at this one" if max(row_score, col_score) > 0.9 else ""
        print(f"{name:30s}  {row_score:5.2f} @{row_period:3d}  {col_score:5.2f} @{col_period:3d}{flag}")

    # Not a threshold anything fails on. Ordinary sources sit between 0.14 and 0.7, which
    # is clumping rather than weave; the ploughed field that shipped was 1.16. A score
    # over about 0.9 means go and look, not that the image is wrong.
    print(f"\nworst {worst:.2f} (ordinary ground runs 0.14 to 0.7; the ploughed field was 1.16)")
    return 0


def cmd_bands(args: argparse.Namespace) -> int:
    """
    Tone against the palette, and contrast spread within each band.

    Two different questions, and confusing them wasted a pass. TONE is whether the tile
    matches the band colour it is supposed to be, and postprocess already gets that
    right, so it is nearly always innocent. CONTRAST SPREAD is how differently busy the
    cuts of one subject are, and that is the quilt: a uniformly dense tile against a
    uniformly bare one, meeting along a hard diamond edge.
    """
    manifest = json.loads((TERRAIN / "manifest.json").read_text())
    palette = json.loads(pathlib.Path("tuning/presentation.json").read_text())["terrain"]["palette"]
    page = Png(TERRAIN / manifest["page"])

    def parse(colour: str) -> tuple[int, int, int]:
        colour = colour.lstrip("#")
        return tuple(int(colour[i : i + 2], 16) for i in (0, 2, 4))

    def luminance(c: tuple[int, int, int]) -> float:
        return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]

    by_subject = collections.defaultdict(list)
    for tile in manifest["tiles"]:
        if tile["subject"] not in DERIVED:
            by_subject[(tile["band"], tile["subject"])].append(tile)

    def seed_of(tile: dict) -> str:
        # "sandstone_1301-2.png" -> "1301": which generation this cut came out of.
        return tile["file"].split("_")[-1].split("-")[0]

    print(f"{'band':24s} {'n':>3s} {'dTone':>6s} {'contrast':>9s} {'spread':>7s}  {'darkest':>7s}")
    odd = []
    for (band, subject), tiles in sorted(by_subject.items()):
        measured = {}
        for tile in tiles:
            values = sorted(
                page.lum(tile["x"] + x, tile["y"] + y)
                for y in range(tile["height"])
                for x in range(tile["width"])
            )
            measured[id(tile)] = (statistics.pstdev(values), values[len(values) // 50])

        contrasts = [measured[id(t)][0] for t in tiles]
        darkest = [measured[id(t)][1] for t in tiles]
        tone = sum(luminance(parse(t["averageColour"])) for t in tiles) / len(tiles)
        drift = tone - luminance(parse(palette[band]))
        spread = max(contrasts) - min(contrasts)
        print(
            f"{band} {subject:20s} {len(tiles):3d} {drift:+6.1f} "
            f"{statistics.mean(contrasts):9.1f} {spread:7.1f}  {statistics.mean(darkest):7.1f}"
        )

        """
        Which GENERATION the spread came out of, which is the actionable half.

        A subject's cuts all come from a handful of sources, and when one subject is
        uneven it is almost always one source disagreeing with its siblings rather than
        every cut differing a little. Sandstone seed 1301 came back with slabs at twice
        the scale of 1300 and 1302 — contrast 11 to 17 against 19 to 35 — so the ground
        changed grain size from one tile to the next. Naming the seed turns "this band
        is uneven" into "regenerate this one image".
        """
        per_seed = collections.defaultdict(list)
        for tile in tiles:
            per_seed[seed_of(tile)].append(measured[id(tile)][0])
        if len(per_seed) > 1:
            middles = {seed: statistics.mean(v) for seed, v in per_seed.items()}
            typical = statistics.median(middles.values())
            for seed, value in sorted(middles.items()):
                gap = abs(value - typical)
                mark = "  <-- out of step" if gap > 0.35 * max(typical, 1e-9) else ""
                if args.sources or mark:
                    print(f"      seed {seed}: contrast {value:5.1f}{mark}")
                if mark:
                    odd.append((subject, seed))

    print("\ndTone: tile against its palette entry. spread: how unevenly busy the cuts of")
    print("one subject are — this is the quilt, and it wants to be small.")
    if odd:
        print("\nout of step with their siblings, so worth looking at:")
        for subject, seed in odd:
            print(f"  {subject} {seed}")
    return 0


def cmd_profile(args: argparse.Namespace) -> int:
    """
    Luminance along a line across a screenshot.

    The cheapest thing in this file and the one that has earned the most. A fade that is
    working climbs; a fade that is not reads 17, 17, 17 and then 129, and no amount of
    squinting at the picture settles it as fast.
    """
    image = Png(args.image)
    length = math.hypot(args.dx, args.dy) or 1.0
    step_x, step_y = args.dx / length, args.dy / length

    values = []
    for step in range(args.steps):
        x = int(round(args.x + step_x * step * args.spacing))
        y = int(round(args.y + step_y * step * args.spacing))
        if 0 <= x < image.w and 0 <= y < image.h:
            values.append(round(image.lum(x, y)))
    print(values)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    stripe = sub.add_parser("stripe", help="periodicity of the raw generated sources")
    stripe.add_argument("directory", nargs="?", default=str(RAW))
    stripe.set_defaults(func=cmd_stripe)

    bands = sub.add_parser("bands", help="tone against palette and contrast spread per band")
    bands.add_argument("--sources", action="store_true", help="every seed, not only the odd ones")
    bands.set_defaults(func=cmd_bands)

    profile = sub.add_parser("profile", help="luminance along a line across a screenshot")
    profile.add_argument("image")
    profile.add_argument("x", type=int)
    profile.add_argument("y", type=int)
    profile.add_argument("dx", type=float, help="direction, not a destination")
    profile.add_argument("dy", type=float)
    profile.add_argument("--steps", type=int, default=40)
    profile.add_argument("--spacing", type=float, default=8.0, help="pixels between samples")
    profile.set_defaults(func=cmd_profile)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
