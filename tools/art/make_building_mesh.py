"""
A building from a real mesh, in its three stages of construction.

    blender -b -noaudio -P tools/art/make_building_mesh.py -- \\
        --kind umuzi --mesh raw/mesh/umuzi/mesh.obj --texture raw/mesh/umuzi/texture.png \\
        --render raw/mesh/umuzi/frames

The mesh route (tools/art/mesh_pipeline.py) for things that do not move. make_building.py
builds each stage by hand; here there is one mesh — the finished building, from a
generated reference — and the stages are cut from it: the groundwork (the mesh sliced a
little above the ground), half built (sliced at 45%), and complete. A site going up out
of its own footprint reads as construction, which is all a stage has to say.

The frames are named as make_building.py names them (`{kind}_build_0_{stage}`), with the
origin recorded the same way, so the renderer cannot tell which built them.
"""

import argparse
import json
import math
import os
import sys

import bmesh
import bpy
import mathutils

HERE = os.path.dirname(os.path.abspath(__file__))

# Real width in metres across the longest side, set against the primitive buildings so
# a building keeps the size on the map it already had.
WIDTHS = {
    "isibaya": 6.8,
    "umuzi": 4.6,
    "grain-store": 1.9,
    "ikhanda": 8.0,
    "indlunkulu": 4.0,
    "umgodi": 1.4,
    "isiziba": 3.0,
    "goat-fold": 3.2,
    "hunters-camp": 2.9,
    "well": 1.9,
}

# Buildings sit on the map at 29 px/m; rendered at 40 they keep their detail.
PIXELS_PER_METRE = 40.0
STAGES = (0.12, 0.45, None)


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True, choices=sorted(WIDTHS))
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--texture", default="")
    parser.add_argument("--render", required=True)
    parser.add_argument("--turn", type=float, default=0.0, help="Extra turn in degrees, to face the entrance")
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


def slice_at(obj: bpy.types.Object, height: float) -> None:
    """Cut away everything above `height`, leaving the building as far as it has got."""
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    bmesh.ops.bisect_plane(
        mesh,
        geom=mesh.verts[:] + mesh.edges[:] + mesh.faces[:],
        plane_co=(0, 0, height),
        plane_no=(0, 0, 1),
        clear_outer=True,
    )
    mesh.to_mesh(obj.data)
    mesh.free()


def main() -> None:
    args = parse_args()
    wild = load("make_wild_mesh")
    renderer = load("render_sprites")
    os.makedirs(args.render, exist_ok=True)
    origin = None

    for stage, cut in enumerate(STAGES):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        obj = wild.import_mesh(args.mesh, args.texture, "Z")
        points = wild.world_vertices(obj)
        # Upright is all a building needs; which way it faces is the reference's, turned
        # by --turn if the entrance should face the camera.
        span = max(max(p.x for p in points) - min(p.x for p in points), max(p.y for p in points) - min(p.y for p in points))
        scale = WIDTHS[args.kind] / span
        obj.scale = (scale, scale, scale)
        obj.rotation_euler.z = math.radians(args.turn)
        wild.apply_transform(obj)
        points = wild.world_vertices(obj)
        obj.location = (
            -(min(p.x for p in points) + max(p.x for p in points)) / 2,
            -(min(p.y for p in points) + max(p.y for p in points)) / 2,
            -min(p.z for p in points),
        )
        wild.apply_transform(obj)
        wild.decimate(obj)
        height = max(p.z for p in wild.world_vertices(obj))
        if cut is not None:
            slice_at(obj, height * cut)

        # Framed on the finished building at every stage, so the stages stand on the same
        # origin and a site does not jump as it grows.
        reach = WIDTHS[args.kind] * 0.75
        ortho = max(2.1 * reach, 2.2 * height) * 1.1
        size = int(round(ortho * PIXELS_PER_METRE / 8) * 8)
        ortho = size / PIXELS_PER_METRE
        renderer.setup_camera(size, scale=ortho, target=height * 0.4)
        renderer.setup_render(size)
        renderer.ensure_light()
        scene = bpy.context.scene
        bpy.context.view_layer.update()
        from bpy_extras.object_utils import world_to_camera_view

        at = world_to_camera_view(scene, scene.camera, mathutils.Vector((0.0, 0.0, 0.0)))
        origin = {"x": at.x * size, "y": (1.0 - at.y) * size, "pixelsPerUnit": size / ortho}
        scene.render.filepath = os.path.join(args.render, f"{args.kind}_build_0_{stage:02d}.png")
        bpy.ops.render.render(write_still=True)

    path = os.path.join(args.render, "origins.json")
    origins = json.load(open(path)) if os.path.exists(path) else {}
    origins[args.kind] = origin
    with open(path, "w") as handle:
        json.dump(origins, handle, indent=1)
    print(f"[make_building_mesh] {args.kind}: {len(STAGES)} stages")


if __name__ == "__main__":
    main()
