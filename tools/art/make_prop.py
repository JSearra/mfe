"""
Vegetation, rendered to sprites the same way everything else is.

    blender -b -noaudio -P tools/art/make_prop.py -- --kind acacia --render out/

Props are simpler than units in two ways and harder in one. They do not animate and they
do not turn, so each is a single frame — but there must be several of each, because a map
scattered with one identical tree reads as wallpaper. Each kind renders VARIANTS of
itself, differing in the parts a real one differs in: height, lean, canopy spread, and
how many stems it has.

The kinds are chosen for the region rather than for convenience, and each is picked for a
silhouette that survives being forty pixels tall. An umbrella thorn is the flat plate of
this landscape; an aloe is a rosette on a stalk and reads as nothing else; low scrub fills
the ground between them without competing.

The three big trees added with the foraging work are chosen the same way, and their
outlines are deliberately as unlike each other as the real ones are — at this size a tree
is its silhouette and nothing else. A marula is a dense round crown on a short clean bole.
A yellowwood is tall, narrow and dark, the forest tree of the kloofs and the one worth an
axe. A baobab is a swollen barrel under a crown of bare twigs, and is unmistakable at any
size; it is also the one nobody fells.
"""

import argparse
import json
import math
import os
import sys

import bpy
import mathutils

HERE = os.path.dirname(os.path.abspath(__file__))

KINDS = ("acacia", "aloe", "scrub", "marula", "yellowwood", "baobab")
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


def build_marula(variant):
    """
    Marula: a short clean bole under a dense, rounded crown.

    Read against the acacia beside it, which is the only comparison that matters here.
    Where the thorn is a flat plate on a thin fork, this is a ball on a stout trunk —
    heavier, rounder, and lower to the ground. The fruiting crown carries a warmer green,
    because the tree that feeds you should look different from the one that does not.
    """
    bark = material("bark", (0.155, 0.125, 0.092))
    # Warmer and yellower than the thorn beside it. The tree that feeds you has to be
    # tellable from the one that does not, at a glance, across a whole wood — and these
    # two greens were within a few points of each other on the first pass.
    leaf = material("leaf", (0.215, 0.255, 0.075))
    leaf_lit = material("leaf_lit", (0.315, 0.355, 0.115))

    root = bpy.data.objects.new("prop", None)
    bpy.context.scene.collection.objects.link(root)

    height = (2.4, 2.9, 2.0)[variant]
    spread = (2.2, 2.5, 1.9)[variant]
    lean = (0.0, -0.06, 0.05)[variant]

    # Stout and short. The bole is the half of the read that is not the crown.
    trunk = taper("trunk", 0.26, 0.15, height * 0.62, (0, 0, height * 0.31), (0, lean, 0))
    trunk.data.materials.append(bark)
    trunk.parent = root

    for i in range(3):
        angle = (i / 3) * math.tau
        limb = taper(
            "limb", 0.09, 0.05, height * 0.34,
            (math.cos(angle) * spread * 0.14, math.sin(angle) * spread * 0.14, height * 0.74),
            (math.radians(34) * math.cos(angle), math.radians(34) * math.sin(angle), 0),
        )
        limb.data.materials.append(bark)
        limb.parent = root

    crown = blob("crown", (spread, spread * 0.96, height * 0.66), (lean * height, 0, height * 0.92))
    crown.data.materials.append(leaf)
    crown.parent = root

    cap = blob("cap", (spread * 0.66, spread * 0.62, height * 0.34),
               (lean * height - spread * 0.10, -spread * 0.12, height * 1.12))
    cap.data.materials.append(leaf_lit)
    cap.parent = root
    return root


def build_yellowwood(variant):
    """
    Yellowwood: tall, narrow and dark — the forest tree, and the one worth felling.

    Everything else in this set is wider than it is high. This one is the reverse, which
    is the entire silhouette: a straight bole running most of the way up under a crown
    that is tall rather than spread. That is also why it is the timber tree, and the shape
    says so without a caption.
    """
    bark = material("bark", (0.125, 0.105, 0.085))
    # Darker and bluer than the bushveld greens. Afromontane forest against dry savanna.
    leaf = material("leaf", (0.085, 0.165, 0.095))
    leaf_lit = material("leaf_lit", (0.135, 0.225, 0.130))

    root = bpy.data.objects.new("prop", None)
    bpy.context.scene.collection.objects.link(root)

    height = (4.2, 5.0, 3.6)[variant]
    spread = (1.5, 1.7, 1.35)[variant]

    trunk = taper("trunk", 0.21, 0.12, height * 0.86, (0, 0, height * 0.43))
    trunk.data.materials.append(bark)
    trunk.parent = root

    # Three tiers rather than one mass: a tall crown needs internal edges or it reads as
    # a green pillar.
    for tier, (at, size) in enumerate(((0.62, 0.78), (0.80, 1.0), (0.95, 0.66))):
        mass = blob(
            "crown", (spread * size, spread * size * 0.94, height * 0.30 * size),
            (0, 0, height * at),
        )
        mass.data.materials.append(leaf_lit if tier == 1 else leaf)
        mass.parent = root
    return root


def build_baobab(variant):
    """
    Baobab: a swollen barrel under a crown of bare twigs.

    The one tree here that needs no comparison to be recognised, and the one nobody cuts
    down — its wood is fibrous and useless, and felling one was unthinkable. The trunk is
    most of the sprite on purpose: at forty pixels the crown is a smudge and the barrel is
    the whole identity.
    """
    # Grey-brown, not chalk. The first pass came out near-white under this light and
    # read as a standing stone rather than a tree — which at forty pixels is a worse
    # confusion than looking like the wrong tree.
    bark = material("bark", (0.205, 0.175, 0.138))
    twig = material("twig", (0.145, 0.125, 0.095))

    root = bpy.data.objects.new("prop", None)
    bpy.context.scene.collection.objects.link(root)

    height = (3.0, 3.6, 2.6)[variant]
    girth = (1.55, 1.85, 1.30)[variant]

    # Barrel, not cone: wide at the base, barely narrower at the top, and cut off flat.
    trunk = taper("trunk", girth * 0.56, girth * 0.40, height * 0.70, (0, 0, height * 0.35))
    trunk.data.materials.append(bark)
    trunk.parent = root

    swell = blob("swell", (girth * 1.08, girth * 1.0, height * 0.46), (0, 0, height * 0.26))
    swell.data.materials.append(bark)
    swell.parent = root

    # Bare branches, splayed and stubby. The "upside-down tree" of the stories.
    for i in range(6):
        angle = (i / 6) * math.tau
        branch = taper(
            "branch", 0.085, 0.03, height * 0.46,
            (math.cos(angle) * girth * 0.28, math.sin(angle) * girth * 0.28, height * 0.86),
            (math.radians(52) * math.cos(angle + math.pi / 2), math.radians(52) * math.sin(angle), 0),
        )
        branch.data.materials.append(twig)
        branch.parent = root
    return root


BUILDERS = {
    "acacia": build_acacia,
    "aloe": build_aloe,
    "scrub": build_scrub,
    "marula": build_marula,
    "yellowwood": build_yellowwood,
    "baobab": build_baobab,
}

# Framed per kind, and recorded, exactly as units are: the scale a prop is drawn at in
# game comes from its own pixels-per-unit, never from how tightly this happened to frame.
FRAMING = {
    "acacia": (5.2, 1.6),
    "aloe": (2.4, 0.8),
    "scrub": (2.6, 0.5),
    "marula": (5.0, 1.5),
    # Taller than it is wide, so it needs more vertical room than anything else here.
    "yellowwood": (6.6, 2.4),
    "baobab": (5.4, 1.7),
}


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
