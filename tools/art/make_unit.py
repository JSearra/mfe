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

# Dress and kit, and the silhouette is most of the point.
#
# The first figure was a box with a stick: nothing about it said which army it belonged
# to, and at forty pixels a unit is read almost entirely by its outline. What makes an
# impi legible at that size is the war shield — the isihlangu is a tall oval of oxhide
# carried on the left, long enough to cover most of the body, and it is by far the
# largest thing in the silhouette. After that: a short stabbing spear rather than a long
# throwing one, cow-tail tufts at the arms and below the knee, and a headband.
#
# Naming: docs/CONTENT.md flags that "iklwa" for the short spear is widely repeated but
# historically contested, and that "assegai" is a generic Portuguese-derived term. Since
# nothing user-facing is named here, the geometry is just called a spear and the naming
# decision is left where CONTENT.md puts it.
SHIELD_HEIGHT = 0.95
SHIELD_WIDTH = 0.46
SPEAR_LENGTH = 0.92

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


def blob(name: str, size: tuple[float, float, float], location: tuple[float, float, float]):
    """A smooth-shaded ellipsoid.

    Cattle were built from cubes and read as crates on legs. An animal is all curve, and
    at forty pixels the difference between a box and an ellipsoid is the difference
    between a shipping container and a cow. Smooth shading matters as much as the shape:
    a faceted low-poly sphere just looks like a worse box.
    """
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    bpy.ops.object.shade_smooth()
    return obj


def taper(name: str, lower: float, upper: float, depth: float, location, rotation=(0.0, 0.0, 0.0)):
    """A truncated cone, for limbs and necks that should not be tubes."""
    bpy.ops.mesh.primitive_cone_add(
        vertices=12, radius1=lower, radius2=upper, depth=depth, location=location
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rotation
    bpy.ops.object.shade_smooth()
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

    # Barrel, deeper at the shoulder than at the flank, which is what gives a cow its
    # wedge from the side rather than the sausage a plain ellipsoid gives.
    body = blob("body", (COW_LENGTH, COW_WIDTH, COW_DEPTH), (0, 0, back))
    body.data.materials.append(hide)
    body.parent = root

    # Kept at or below the barrel's own height. Taller than the body and it rises above
    # the backline as a bulge, which made the animal read as segmented — a caterpillar
    # rather than a cow. These only broaden the shoulder and the haunch.
    chest = blob("chest", (COW_LENGTH * 0.46, COW_WIDTH * 1.06, COW_DEPTH * 0.96),
                 (COW_LENGTH * 0.20, 0, back - 0.01))
    chest.data.materials.append(hide)
    chest.parent = root

    rump = blob("rump", (COW_LENGTH * 0.42, COW_WIDTH * 1.0, COW_DEPTH * 0.92),
                (-COW_LENGTH * 0.30, 0, back - 0.01))
    rump.data.materials.append(hide)
    rump.parent = root

    # The hump. Small and over the shoulder, which is what makes the silhouette Sanga
    # rather than taurine — it is most of the read at 40 pixels.
    hump = blob("hump", (0.40, 0.28, 0.22), (COW_LENGTH * 0.22, 0, back + COW_DEPTH * 0.46))
    hump.data.materials.append(hide)
    hump.parent = root

    # Patches. Flattened blobs pressed onto the flank rather than boxes stuck to a
    # crate: a rectangle on a curved body reads as a label, which is exactly how the
    # first version looked.
    # Big and barely proud of the flank. Two curved surfaces meeting only just intersect,
    # so a patch the size of the marking comes out as a small lens — the first attempt
    # gave white dots. These are wide in the plane of the flank and only a little wider
    # than the body across it.
    for index, (px, pz, size) in enumerate(
        (
            (-0.26, -0.02, (0.62, COW_WIDTH + 0.015, 0.46)),
            (0.20, 0.10, (0.40, COW_WIDTH + 0.015, 0.34)),
            (-0.52, -0.10, (0.30, COW_WIDTH + 0.015, 0.28)),
        )
    ):
        spot = blob(f"patch_{index}", size, (px, 0, back + pz))
        spot.data.materials.append(patch)
        spot.parent = root

    # Pale underside, common in the breed and the cheapest way to stop the animal
    # reading as one solid lump at tile size.
    # Narrower than the body, so it stays underneath instead of wrapping up the flanks
    # as a painted stripe.
    belly = blob("belly", (COW_LENGTH * 0.72, COW_WIDTH * 0.74, 0.20),
                 (0, 0, back - COW_DEPTH / 2 + 0.02))
    belly.data.materials.append(patch)
    belly.parent = root

    # Neck and head, angled up and forward from the shoulder.
    neck_pivot = bpy.data.objects.new("neck", None)
    bpy.context.scene.collection.objects.link(neck_pivot)
    neck_pivot.location = (COW_LENGTH * 0.40, 0, back + COW_DEPTH * 0.20)
    neck_pivot.parent = root

    neck = taper("neck_mesh", 0.17, 0.11, 0.34, (0.15, 0, 0.05), (0, math.radians(78), 0))
    neck.data.materials.append(hide)
    neck.parent = neck_pivot

    head = blob("head", (0.34, 0.19, 0.20), (0.40, 0, 0.09))
    head.data.materials.append(hide)
    head.parent = neck_pivot

    muzzle = blob("muzzle", (0.16, 0.13, 0.13), (0.53, 0, 0.05))
    muzzle.data.materials.append(patch)
    muzzle.parent = neck_pivot

    for side, y in (("l", 1.0), ("r", -1.0)):
        ear = blob(f"ear_{side}", (0.09, 0.13, 0.06), (0.33, y * 0.13, 0.13))
        ear.data.materials.append(hide)
        ear.parent = neck_pivot

        # Lyre horns: out to the side, then up. Two segments each, because a single
        # angled cylinder reads as a spike and the lateral sweep is the recognisable
        # part. Tapered, so they come to a point like horn rather than ending flat.
        base = taper(
            f"horn_base_{side}", 0.026, 0.018, 0.28,
            (0.36, y * 0.15, 0.21), (math.radians(90 * y * -1), 0, 0),
        )
        base.data.materials.append(horn)
        base.parent = neck_pivot

        tip = taper(
            f"horn_tip_{side}", 0.017, 0.004, 0.22,
            (0.36, y * 0.27, 0.31), (math.radians(-38 * y), 0, 0),
        )
        tip.data.materials.append(horn)
        tip.parent = neck_pivot

    # Tail, hanging from the rump with a dark switch on the end.
    tail_pivot = bpy.data.objects.new("tail", None)
    bpy.context.scene.collection.objects.link(tail_pivot)
    tail_pivot.location = (-COW_LENGTH / 2, 0, back + COW_DEPTH * 0.28)
    tail_pivot.parent = root

    tail = taper("tail_mesh", 0.022, 0.010, 0.50, (0, 0, -0.25))
    tail.data.materials.append(hide)
    tail.parent = tail_pivot

    switch = blob("switch", (0.07, 0.07, 0.14), (0, 0, -0.52))
    switch.data.materials.append(patch)
    switch.parent = tail_pivot

    limbs = {"neck": neck_pivot, "tail": tail_pivot}
    for pair, x in (("fore", COW_LENGTH * 0.32), ("hind", -COW_LENGTH * 0.32)):
        for side, y in (("l", COW_WIDTH * 0.34), ("r", -COW_WIDTH * 0.34)):
            pivot = bpy.data.objects.new(f"{pair}_{side}", None)
            bpy.context.scene.collection.objects.link(pivot)
            pivot.location = (x, y, COW_LEG)
            pivot.parent = root

            # Thicker at the top, thinner at the fetlock.
            leg = taper(f"leg_{pair}_{side}", 0.075, 0.038, COW_LEG, (0, 0, -COW_LEG / 2))
            leg.data.materials.append(hide)
            leg.parent = pivot

            hoof = blob(f"hoof_{pair}_{side}", (0.10, 0.10, 0.09), (0, 0, -COW_LEG + 0.03))
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

    hide_pale = material("hide_pale", (0.88, 0.84, 0.76))
    blade_metal = material("blade", (0.72, 0.72, 0.70))

    root = bpy.data.objects.new("unit", None)
    bpy.context.scene.collection.objects.link(root)

    hip_height = LIMB
    # A bare torso, with the umutsha at the waist rather than a tunic over the chest.
    # The first version dressed everyone in a cloth block, which read as a jerkin.
    torso = box("torso", (0.30, 0.20, TORSO), (0, 0, hip_height + TORSO / 2))
    torso.data.materials.append(skin if has_shield else cloth)
    torso.parent = root

    if has_shield:
        waist = box("umutsha", (0.32, 0.23, 0.16), (0, 0, hip_height + 0.06))
        waist.data.materials.append(cloth)
        waist.parent = root

    head = box("head", (HEAD, HEAD, HEAD), (0, 0, hip_height + TORSO + HEAD / 2))
    head.data.materials.append(skin)
    head.parent = root

    if has_shield:
        # Headband. At tile size it is two pixels, but it is two pixels that stop the
        # head reading as a bare cube.
        band = box("headband", (HEAD * 1.06, HEAD * 1.06, 0.05), (0, 0, hip_height + TORSO + HEAD * 0.22))
        band.data.materials.append(hide_pale)
        band.parent = root

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
            # An oval rather than a slab: scaled spheres cost nothing and the rounded
            # top is what stops it reading as a door. Carried slightly forward of the
            # body and tilted, which is how it covers the torso without hiding the arm.
            # Through blob() like everything else, which takes diameters. Setting .scale
            # directly here meant this one object was sized in half-extents while its
            # neighbours were sized in full ones, and the marking below — written to the
            # other convention — came out thinner than the shield and vanished inside it.
            shield = blob("shield", (0.10, SHIELD_WIDTH, SHIELD_HEIGHT), (0, 0, 0))
            # Pale hide, not player colour. Warriors were brown kit on brown ground and
            # sank into the terrain, while the cattle beside them read clearly — and the
            # reason is contrast, not size: the cattle carry big pale patches. A war
            # shield was oxhide in strong two-tone anyway, so the legible choice and the
            # accurate one are the same. Faction colour goes on the lower field below,
            # where it still identifies an army without costing the silhouette.
            shield.data.materials.append(hide_pale)
            shield.parent = arm_pivot
            shield.location = (0.08, 0.04, -LIMB * 0.15)
            shield.rotation_euler = (0, math.radians(-8), 0)

            # The pale stripe down the hide. Shields were sorted by colour and marking
            # into regiments, so this is also where a faction or unit marking belongs.
            #
            # Parented to the shoulder rather than to the shield: the shield is a scaled
            # sphere, and a child of it inherits that scale, so sizing the stripe means
            # dividing by the parent's scale on every axis. The first attempt did that
            # and put the stripe somewhere outside the shield entirely. A sibling in the
            # same place needs no arithmetic at all.
            # Thicker than the shield, so it actually breaks the surface on both faces.
            field = blob(
                "shield_field",
                (0.13, SHIELD_WIDTH * 0.80, SHIELD_HEIGHT * 0.40),
                (0.08, 0.04, -LIMB * 0.15 - SHIELD_HEIGHT * 0.15),
            )
            field.data.materials.append(player)
            field.parent = arm_pivot

            stripe = box("shield_stripe", (0.012, 0.06, SHIELD_HEIGHT * 0.52), (0, 0, 0))
            stripe.data.materials.append(cloth)
            stripe.parent = arm_pivot
            stripe.location = (0.052, 0.04, -LIMB * 0.15)

            # The staff behind the shield, projecting past it top and bottom.
            staff = cylinder("shield_staff", 0.012, SHIELD_HEIGHT * 1.18, (0.065, 0.04, -LIMB * 0.15))
            staff.data.materials.append(cloth)
            staff.parent = arm_pivot

        if side == "r" and has_spear:
            # Short. The whole tactical point of the weapon is that it is not thrown, so
            # a long shaft reads as the wrong army.
            spear = cylinder("spear", 0.016, SPEAR_LENGTH, (0.04, 0, -LIMB * 0.30))
            spear.data.materials.append(cloth)
            spear.parent = arm_pivot
            spear.rotation_euler = (math.radians(12), 0, 0)

            blade = box("spear_blade", (0.035, 0.012, 0.20), (0.04, 0, -LIMB * 0.30 + SPEAR_LENGTH * 0.56))
            blade.data.materials.append(blade_metal)
            blade.parent = arm_pivot
            blade.rotation_euler = (math.radians(12), 0, 0)

        # Amashoba: cow-tail tufts at the upper arm and below the knee. Small, but they
        # break the limb outline and are one of the few details that survive the
        # downscale as anything other than a smudge.
        tuft_arm = box(f"tuft_arm_{side}", (0.10, 0.10, 0.13), (0, 0, -LIMB * 0.62))
        tuft_arm.data.materials.append(hide_pale)
        tuft_arm.parent = arm_pivot

        tuft_leg = box(f"tuft_leg_{side}", (0.11, 0.11, 0.12), (0, 0, -LIMB * 0.74))
        tuft_leg.data.materials.append(hide_pale)
        tuft_leg.parent = leg_pivot

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
