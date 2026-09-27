"""
A prop from a real mesh: three variants of something that stands still.

    blender -b -noaudio -P tools/art/make_prop_mesh.py -- \\
        --kind acacia --mesh raw/mesh/acacia/mesh.obj --texture raw/mesh/acacia/texture.png \\
        --render raw/mesh/acacia/frames

The mesh route (tools/art/mesh_pipeline.py) for trees, bushes and the livestock kept at
each dwelling. make_prop.py builds each variant by hand from primitives; here there is
one mesh, from a generated reference, and the variants are that mesh turned and sized
differently, so a wood is not one tree stamped out and a given tree keeps its shape.

The frames are named as make_prop.py names them (`{kind}_still_0_{variant}`), with the
origin recorded the same way, so the renderer cannot tell which built them.
"""

import argparse
import json
import math
import os
import sys

import bpy
import mathutils

HERE = os.path.dirname(os.path.abspath(__file__))

# Height in metres of the middle variant, set against the primitive props so a tree
# keeps the size on the map it already had, and the renderer's growth stages scale it.
HEIGHTS = {
    "acacia": 2.8,
    "marula": 2.5,
    "yellowwood": 4.3,
    "baobab": 3.1,
    "scrub": 0.8,
    "aloe": 1.3,
    "goat": 0.7,
    "chicken": 0.4,
}

# The three variants: how far each is turned, and how big against the middle one.
VARIANTS = ((0.0, 1.0), (125.0, 1.15), (240.0, 0.85))

# Buildings render at 40 px/m; the livestock is small enough to want more.
PIXELS_PER_METRE = {"goat": 56.0, "chicken": 56.0}
DEFAULT_PPM = 40.0

# Share of the height under which the mesh is the photograph's ground, not the subject.
SLAB = 0.03
# The foot of a tree: its trunk, found as the bottom of the mesh. The prop is stood on
# the middle of it, not on the middle of its bounding box, or a leaning crown would
# carry the tree off its own roots.
FOOT = 0.08


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True, choices=sorted(HEIGHTS))
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--texture", default="")
    parser.add_argument("--render", required=True)
    return parser.parse_args(argv)


def load(module: str):
    import importlib.util

    spec = importlib.util.spec_from_file_location(module, os.path.join(HERE, f"{module}.py"))
    loaded = importlib.util.module_from_spec(spec)
    saved = sys.argv
    sys.argv = ["blender", "--"]
    spec.loader.exec_module(loaded)
    sys.argv = saved
    return loaded


def prepare(args, wild, turn: float, size: float) -> bpy.types.Object:
    """The mesh on the ground, `size` times its kind's height, stood on its foot."""
    obj = wild.import_mesh(args.mesh, args.texture, "Z")
    wild.clean(obj)
    points = wild.world_vertices(obj)
    obj.location.z = -min(p.z for p in points)
    wild.apply_transform(obj)
    wild.drop_ground(obj, SLAB)

    points = wild.world_vertices(obj)
    scale = HEIGHTS[args.kind] * size / max(p.z for p in points)
    obj.scale = (scale, scale, scale)
    obj.rotation_euler.z = math.radians(turn)
    wild.apply_transform(obj)

    points = wild.world_vertices(obj)
    top = max(p.z for p in points)
    foot = [p for p in points if p.z < top * FOOT]
    obj.location = (
        -sum(p.x for p in foot) / len(foot),
        -sum(p.y for p in foot) / len(foot),
        -min(p.z for p in points),
    )
    wild.apply_transform(obj)
    return obj


def main() -> None:
    args = parse_args()
    wild = load("make_wild_mesh")
    renderer = load("render_sprites")
    os.makedirs(args.render, exist_ok=True)
    ppm = PIXELS_PER_METRE.get(args.kind, DEFAULT_PPM)

    # Framed once, on the largest variant, so all three share an origin and a scale.
    frames = []
    for turn, size in VARIANTS:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        obj = prepare(args, wild, turn, size)
        wild.decimate(obj)
        points = wild.world_vertices(obj)
        frames.append((max(math.sqrt(p.x * p.x + p.y * p.y) for p in points), max(p.z for p in points)))
    reach = max(r for r, _ in frames)
    height = max(h for _, h in frames)
    ortho = max(2.1 * reach, 2.2 * height) * 1.1
    size = int(round(ortho * ppm / 8) * 8)
    ortho = size / ppm

    origin = None
    for variant, (turn, scale) in enumerate(VARIANTS):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        obj = prepare(args, wild, turn, scale)
        wild.decimate(obj)
        renderer.setup_camera(size, scale=ortho, target=height * 0.4)
        renderer.setup_render(size)
        renderer.ensure_light()
        scene = bpy.context.scene
        bpy.context.view_layer.update()
        from bpy_extras.object_utils import world_to_camera_view

        at = world_to_camera_view(scene, scene.camera, mathutils.Vector((0.0, 0.0, 0.0)))
        origin = {"x": at.x * size, "y": (1.0 - at.y) * size, "pixelsPerUnit": size / ortho}
        scene.render.filepath = os.path.join(args.render, f"{args.kind}_still_0_{variant:02d}.png")
        bpy.ops.render.render(write_still=True)

    path = os.path.join(args.render, "origins.json")
    origins = json.load(open(path)) if os.path.exists(path) else {}
    origins[args.kind] = origin
    with open(path, "w") as handle:
        json.dump(origins, handle, indent=1)
    print(f"[make_prop_mesh] {args.kind}: {len(VARIANTS)} variants")


if __name__ == "__main__":
    main()
