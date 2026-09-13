"""
Build a placeholder unit figure procedurally, and animate it.

    blender -b -noaudio -P tools/art/make_unit.py -- --kind impi --save out.blend
    blender -b -noaudio -P tools/art/make_unit.py -- --kind impi --render tools/art/raw/units

The pipeline had no input. Blender renders whatever model you give it, and this project
had none — so the render script was verified against the default cube and produced
nothing usable. This produces the models.

Procedural rather than modelled or bought, for three reasons. It needs no modelling
skill and no purchase. It is reproducible: the same invocation gives byte-identical
output, so a sprite sheet can be regenerated rather than archived. And it is *consistent
by construction* — the thing that makes image generation unusable for units is that a
hundred and twenty frames come back as a hundred and twenty different men, and a script
cannot do that.

It is placeholder art and looks it. But it is placeholder art with real silhouettes,
real facing, and a real walk cycle, which is enough to answer Gate 2 — whether a herd
and a battle line stay legible as overlapping isometric sprites — without commissioning
anything first.

No armature. Limbs are parented objects with keyframed rotations, which is a fraction of
the code of a rig and indistinguishable at 128 pixels.
"""

import argparse
import json
import math
import os
import sys

import bpy
import mathutils

# Rough human proportions in Blender units, where 1.0 is about a metre.
HEIGHT = 1.75
HEAD = 0.22
TORSO = 0.62
LIMB = 0.52

BIPEDS = {
    # name:        (skin,                  cloth,               shield,  has_spear)
    "impi": ((0.38, 0.24, 0.16), (0.52, 0.44, 0.30), True, True),
    "herder": ((0.38, 0.24, 0.16), (0.62, 0.56, 0.40), False, True),
    "musketeer": ((0.42, 0.30, 0.22), (0.34, 0.32, 0.28), False, True),
}

# Nguni cattle, not generic cattle, and the difference is the point of the game. These
# are Sanga-type: smaller than a European breed, lateral lyre-shaped horns, a modest
# cervico-thoracic hump, and famously patched hides — the pattern vocabulary is dense
# enough that isiZulu names dozens of them. A Holstein silhouette would be an
# anachronism standing in the middle of the headline mechanic. See docs/CONTENT.md.
# Hide colour is a legibility decision before it is an aesthetic one. The first pass
# used a mid red-brown, which is very close to the ochre of every ground tile in the
# set: a herd of forty vanished into the veld and all that read was the white patches,
# floating. These are darker and more saturated so the animal separates from the dust.
# Both are real Nguni colourings — red-and-white and black-and-white are classic — so
# the fix costs nothing historically.
CATTLE = {
    # name:      (hide,                  patch)
    "nguni": ((0.26, 0.10, 0.06), (0.90, 0.87, 0.82)),
    "nguni-dark": ((0.10, 0.09, 0.10), (0.86, 0.83, 0.78)),
}

KINDS = {**BIPEDS, **CATTLE}

# Cattle proportions, metres. A cow is longer than a man is tall and half his height at
# the withers, which is why it needs its own camera framing.
COW_LENGTH = 1.42
COW_DEPTH = 0.60
COW_WIDTH = 0.46
COW_LEG = 0.62

# "run" is the stampede. It exists for cattle first, but an impi that can only walk
# looks wrong next to one, so bipeds get it too.
ANIMATIONS = {"idle": 8, "walk": 12, "attack": 10, "run": 10}

# Which animations make sense for which kind. A cow does not thrust a spear.
KIND_ANIMATIONS = {name: ("idle", "walk", "attack", "run") for name in BIPEDS} | {
    name: ("idle", "walk", "run") for name in CATTLE
}


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="Build a placeholder unit")
    parser.add_argument("--kind", default="impi", choices=sorted(KINDS))
    parser.add_argument("--anim", default="walk", choices=sorted(ANIMATIONS))
    parser.add_argument("--all", action="store_true", help="Every animation for this kind")
    parser.add_argument("--save", default="", help="Write a .blend here")
    parser.add_argument("--render", default="", help="Render sprites into this directory")
    parser.add_argument("--size", type=int, default=128)
    parser.add_argument("--mirror", action="store_true")
    return parser.parse_args(argv)


def material(name: str, colour: tuple[float, float, float]) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*colour, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.85
    # Flat-ish shading reads better than gloss once a figure is 40 pixels tall.
    bsdf.inputs["Specular IOR Level"].default_value = 0.1
    return mat


def box(name: str, size: tuple[float, float, float], location: tuple[float, float, float]):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    return obj


def cylinder(name, radius, depth, location, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rotation
    return obj


def build_cattle(kind: str):
    """An Nguni beast standing on the origin, facing +X."""
    hide_colour, patch_colour = CATTLE[kind]
    hide = material("hide", hide_colour)
    patch = material("patch", patch_colour)
    horn = material("horn", (0.82, 0.78, 0.68))

    root = bpy.data.objects.new("cattle", None)
    bpy.context.scene.collection.objects.link(root)

    back = COW_LEG + COW_DEPTH / 2

    body = box("body", (COW_LENGTH, COW_WIDTH, COW_DEPTH), (0, 0, back))
    body.data.materials.append(hide)
    body.parent = root

    # The hump. Small and over the shoulder, which is what makes the silhouette Sanga
    # rather than taurine — it is most of the read at 40 pixels.
    hump = box("hump", (0.34, 0.30, 0.20), (COW_LENGTH * 0.24, 0, back + COW_DEPTH / 2))
    hump.data.materials.append(hide)
    hump.parent = root

    # Patches, sitting just proud of the body so they z-fight with nothing. The first
    # pass made them big flat rectangles spanning the full width, which read as cargo
    # labels stuck to a crate rather than as markings. Smaller, at different heights,
    # and not the same on both flanks.
    for index, (px, pz, size) in enumerate(
        (
            (-0.30, -0.10, (0.30, COW_WIDTH + 0.02, 0.22)),
            (0.16, 0.12, (0.20, COW_WIDTH + 0.02, 0.18)),
            (-0.02, -0.16, (0.16, COW_WIDTH + 0.02, 0.14)),
        )
    ):
        spot = box(f"patch_{index}", size, (px, 0, back + pz))
        spot.data.materials.append(patch)
        spot.parent = root

    # The underside and lower legs go pale, which is both common in the breed and the
    # cheapest way to stop the animal reading as one solid lump at tile size.
    belly = box("belly", (COW_LENGTH * 0.8, COW_WIDTH + 0.015, 0.14), (0, 0, back - COW_DEPTH / 2 + 0.05))
    belly.data.materials.append(patch)
    belly.parent = root

    # Neck and head, angled up and forward from the shoulder.
    neck_pivot = bpy.data.objects.new("neck", None)
    bpy.context.scene.collection.objects.link(neck_pivot)
    neck_pivot.location = (COW_LENGTH * 0.42, 0, back + COW_DEPTH * 0.22)
    neck_pivot.parent = root

    neck = box("neck_mesh", (0.34, 0.26, 0.26), (0.14, 0, 0.06))
    neck.data.materials.append(hide)
    neck.parent = neck_pivot

    head = box("head", (0.36, 0.20, 0.22), (0.40, 0, 0.10))
    head.data.materials.append(hide)
    head.parent = neck_pivot

    # Lyre horns: out to the side, then up. Two segments each, because a single angled
    # cylinder reads as a spike and the lateral sweep is the recognisable part.
    for side, y in (("l", 1.0), ("r", -1.0)):
        base = cylinder(
            f"horn_base_{side}",
            0.022,
            0.30,
            (0.36, y * 0.16, 0.22),
            (math.radians(90 * y * -1), 0, 0),
        )
        base.data.materials.append(horn)
        base.parent = neck_pivot

        tip = cylinder(
            f"horn_tip_{side}",
            0.016,
            0.22,
            (0.36, y * 0.28, 0.32),
            (math.radians(-38 * y), 0, 0),
        )
        tip.data.materials.append(horn)
        tip.parent = neck_pivot

    # Tail, hanging from the rump with a dark switch on the end.
    tail_pivot = bpy.data.objects.new("tail", None)
    bpy.context.scene.collection.objects.link(tail_pivot)
    tail_pivot.location = (-COW_LENGTH / 2, 0, back + COW_DEPTH * 0.3)
    tail_pivot.parent = root

    tail = cylinder("tail_mesh", 0.018, 0.52, (0, 0, -0.26))
    tail.data.materials.append(hide)
    tail.parent = tail_pivot

    switch = box("switch", (0.06, 0.06, 0.12), (0, 0, -0.52))
    switch.data.materials.append(patch)
    switch.parent = tail_pivot

    limbs = {"neck": neck_pivot, "tail": tail_pivot}
    for pair, x in (("fore", COW_LENGTH * 0.34), ("hind", -COW_LENGTH * 0.34)):
        for side, y in (("l", COW_WIDTH * 0.36), ("r", -COW_WIDTH * 0.36)):
            pivot = bpy.data.objects.new(f"{pair}_{side}", None)
            bpy.context.scene.collection.objects.link(pivot)
            pivot.location = (x, y, COW_LEG)
            pivot.parent = root

            leg = box(f"leg_{pair}_{side}", (0.10, 0.10, COW_LEG), (0, 0, -COW_LEG / 2))
            leg.data.materials.append(hide)
            leg.parent = pivot

            hoof = box(f"hoof_{pair}_{side}", (0.12, 0.12, 0.08), (0, 0, -COW_LEG + 0.04))
            hoof.data.materials.append(patch)
            hoof.parent = pivot

            limbs[f"{pair}_{side}"] = pivot

    return root, limbs


def animate_quadruped(limbs: dict, anim: str, frames: int) -> None:
    """Keyframe a cattle cycle.

    The gait is diagonal — near fore with off hind — which is what a walking cow
    actually does and what stops four legs swinging like a pantomime horse.
    """
    scene = bpy.context.scene
    for frame in range(1, frames + 1):
        phase = (frame - 1) / frames * math.tau
        scene.frame_set(frame)

        if anim == "idle":
            # Grazing: head down, weight shifting, tail working at the flies.
            limbs["neck"].rotation_euler = (0, math.radians(52), 0)
            limbs["tail"].rotation_euler = (math.radians(16) * math.sin(phase * 2), 0, 0)
            for leg in ("fore_l", "fore_r", "hind_l", "hind_r"):
                limbs[leg].rotation_euler = (math.radians(1.5) * math.sin(phase), 0, 0)
        else:
            fast = anim == "run"
            swing = math.radians(30 if fast else 18) * math.sin(phase)
            offset = math.radians(30 if fast else 18) * math.sin(phase + math.pi)
            # Diagonal pairs move together.
            limbs["fore_l"].rotation_euler = (swing, 0, 0)
            limbs["hind_r"].rotation_euler = (swing, 0, 0)
            limbs["fore_r"].rotation_euler = (offset, 0, 0)
            limbs["hind_l"].rotation_euler = (offset, 0, 0)
            # Head carried low and thrust forward at the run; that plus the horns is
            # what has to read as "stampede" from the top of the screen.
            limbs["neck"].rotation_euler = (
                0,
                math.radians(24 if fast else 8) + math.radians(5) * math.sin(phase * 2),
                0,
            )
            limbs["tail"].rotation_euler = (math.radians(-48 if fast else -6), 0, 0)

        for pivot in limbs.values():
            pivot.keyframe_insert("rotation_euler", frame=frame)


def build(kind: str):
    """A figure standing on the origin, facing +X."""
    if kind in CATTLE:
        return build_cattle(kind)
    skin_colour, cloth_colour, has_shield, has_spear = BIPEDS[kind]
    skin = material("skin", skin_colour)
    cloth = material("cloth", cloth_colour)
    # Player colour lives on its own material so a shader swap can find it later —
    # ARCHITECTURE section 9 wants player colour swapped, not pre-tinted per faction.
    player = material("player_colour", (0.85, 0.55, 0.28))

    root = bpy.data.objects.new("unit", None)
    bpy.context.scene.collection.objects.link(root)

    hip_height = LIMB
    torso = box("torso", (0.30, 0.20, TORSO), (0, 0, hip_height + TORSO / 2))
    torso.data.materials.append(cloth)
    torso.parent = root

    head = box("head", (HEAD, HEAD, HEAD), (0, 0, hip_height + TORSO + HEAD / 2))
    head.data.materials.append(skin)
    head.parent = root

    limbs = {}
    for side, y in (("l", 0.13), ("r", -0.13)):
        # Limbs are modelled hanging DOWN from their joint and offset so the joint sits
        # at the object origin; rotating the object then swings the limb about the hip
        # or shoulder, which is the whole trick that avoids needing an armature.
        leg = box(f"leg_{side}", (0.11, 0.11, LIMB), (0, y, -LIMB / 2))
        leg.data.materials.append(skin)
        leg_pivot = bpy.data.objects.new(f"hip_{side}", None)
        bpy.context.scene.collection.objects.link(leg_pivot)
        leg_pivot.location = (0, y, hip_height)
        leg_pivot.parent = root
        leg.parent = leg_pivot
        leg.location = (0, 0, -LIMB / 2)
        limbs[f"hip_{side}"] = leg_pivot

        arm = box(f"arm_{side}", (0.09, 0.09, LIMB * 0.9), (0, 0, -LIMB * 0.45))
        arm.data.materials.append(skin)
        arm_pivot = bpy.data.objects.new(f"shoulder_{side}", None)
        bpy.context.scene.collection.objects.link(arm_pivot)
        arm_pivot.location = (0, y * 1.5, hip_height + TORSO * 0.9)
        arm_pivot.parent = root
        arm.parent = arm_pivot
        limbs[f"shoulder_{side}"] = arm_pivot

        if side == "l" and has_shield:
            shield = box("shield", (0.06, 0.34, 0.52), (0.10, 0, -LIMB * 0.4))
            shield.data.materials.append(player)
            shield.parent = arm_pivot
        if side == "r" and has_spear:
            bpy.ops.mesh.primitive_cylinder_add(radius=0.018, depth=1.5, location=(0, 0, 0))
            spear = bpy.context.active_object
            spear.name = "spear"
            spear.data.materials.append(cloth)
            spear.parent = arm_pivot
            spear.location = (0.04, 0, -LIMB * 0.3)
            spear.rotation_euler = (math.radians(12), 0, 0)

    return root, limbs


def animate(limbs: dict, anim: str) -> int:
    """Keyframe a cycle. Returns the frame count."""
    frames = ANIMATIONS[anim]
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frames

    if "fore_l" in limbs:
        animate_quadruped(limbs, anim, frames)
        return frames

    for frame in range(1, frames + 1):
        phase = (frame - 1) / frames * math.tau
        scene.frame_set(frame)

        if anim in ("walk", "run"):
            swing = math.radians(34 if anim == "walk" else 52) * math.sin(phase)
            limbs["hip_l"].rotation_euler = (swing, 0, 0)
            limbs["hip_r"].rotation_euler = (-swing, 0, 0)
            limbs["shoulder_l"].rotation_euler = (-swing * 0.7, 0, 0)
            limbs["shoulder_r"].rotation_euler = (swing * 0.7, 0, 0)
        elif anim == "idle":
            sway = math.radians(4) * math.sin(phase)
            limbs["hip_l"].rotation_euler = (sway, 0, 0)
            limbs["hip_r"].rotation_euler = (-sway, 0, 0)
            limbs["shoulder_l"].rotation_euler = (0, 0, 0)
            limbs["shoulder_r"].rotation_euler = (sway * 2, 0, 0)
        else:  # attack: a spear thrust, weighted forward then recovering
            thrust = math.sin(phase) ** 3
            limbs["shoulder_r"].rotation_euler = (math.radians(-95) * max(0.0, thrust), 0, 0)
            limbs["shoulder_l"].rotation_euler = (math.radians(18) * thrust, 0, 0)
            limbs["hip_l"].rotation_euler = (math.radians(12) * thrust, 0, 0)
            limbs["hip_r"].rotation_euler = (math.radians(-8) * thrust, 0, 0)

        for pivot in limbs.values():
            pivot.keyframe_insert("rotation_euler", frame=frame)

    return frames


def load_renderer():
    """Import render_sprites rather than duplicating its camera.

    The 30-degree derivation lives in exactly one place, and that place is the renderer.
    """
    import importlib.util

    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "render_sprites", os.path.join(here, "render_sprites.py")
    )
    renderer = importlib.util.module_from_spec(spec)
    sys.argv = ["blender", "--"]
    spec.loader.exec_module(renderer)
    return renderer


def render_kind(renderer, kind: str, anim: str, args: argparse.Namespace) -> int:
    """Build, animate and render one kind/animation pair into args.render."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    root, limbs = build(kind)
    frames = animate(limbs, anim)

    # Cattle need their own framing: longer than a man is tall and lower at the
    # shoulder, so the figure camera clips a nose or a rump depending on rotation.
    if kind in CATTLE:
        ortho, target = 2.9, 0.62
    else:
        ortho, target = renderer.ORTHO_SCALE, renderer.TARGET_HEIGHT
    renderer.setup_camera(args.size, scale=ortho, target=target)
    renderer.setup_render(args.size)
    renderer.ensure_light()

    # Where the world origin — the point the figure stands on — lands in the rendered
    # frame. The renderer positions a unit by its foot, and that pixel is NOT the centre
    # of the frame: the camera aims above ground so the figure is not cut in half, which
    # puts the origin low. Measured through Blender's own projection rather than derived
    # from the elevation angle, because a derivation that is subtly wrong produces
    # sprites that look fine and sit a few pixels into the ground.
    from bpy_extras.object_utils import world_to_camera_view

    scene = bpy.context.scene
    # Blender evaluates matrix_world lazily. Without this the projection runs against a
    # camera transform that has not been applied yet and reports the origin at dead
    # centre of the frame — a clean, plausible, wrong answer.
    bpy.context.view_layer.update()
    normalised = world_to_camera_view(scene, scene.camera, mathutils.Vector((0.0, 0.0, 0.0)))
    origin = {
        "x": normalised.x * args.size,
        # Blender's Y runs up from the bottom of the frame; image rows run down.
        "y": (1.0 - normalised.y) * args.size,
        # How many pixels one world metre occupies in this render. Kinds are framed
        # differently — a cow needs a wider camera than a man — so without this the
        # renderer has no way to draw them at a consistent scale, and how tightly a
        # camera happened to be framed silently decides how big the thing is in game.
        "pixelsPerUnit": args.size / ortho,
    }

    directions = 5 if args.mirror else 8
    step = math.tau / 8
    written = 0

    for direction in range(directions):
        root.rotation_euler.z = direction * step
        for frame in range(frames):
            scene.frame_set(scene.frame_start + frame)
            scene.render.filepath = os.path.join(
                args.render, f"{kind}_{anim}_{direction}_{frame:02d}.png"
            )
            bpy.ops.render.render(write_still=True)
            written += 1

    print(f"[make_unit] {kind}/{anim}: {written} frames")

    # One origin per kind: the camera does not move between animations.
    origins_path = os.path.join(args.render, "origins.json")
    origins = {}
    if os.path.exists(origins_path):
        with open(origins_path) as handle:
            origins = json.load(handle)
    origins[kind] = origin
    with open(origins_path, "w") as handle:
        json.dump(origins, handle, indent=1)

    return written


def main() -> None:
    args = parse_args()

    animations = KIND_ANIMATIONS[args.kind] if args.all else (args.anim,)
    if args.anim not in KIND_ANIMATIONS[args.kind] and not args.all:
        raise SystemExit(
            f"{args.kind} has no {args.anim!r} animation; "
            f"it has {', '.join(KIND_ANIMATIONS[args.kind])}"
        )

    if not args.render:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        root, limbs = build(args.kind)
        animate(limbs, args.anim)
        if args.save:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save))
            print(f"[make_unit] saved {args.save}")
        return

    os.makedirs(args.render, exist_ok=True)
    renderer = load_renderer()
    total = sum(render_kind(renderer, args.kind, anim, args) for anim in animations)
    print(f"[make_unit] rendered {total} frames of {args.kind}")


if __name__ == "__main__":
    main()
