"""
Build the three structures procedurally and render them isometric.

    blender -b -noaudio -P tools/art/make_building.py -- --kind isibaya --render out/

Same reasoning as make_unit.py: procedural, so it costs no modelling skill and the same
invocation gives the same result, and consistent by construction across the set.

Buildings differ from units in two ways that matter. They do not turn, so one direction
is rendered rather than eight — an isibaya seen from the north-east is the only isibaya
anyone ever sees. And they are built, so each renders three times: a cleared footprint, a
half-raised frame, and the finished thing. Those ride the atlas as animation frames,
which needs no new format and no new code to load them.

The three are chosen for silhouette as much as for function. At forty pixels a player
must tell a cattle enclosure from a homestead from a granary at a glance, so they differ
in outline before they differ in detail: a wide low ring, a cluster of domes, a small
raised drum.
"""

import argparse
import json
import math
import os
import sys

import bpy
import mathutils

HERE = os.path.dirname(os.path.abspath(__file__))

# Metres. An isibaya holds a herd, so it is by far the largest thing on the map.
ISIBAYA_RADIUS = 3.4
HUT_RADIUS = 1.15
GRANARY_RADIUS = 0.85

KINDS = ("isibaya", "umuzi", "grain-store")
STAGES = 3


def material(name, colour, roughness=0.85):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*colour, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Specular IOR Level"].default_value = 0.1
    return mat


def cylinder(name, radius, depth, location, rotation=(0.0, 0.0, 0.0), verts=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rotation
    return obj


def dome(name, radius, height, location):
    """A hemisphere. The iQhugwane is a beehive frame, and the dome is its whole read."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=18, ring_count=10, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (radius, radius, height)
    bpy.ops.object.shade_smooth()
    return obj


def build_isibaya(root, stage, thatch, timber, earth):
    """
    The cattle enclosure: a ring of thorn fence around bare trodden earth.
    
    The centre is deliberately empty. It is where the herd stands, and a floor drawn
    with anything in it would fight the cattle sprites that belong there.
    """
    floor = cylinder("floor", ISIBAYA_RADIUS, 0.06, (0, 0, 0.03), verts=24)
    floor.data.materials.append(earth)
    floor.parent = root

    if stage == 0:
        return

    posts = 20 if stage == 2 else 11
    height = 1.05 if stage == 2 else 0.55
    for i in range(posts):
        angle = (i / posts) * math.tau
        post = cylinder(
            f"post_{i}",
            0.085,
            height,
            (math.cos(angle) * ISIBAYA_RADIUS, math.sin(angle) * ISIBAYA_RADIUS, height / 2),
            verts=6,
        )
        post.data.materials.append(timber)
        post.parent = root

    if stage < 2:
        return

    # The thorn brush packed between the posts, as a low torus. One piece rather than
    # per-gap geometry: at tile size it is a band, not branches.
    bpy.ops.mesh.primitive_torus_add(
        major_radius=ISIBAYA_RADIUS, minor_radius=0.30, major_segments=28, minor_segments=8,
        location=(0, 0, 0.72),
    )
    brush = bpy.context.active_object
    brush.name = "thorn"
    brush.data.materials.append(thatch)
    brush.parent = root


def build_umuzi(root, stage, thatch, timber, earth):
    """A homestead: beehive huts around a swept yard."""
    yard = cylinder("yard", 2.5, 0.06, (0, 0, 0.03), verts=20)
    yard.data.materials.append(earth)
    yard.parent = root

    huts = 1 if stage == 0 else 3 if stage == 1 else 5
    for i in range(huts):
        angle = (i / max(huts, 1)) * math.tau + 0.4
        x = math.cos(angle) * 1.55
        y = math.sin(angle) * 1.55
        if stage == 0:
            # A frame of bent saplings, not yet thatched.
            for rib in range(5):
                tilt = (rib / 5) * math.pi
                arc = cylinder(
                    f"rib_{i}_{rib}", 0.03, HUT_RADIUS * 1.7, (x, y, HUT_RADIUS * 0.5),
                    rotation=(math.pi / 2, 0, tilt), verts=6,
                )
                arc.data.materials.append(timber)
                arc.parent = root
            continue

        hut = dome(f"hut_{i}", HUT_RADIUS, HUT_RADIUS * 0.85, (x, y, 0.02))
        hut.data.materials.append(thatch)
        hut.parent = root


def build_grain_store(root, stage, thatch, timber, earth):
    """
    A raised granary: a thatched basket standing clear of the ground on legs.

    Raised because that is what keeps grain away from damp and vermin, and because the
    gap under it is the silhouette — without the legs it is just a small hut.
    """
    for i in range(4):
        angle = (i / 4) * math.tau + 0.7
        leg = cylinder(
            f"leg_{i}", 0.075, 0.75,
            (math.cos(angle) * GRANARY_RADIUS * 0.62, math.sin(angle) * GRANARY_RADIUS * 0.62, 0.375),
            verts=6,
        )
        leg.data.materials.append(timber)
        leg.parent = root

    if stage == 0:
        return

    platform = cylinder("platform", GRANARY_RADIUS * 0.95, 0.10, (0, 0, 0.80), verts=16)
    platform.data.materials.append(timber)
    platform.parent = root

    if stage == 1:
        return

    basket = cylinder("basket", GRANARY_RADIUS, 0.85, (0, 0, 1.27), verts=16)
    basket.data.materials.append(thatch)
    basket.parent = root

    cap = dome("cap", GRANARY_RADIUS * 1.06, 0.45, (0, 0, 1.68))
    cap.data.materials.append(thatch)
    cap.parent = root


BUILDERS = {
    "isibaya": build_isibaya,
    "umuzi": build_umuzi,
    "grain-store": build_grain_store,
}

FRAMING = {
    # kind: (ortho scale, camera target height)
    "isibaya": (8.4, 0.9),
    "umuzi": (6.6, 0.9),
    "grain-store": (3.4, 1.0),
}


def build(kind, stage):
    # These are LINEAR, and the render is sRGB-encoded on the way out. That transfer is
    # steep at the bottom: a linear 0.34 leaves as roughly 158, so a value that reads on
    # paper as dark brown renders as pale grey-beige. The first two passes here were
    # 0.58 and 0.34 and both came out looking like unpainted plaster; halving the number
    # barely moved the picture, which is the tell that the mapping is not linear.
    #
    # Sanity-checked rather than reasoned about, by rendering a pure red and measuring
    # it: 0.8 linear came back at 185, which is the sRGB curve and not a lighting
    # problem. These sit in the same range as the unit skin, which has looked right
    # since it was set the same way.
    thatch = material("thatch", (0.20, 0.13, 0.05))
    timber = material("timber", (0.085, 0.052, 0.028))
    earth = material("earth", (0.125, 0.088, 0.052))

    root = bpy.data.objects.new("building", None)
    bpy.context.scene.collection.objects.link(root)
    BUILDERS[kind](root, stage, thatch, timber, earth)
    return root


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", default="isibaya", choices=KINDS)
    parser.add_argument("--render", required=True)
    parser.add_argument("--size", type=int, default=192)
    args = parser.parse_args(argv)

    os.makedirs(args.render, exist_ok=True)

    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "render_sprites", os.path.join(HERE, "render_sprites.py")
    )
    renderer = importlib.util.module_from_spec(spec)
    sys.argv = ["blender", "--"]
    spec.loader.exec_module(renderer)

    ortho, target = FRAMING[args.kind]
    origin = None

    for stage in range(STAGES):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        build(args.kind, stage)
        renderer.setup_camera(args.size, scale=ortho, target=target)
        renderer.setup_render(args.size)
        renderer.ensure_light()

        scene = bpy.context.scene
        bpy.context.view_layer.update()
        from bpy_extras.object_utils import world_to_camera_view

        normalised = world_to_camera_view(scene, scene.camera, mathutils.Vector((0.0, 0.0, 0.0)))
        origin = {
            "x": normalised.x * args.size,
            "y": (1.0 - normalised.y) * args.size,
            "pixelsPerUnit": args.size / ortho,
        }

        # One direction. A building does not turn, so `_0_` is the only direction there
        # will ever be, and the stage rides in the frame index.
        scene.render.filepath = os.path.join(args.render, f"{args.kind}_build_0_{stage:02d}.png")
        bpy.ops.render.render(write_still=True)

    origins_path = os.path.join(args.render, "origins.json")
    origins = {}
    if os.path.exists(origins_path):
        with open(origins_path) as handle:
            origins = json.load(handle)
    origins[args.kind] = origin
    with open(origins_path, "w") as handle:
        json.dump(origins, handle, indent=1)

    print(f"[make_building] {args.kind}: {STAGES} stages")


if __name__ == "__main__":
    main()
