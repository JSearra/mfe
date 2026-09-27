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
# Saturation the baked texture is multiplied by. The image-to-3D bake greys paint out:
# the painted indlunkulu's reference had 27% of its pixels strongly saturated, the bake
# 7.5% (90th percentile 0.96 against 0.43). Ndebele painting is flat bright colour, so
# the painted buildings get it back in the shader; the file stays as the model wrote it.
SATURATION = {"indlunkulu": 2.0, "grain-store": 2.0, "isibaya": 2.0, "goat-fold": 2.0, "umgodi": 2.0, "well": 2.0}

# Share of the height under which the mesh is ground, not building.
SLAB = 0.06
# Wide, low structures whose reference was seen from above: the model comes back tipped
# on its edge, and is stood level on its thinnest axis before anything is measured.
LEVEL = {"isibaya", "isiziba", "goat-fold"}
# Buildings whose ground came back tilted, so the flat SLAB cut leaves a plank showing
# beyond the walls: the indlunkulu's rose to 14% of its height across the hut. Anything
# low outside the wall's own footprint is cut. Only for walls that do not flare at the
# foot; the umgodi's mound does, and would lose its skirt.
TRIM = {"indlunkulu"}
# Below this share of the height is the foot, measured against the wall above it.
FOOT = 0.16

# Buildings laid out from the meshes of others (see compose). The ikhanda is a ring of
# huts around a cattle enclosure; its huts are the indlunkulu, smaller.
# ``door`` turns the hut so its doorway faces the centre, measured on the reference.
COMPOSED = {
    "ikhanda": {
        "centre": {"kind": "isibaya", "width": 3.8},
        "ring": {"kind": "indlunkulu", "width": 1.5, "count": 11, "radius": 3.2, "door": 0.0},
    },
    # Three of the great hut, smaller, so the homestead and the hut agree in every
    # painted detail: a group asked for as one reference comes back as a flat dish.
    # The isibaya's painted wall at a goat's scale. Asked for as its own reference, a
    # small fold came back as a hood or a tunnel in four prompts running.
    "goat-fold": {
        "centre": {"kind": "isibaya", "width": 3.2},
    },
    "umuzi": {
        "ring": {"kind": "indlunkulu", "width": 2.0, "count": 3, "radius": 1.4, "door": 0.0},
    },
}


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


def level(obj: bpy.types.Object, wild) -> None:
    """Turn the mesh so the axis it is thinnest along is vertical: a ring of fence, seen
    from above in the reference, lies flat on the ground again."""
    import numpy

    points = numpy.array([tuple(p) for p in wild.world_vertices(obj)])
    points -= points.mean(axis=0)
    _, vectors = numpy.linalg.eigh(points.T @ points)
    up = mathutils.Vector(vectors[:, 0])
    if up.z < 0:
        up = -up
    obj.rotation_euler = up.rotation_difference(mathutils.Vector((0.0, 0.0, 1.0))).to_euler()
    wild.apply_transform(obj)


def flatten(obj: bpy.types.Object, wild) -> None:
    """Turn the ground plank level, by the faces that look up out of the foot."""
    points = [v.co for v in obj.data.vertices]
    low = min(p.z for p in points)
    top = max(p.z for p in points) - low
    up = mathutils.Vector()
    for face in obj.data.polygons:
        if face.center.z - low < FOOT * top and face.normal.z > 0.7:
            up += face.normal * face.area
    if up.length == 0:
        return
    obj.rotation_euler = up.normalized().rotation_difference(mathutils.Vector((0.0, 0.0, 1.0))).to_euler()
    wild.apply_transform(obj)


def trim_foot(obj: bpy.types.Object) -> None:
    """Cut what lies low and outside the wall: the ground plank the flat cut missed."""
    import bmesh

    top = max(v.co.z for v in obj.data.vertices)
    wall = [v.co for v in obj.data.vertices if FOOT * top <= v.co.z < 1.6 * FOOT * top]
    cx = sum(p.x for p in wall) / len(wall)
    cy = sum(p.y for p in wall) / len(wall)
    radii = sorted(math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2) for p in wall)
    reach = radii[int(len(radii) * 0.95)] * 1.05
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    doomed = [
        v for v in mesh.verts
        if v.co.z < FOOT * top and math.sqrt((v.co.x - cx) ** 2 + (v.co.y - cy) ** 2) > reach
    ]
    bmesh.ops.delete(mesh, geom=doomed, context="VERTS")
    mesh.to_mesh(obj.data)
    mesh.free()


def prepare(kind: str, mesh: str, texture: str, width: float, turn: float, wild) -> bpy.types.Object:
    """One mesh stood upright on the ground at the origin, ``width`` metres across."""
    obj = wild.import_mesh(mesh, texture, "Z", SATURATION.get(kind, 1.0))
    if kind in LEVEL:
        level(obj, wild)
    # The reference's ground comes back as a slab under the building, wider than the
    # building itself; it goes before the width is measured, or it sets the scale.
    if kind in TRIM:
        flatten(obj, wild)
    points = wild.world_vertices(obj)
    obj.location.z = -min(p.z for p in points)
    wild.apply_transform(obj)
    wild.drop_ground(obj, SLAB)
    if kind in TRIM:
        trim_foot(obj)
    points = wild.world_vertices(obj)
    # Upright is all a building needs; which way it faces is the reference's, turned
    # by --turn if the entrance should face the camera.
    span = max(max(p.x for p in points) - min(p.x for p in points), max(p.y for p in points) - min(p.y for p in points))
    scale = width / span
    obj.scale = (scale, scale, scale)
    obj.rotation_euler.z = math.radians(turn)
    wild.apply_transform(obj)
    points = wild.world_vertices(obj)
    obj.location = (
        -(min(p.x for p in points) + max(p.x for p in points)) / 2,
        -(min(p.y for p in points) + max(p.y for p in points)) / 2,
        -min(p.z for p in points),
    )
    wild.apply_transform(obj)
    return obj


def compose(kind: str, wild) -> bpy.types.Object:
    """
    A building too large for one reference, assembled from the meshes of smaller ones.
    Image-to-3D given a whole settlement seen from above returns a flat dish; given one
    hut it returns a hut, so the settlement is laid out here instead.
    """
    plan = COMPOSED[kind]
    parts = []
    if "centre" in plan:
        centre = plan["centre"]
        folder = os.path.join(HERE, "raw", "mesh", centre["kind"])
        parts.append(prepare(centre["kind"], os.path.join(folder, "mesh.obj"), os.path.join(folder, "texture.png"), centre["width"], 0.0, wild))

    if "ring" in plan:
        ring = plan["ring"]
        folder = os.path.join(HERE, "raw", "mesh", ring["kind"])
        hut = prepare(ring["kind"], os.path.join(folder, "mesh.obj"), os.path.join(folder, "texture.png"), ring["width"], 0.0, wild)
        wild.decimate(hut)
        # Every hut is copied from the one at the origin before any is placed, so none is
        # copied with another's placement already applied to it.
        copies = [hut] + [hut.copy() for _ in range(ring["count"] - 1)]
        for copy in copies[1:]:
            copy.data = hut.data.copy()
            bpy.context.scene.collection.objects.link(copy)
        for index, copy in enumerate(copies):
            angle = 2 * math.pi * index / ring["count"]
            # Every doorway turned to the parade ground in the middle.
            copy.rotation_euler.z = angle + math.radians(ring["door"])
            copy.location = (ring["radius"] * math.cos(angle), ring["radius"] * math.sin(angle), 0.0)
            wild.apply_transform(copy)
            parts.append(copy)

    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    return bpy.context.view_layer.objects.active


def main() -> None:
    args = parse_args()
    wild = load("make_wild_mesh")
    renderer = load("render_sprites")
    os.makedirs(args.render, exist_ok=True)
    origin = None

    for stage, cut in enumerate(STAGES):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        if args.kind in COMPOSED:
            obj = compose(args.kind, wild)
        else:
            obj = prepare(args.kind, args.mesh, args.texture, WIDTHS[args.kind], args.turn, wild)
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
