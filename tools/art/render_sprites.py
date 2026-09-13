"""
Render a 3D model to an isometric sprite sheet.

Run headless:

    blender -b unit.blend -P tools/art/render_sprites.py -- \
        --out assets/units/impi --name impi --directions 8 --size 128

This is the pipeline AoE2 itself used, and it is the answer to the problem image
generation cannot solve. A diffusion model asked for the same soldier from eight angles
across fifteen animation frames produces a hundred and twenty slightly different men;
a rotated model produces one man a hundred and twenty times. Consistency is the whole
requirement, and only the renderer gives it for free.

THE CAMERA ANGLE IS 30 DEGREES, NOT 35.264.

Half the tutorials on this say 35.264, which is *true* isometric — the angle at which all
three axes foreshorten equally. Games almost never use it, because it makes tiles
2:1.732 and the maths ugly. The 2:1 diamond this project uses comes from:

    screen_dx  =  cos(45 deg)              per unit step in X
    screen_dy  =  sin(45 deg) * sin(theta)  per unit step in X
    width : height  =  1 : sin(theta)  =  2 : 1   ->   sin(theta) = 0.5   ->   theta = 30 deg

Blender's camera looks down -Z, so an elevation of 30 degrees above the horizon is a
rotation of 60 degrees about X, and the 45 degree azimuth is a rotation about Z.
"""

import argparse
import math
import os
import sys

import bpy

# 2:1 dimetric. See the derivation above.
ELEVATION_DEGREES = 30.0
AZIMUTH_DEGREES = 45.0

# The camera looks at this height, not at the ground.
#
# A figure STANDS on the origin and extends upward, so a camera aimed at the origin puts
# it entirely in the top half of the frame — and once the framing is tight enough to be
# worth rendering, the head leaves the frame. The first tight render decapitated every
# sprite, and the frame-occupancy measurement did not catch it because a clipped figure
# still has a plausible bounding box. Aim at roughly mid-torso.
TARGET_HEIGHT = 0.85


def parse_args() -> argparse.Namespace:
    # Blender passes its own arguments first; everything after `--` is ours.
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []

    parser = argparse.ArgumentParser(description="Render isometric sprite sheets")
    parser.add_argument("--out", required=True, help="Output directory")
    parser.add_argument("--name", required=True, help="Sprite base name, e.g. impi")
    parser.add_argument("--anim", default="idle", help="Animation name for the filename")
    parser.add_argument("--directions", type=int, default=8)
    parser.add_argument("--frames", type=int, default=1, help="Animation frames to step through")
    parser.add_argument("--size", type=int, default=128, help="Output square size in pixels")
    parser.add_argument(
        "--object",
        default="",
        help="Name of the object to rotate. Defaults to the first mesh found.",
    )
    parser.add_argument(
        "--mirror",
        action="store_true",
        help=(
            "Render only the 5 unique directions of 8 and mirror the rest, as AoE2 did. "
            "Cuts the atlas budget by 37 percent at the cost of asymmetric detail."
        ),
    )
    return parser.parse_args(argv)


def find_subject(name: str):
    if name:
        subject = bpy.data.objects.get(name)
        if subject is None:
            raise SystemExit(f"no object named {name!r} in this .blend")
        return subject

    for obj in bpy.data.objects:
        if obj.type in {"MESH", "ARMATURE", "EMPTY"}:
            return obj
    raise SystemExit("no mesh, armature or empty to render")


def setup_camera(size: int) -> None:
    """An orthographic camera at the isometric angle, framing the origin."""
    camera_data = bpy.data.cameras.new("iso_camera")
    camera_data.type = "ORTHO"
    # Tight enough that a figure fills most of its tile. The first pass used 3.2 and the
    # units came out occupying about a third of the frame, which wastes most of an atlas
    # page on transparent margin and makes them illegible at game size. 2.2 leaves room
    # for a raised spear and little else.
    camera_data.ortho_scale = 2.2

    camera = bpy.data.objects.new("iso_camera", camera_data)
    bpy.context.scene.collection.objects.link(camera)

    distance = 10.0
    elevation = math.radians(ELEVATION_DEGREES)
    azimuth = math.radians(AZIMUTH_DEGREES)

    camera.location = (
        distance * math.cos(elevation) * math.sin(azimuth),
        -distance * math.cos(elevation) * math.cos(azimuth),
        distance * math.sin(elevation) + TARGET_HEIGHT,
    )
    camera.rotation_euler = (math.radians(90.0 - ELEVATION_DEGREES), 0.0, azimuth)
    bpy.context.scene.camera = camera


def setup_render(size: int) -> None:
    scene = bpy.context.scene
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    # Transparent background: the sprite is composited over terrain, not over a colour.
    scene.render.film_transparent = True
    scene.render.filter_size = 0.8  # slightly crisp, so edges stay readable when small


def ensure_light() -> None:
    """
    A key light fixed in WORLD space, plus ambient fill.

    Fixed to the world rather than to the camera, so a soldier facing away is lit from
    behind exactly as he would be on the field. Locking the light to the camera makes
    every direction identically lit, which reads flat and makes facing hard to judge —
    the opposite of what a sprite sheet is for.

    The fill matters more than it sounds. With a key light alone the shadowed side of a
    figure goes to black, and since half the eight directions are turned away from the
    key, half the sprite sheet is unreadable. Ambient light from the world lifts those
    out of the dark without flattening the form the key is providing.
    """
    world = bpy.context.scene.world
    if world is None:
        world = bpy.data.worlds.new("world")
        bpy.context.scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background is not None:
        # Warm, dim: veld light bounced off dust, not a studio.
        background.inputs["Color"].default_value = (0.42, 0.38, 0.32, 1.0)
        background.inputs["Strength"].default_value = 0.9

    if any(obj.type == "LIGHT" for obj in bpy.data.objects):
        return

    light_data = bpy.data.lights.new("key", type="SUN")
    light_data.energy = 5.5
    light = bpy.data.objects.new("key", light_data)
    bpy.context.scene.collection.objects.link(light)
    light.rotation_euler = (math.radians(50.0), 0.0, math.radians(-35.0))


def main() -> None:
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)

    subject = find_subject(args.object)
    setup_camera(args.size)
    setup_render(args.size)
    ensure_light()

    scene = bpy.context.scene
    base_rotation = subject.rotation_euler.z
    directions = 5 if args.mirror else args.directions
    step = 2.0 * math.pi / args.directions

    rendered = 0
    for direction in range(directions):
        subject.rotation_euler.z = base_rotation + direction * step

        for frame in range(args.frames):
            if args.frames > 1:
                scene.frame_set(scene.frame_start + frame)

            scene.render.filepath = os.path.join(
                args.out, f"{args.name}_{args.anim}_{direction}_{frame:02d}.png"
            )
            bpy.ops.render.render(write_still=True)
            rendered += 1

    print(f"[render_sprites] wrote {rendered} frames to {args.out}")
    if args.mirror:
        print("[render_sprites] 5 of 8 directions rendered; mirror the rest in postprocess.py")


if __name__ == "__main__":
    main()
