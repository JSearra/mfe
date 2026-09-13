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
import math
import os
import sys

import bpy

# Rough human proportions in Blender units, where 1.0 is about a metre.
HEIGHT = 1.75
HEAD = 0.22
TORSO = 0.62
LIMB = 0.52

KINDS = {
    # name:        (skin,                  cloth,               shield,  has_spear)
    "impi": ((0.38, 0.24, 0.16), (0.52, 0.44, 0.30), True, True),
    "herder": ((0.38, 0.24, 0.16), (0.62, 0.56, 0.40), False, True),
    "musketeer": ((0.42, 0.30, 0.22), (0.34, 0.32, 0.28), False, True),
}

ANIMATIONS = {"idle": 8, "walk": 12, "attack": 10}


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="Build a placeholder unit")
    parser.add_argument("--kind", default="impi", choices=sorted(KINDS))
    parser.add_argument("--anim", default="walk", choices=sorted(ANIMATIONS))
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


def build(kind: str):
    """A figure standing on the origin, facing +X."""
    skin_colour, cloth_colour, has_shield, has_spear = KINDS[kind]
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

    for frame in range(1, frames + 1):
        phase = (frame - 1) / frames * math.tau
        scene.frame_set(frame)

        if anim == "walk":
            swing = math.radians(34) * math.sin(phase)
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


def main() -> None:
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)

    root, limbs = build(args.kind)
    frames = animate(limbs, args.anim)

    if args.save:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save))
        print(f"[make_unit] saved {args.save}")

    if args.render:
        # Import the renderer rather than duplicating its camera, so the 30-degree
        # derivation lives in exactly one place.
        import importlib.util

        here = os.path.dirname(os.path.abspath(__file__))
        spec = importlib.util.spec_from_file_location(
            "render_sprites", os.path.join(here, "render_sprites.py")
        )
        renderer = importlib.util.module_from_spec(spec)
        sys.argv = ["blender", "--", "--out", args.render, "--name", args.kind]
        spec.loader.exec_module(renderer)

        os.makedirs(args.render, exist_ok=True)
        renderer.setup_camera(args.size)
        renderer.setup_render(args.size)
        renderer.ensure_light()

        scene = bpy.context.scene
        directions = 5 if args.mirror else 8
        step = math.tau / 8
        written = 0

        for direction in range(directions):
            root.rotation_euler.z = direction * step
            for frame in range(frames):
                scene.frame_set(scene.frame_start + frame)
                scene.render.filepath = os.path.join(
                    args.render, f"{args.kind}_{args.anim}_{direction}_{frame:02d}.png"
                )
                bpy.ops.render.render(write_still=True)
                written += 1

        print(f"[make_unit] rendered {written} frames of {args.kind}/{args.anim}")


if __name__ == "__main__":
    main()
