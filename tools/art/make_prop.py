"""
Vegetation, rendered to sprites the same way everything else is.

    blender -b -noaudio -P tools/art/make_prop.py -- --kind acacia --render out/

Props are simpler than units in two ways and harder in one. They do not animate and they
do not turn, so each is a single frame — but there must be several of each, because a map
scattered with one identical tree reads as wallpaper. Each kind renders VARIANTS of
itself, differing in the parts a real one differs in: height, lean, canopy spread, and
how many stems it has.

The three are chosen for the region rather than for convenience. An umbrella thorn is the
silhouette of this landscape and its flat canopy is unmistakable even at forty pixels; an
aloe is a rosette on a stalk and reads as nothing else; low scrub fills the ground between
them without competing.
"""

import argparse
import json
import math
import os
import sys

import bpy
import mathutils

HERE = os.path.dirname(os.path.abspath(__file__))

KINDS = ("acacia", "aloe", "scrub")
VARIANTS = 3


def material(name, colour, roughness=0.9):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*colour, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Specular IOR Level"].default_value = 0.05
    return mat


def blob(name, size, location):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=14, ring_count=8, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    bpy.ops.object.shade_smooth()
    return obj


def taper(name, lower, upper, depth, location, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cone_add(
        vertices=10, radius1=lower, radius2=upper, depth=depth, location=location
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rotation
    bpy.ops.object.shade_smooth()
    return obj


def build_acacia(variant):
    """
    Umbrella thorn: a slim trunk that forks, under a canopy far wider than it is tall.

    The flatness is the whole read. A rounded canopy on a trunk is a generic tree from
    anywhere; the wide flat plate is this one, and it survives the downscale when almost
    no other detail does.
    """
    bark = material("bark", (0.13, 0.095, 0.062))
    # Lighter than the first pass. A dark canopy on this ground came out close enough in
    # value to the unexplored fog that a tree and a hole in the map read alike, which is
    # a bad thing for two things to have in common.
    leaf = material("leaf", (0.145, 0.225, 0.082))
    leaf_lit = material("leaf_lit", (0.215, 0.305, 0.115))

    root = bpy.data.objects.new("prop", None)
    bpy.context.scene.collection.objects.link(root)

    height = (2.6, 3.4, 2.1)[variant]
    spread = (2.9, 3.5, 2.4)[variant]
    lean = (0.0, 0.10, -0.07)[variant]

    trunk = taper("trunk", 0.17, 0.085, height, (0, 0, height / 2), (0, lean, 0))
    trunk.data.materials.append(bark)
    trunk.parent = root

    # The fork. Two limbs rising outward is what carries a canopy this wide.
    for side in (-1, 1):
        limb = taper(
            "limb", 0.07, 0.035, height * 0.55,
            (side * spread * 0.16, 0, height * 0.88), (0, side * 0.5, 0),
        )
        limb.data.materials.append(bark)
        limb.parent = root

    canopy = blob("canopy", (spread, spread * 0.92, height * 0.30), (lean * height, 0, height * 1.02))
    canopy.data.materials.append(leaf)
    canopy.parent = root

    # A second, smaller plate sitting proud on the sunlit side, so the canopy has a top
    # rather than being one flat colour.
    crown = blob("crown", (spread * 0.62, spread * 0.58, height * 0.20),
                 (lean * height - spread * 0.12, -spread * 0.10, height * 1.12))
    crown.data.materials.append(leaf_lit)
    crown.parent = root
    return root


def build_aloe(variant):
    """A rosette of thick leaves on a short stem, with a flower spike."""
    flesh = material("flesh", (0.105, 0.155, 0.088))
    stem = material("stem", (0.14, 0.10, 0.065))
    flower = material("flower", (0.52, 0.16, 0.045))

    root = bpy.data.objects.new("prop", None)
    bpy.context.scene.collection.objects.link(root)

    height = (0.85, 1.25, 0.6)[variant]
    leaves = (9, 11, 7)[variant]

    trunk = taper("stem", 0.14, 0.11, height, (0, 0, height / 2))
    trunk.data.materials.append(stem)
    trunk.parent = root

    for i in range(leaves):
        angle = (i / leaves) * math.tau
        # Shorter and fatter than the first attempt, and tilted less. Long thin leaves
        # splayed wide came out as a tangle of sticks rather than a rosette, and a
        # rosette is the only thing that makes an aloe read as an aloe.
        leaf = taper(
            "leaf", 0.115, 0.015, 0.52,
            (math.cos(angle) * 0.20, math.sin(angle) * 0.20, height + 0.14),
            (math.radians(42) * math.cos(angle + math.pi / 2), math.radians(42) * math.sin(angle), angle),
        )
        leaf.data.materials.append(flesh)
        leaf.parent = root

    if variant != 2:
        spike = taper("spike", 0.05, 0.02, 0.62, (0, 0, height + 0.62))
        spike.data.materials.append(flower)
        spike.parent = root
    return root


def build_scrub(variant):
    """Low thorn scrub: a rounded mass, sometimes two, with bare ground showing."""
    wood = material("wood", (0.115, 0.085, 0.055))
    leaf = material("leaf", (0.095, 0.135, 0.062))

    root = bpy.data.objects.new("prop", None)
    bpy.context.scene.collection.objects.link(root)

    size = (1.15, 1.5, 0.85)[variant]
    lumps = (2, 3, 1)[variant]

    for i in range(lumps):
        angle = (i / max(lumps, 1)) * math.tau
        offset = 0.0 if lumps == 1 else size * 0.24
        mass = blob(
            "mass",
            (size, size * 0.9, size * 0.66),
            (math.cos(angle) * offset, math.sin(angle) * offset, size * 0.30),
        )
        mass.data.materials.append(leaf)
        mass.parent = root

    stem = taper("stem", 0.05, 0.03, size * 0.4, (0, 0, size * 0.2))
    stem.data.materials.append(wood)
    stem.parent = root
    return root


BUILDERS = {"acacia": build_acacia, "aloe": build_aloe, "scrub": build_scrub}

# Framed per kind, and recorded, exactly as units are: the scale a prop is drawn at in
# game comes from its own pixels-per-unit, never from how tightly this happened to frame.
FRAMING = {"acacia": (5.2, 1.6), "aloe": (2.4, 0.8), "scrub": (2.6, 0.5)}


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", default="acacia", choices=KINDS)
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

    for variant in range(VARIANTS):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        BUILDERS[args.kind](variant)
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

        # One direction, no animation: the variant rides in the frame index, which is the
        # same trick the building stages use and needs no new atlas format.
        scene.render.filepath = os.path.join(args.render, f"{args.kind}_still_0_{variant:02d}.png")
        bpy.ops.render.render(write_still=True)

    origins_path = os.path.join(args.render, "origins.json")
    origins = {}
    if os.path.exists(origins_path):
        with open(origins_path) as handle:
            origins = json.load(handle)
    origins[args.kind] = origin
    with open(origins_path, "w") as handle:
        json.dump(origins, handle, indent=1)

    print(f"[make_prop] {args.kind}: {VARIANTS} variants")


if __name__ == "__main__":
    main()
