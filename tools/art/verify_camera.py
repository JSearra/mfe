"""
Prove the render camera matches the game's projection.

    blender -b -noaudio -P tools/art/verify_camera.py

Renders a unit ground square and measures it. The answer must be 2:1, because that is
the tile shape src/shared/iso.ts projects to; at 35.264 degrees — the angle most
tutorials give, and the one that is right for *true* isometric — it comes out 1.732:1
and every sprite sits subtly wrong on the grid forever.

This is cheap and the failure is invisible by eye, which is exactly when a check earns
its place.
"""

import importlib.util
import math
import pathlib
import sys

import bpy

HERE = pathlib.Path(__file__).resolve().parent
OUTPUT = "/tmp/mfe-camera-check.png"
TOLERANCE = 0.03  # antialiasing costs about a pixel on each edge at this size


def load_renderer():
    spec = importlib.util.spec_from_file_location("render_sprites", HERE / "render_sprites.py")
    module = importlib.util.module_from_spec(spec)
    # render_sprites parses argv at import only inside main(), but be explicit.
    sys.argv = ["blender", "--", "--out", "/tmp", "--name", "check"]
    spec.loader.exec_module(module)
    return module


def main() -> None:
    renderer = load_renderer()

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_plane_add(size=2.0, location=(0, 0, 0))
    renderer.setup_camera(256)
    renderer.setup_render(256)
    renderer.ensure_light()

    bpy.context.scene.render.filepath = OUTPUT
    bpy.ops.render.render(write_still=True)

    image = bpy.data.images.load(OUTPUT)
    width, height = image.size
    pixels = list(image.pixels)

    min_x, max_x, min_y, max_y = width, -1, height, -1
    for y in range(height):
        for x in range(width):
            if pixels[(y * width + x) * 4 + 3] > 0.03:
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)

    if max_x < 0:
        raise SystemExit("nothing rendered — the camera is not pointing at the plane")

    ratio = (max_x - min_x + 1) / (max_y - min_y + 1)
    print(f"[verify_camera] ground square renders {ratio:.3f} : 1 (want 2.000)")

    if abs(ratio - 2.0) > TOLERANCE * 2:
        raise SystemExit(
            f"camera angle is wrong: {ratio:.3f}:1, expected 2:1. "
            f"Elevation is {renderer.ELEVATION_DEGREES} degrees; 2:1 needs 30."
        )
    print("[verify_camera] OK")


if __name__ == "__main__":
    main()
