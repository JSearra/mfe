"""
A wild animal from a real mesh: normalise, rig, animate and render it to sprites.

    blender -b -noaudio -P tools/art/make_wild_mesh.py -- \\
        --kind zebra --mesh raw/zebra/mesh.obj --texture raw/zebra/texture.png \\
        --render out/sprites-raw

The animals in make_unit.py are built from primitives, and there is a ceiling on that:
stretched spheres on tapered cylinders get proportions and a silhouette roughly right and
can never get an animal right — no musculature, no real head, no hide. This takes a mesh
made from a generated reference image by an image-to-3D model (see README, "Wild
animals from a real mesh") and turns it into the same sprites the primitive builder
made: the same frame names, the same eight directions, the same animations, the same
origins file. Nothing downstream of the render can tell which built it.

The mesh arrives in whatever pose, scale and orientation the model produced. This:

1. Stands it on its feet facing +X. The long horizontal axis is the body; the head is
   whichever end stands higher.
2. Scales it to the species' real nose-to-rump length, so pixelsPerUnit means what it
   means for every other sprite.
3. Decimates it. Sixty thousand triangles for a sprite sixty pixels wide is waste, and it
   slows every one of the 160 renders.
4. Rigs it — by script, not by Blender's automatic weights. Bone-heat weighting fails on
   exactly the kind of noisy, not-quite-closed mesh image-to-3D produces. The legs are
   found as the four clusters of vertices below the belly; every vertex is weighted to
   the bone it is nearest, with a short blend at the joints.
5. Animates it with the gaits the primitive animals used — grazing idle, diagonal walk,
   stretched run — and renders eight directions through render_sprites.py.
"""

import argparse
import json
import math
import os
import sys

import bpy
import mathutils

HERE = os.path.dirname(os.path.abspath(__file__))

# Real nose-to-rump length in metres, and the framing make_unit.py's WILD table uses for
# the same kind, so a mesh-built animal and a primitive one agree about how big a metre
# is. Framing is (ortho, target height, frame size).
SPECIES = {
    # `saturation` scales the baked texture's colour. The image-to-3D model's bake shifts
    # hues — the first zebra came back with a red-brown cast over its white stripes — and
    # a zebra is near black and white, so its colour is pulled well down.
    "zebra": {"length": 2.3, "ortho": 4.2, "target": 1.2, "size": 168, "saturation": 0.35},
    "elephant": {"length": 4.2, "ortho": 6.4, "target": 1.5, "size": 192},
    "kudu": {"length": 2.3, "ortho": 3.4, "target": 0.9, "size": 128},
    "impala": {"length": 1.5, "ortho": 2.4, "target": 0.6, "size": 96},
    "eland": {"length": 2.8, "ortho": 3.8, "target": 1.0, "size": 128},
    "wildebeest": {"length": 2.3, "ortho": 3.4, "target": 0.8, "size": 128},
    "warthog": {"length": 1.3, "ortho": 2.2, "target": 0.4, "size": 96},
    "buffalo": {"length": 3.0, "ortho": 4.0, "target": 0.9, "size": 128},
    "hippo": {"length": 3.6, "ortho": 4.6, "target": 0.7, "size": 128},
    "lion": {"length": 2.2, "ortho": 3.4, "target": 0.6, "size": 128},
    "leopard": {"length": 1.7, "ortho": 2.8, "target": 0.5, "size": 96},
    "hyena": {"length": 1.5, "ortho": 2.6, "target": 0.6, "size": 96},
    "baboon": {"length": 1.0, "ortho": 2.0, "target": 0.45, "size": 96},
    "ostrich": {"length": 1.5, "ortho": 3.4, "target": 1.2, "size": 128},
    "guineafowl": {"length": 0.55, "ortho": 1.3, "target": 0.28, "size": 64},
}

ANIMATIONS = {"idle": 4, "walk": 8, "run": 8}
TARGET_FACES = 9000


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True, choices=sorted(SPECIES))
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--texture", default="")
    parser.add_argument("--render", default="")
    parser.add_argument("--save", default="", help="Write the rigged .blend here too")
    parser.add_argument("--up", default="Z", help="The mesh file's up axis")
    return parser.parse_args(argv)


def import_mesh(path: str, texture: str, up: str, saturation: float = 1.0) -> bpy.types.Object:
    bpy.ops.wm.obj_import(filepath=path, up_axis=up, forward_axis="Y" if up == "Z" else "NEGATIVE_Z")
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = "animal"

    if texture:
        mat = bpy.data.materials.new("hide")
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        bsdf = nodes["Principled BSDF"]
        image = nodes.new("ShaderNodeTexImage")
        image.image = bpy.data.images.load(os.path.abspath(texture))
        # Colour correction in the shader rather than on the pixels, so the texture file
        # the model produced stays exactly as it was.
        adjust = nodes.new("ShaderNodeHueSaturation")
        adjust.inputs["Saturation"].default_value = saturation
        mat.node_tree.links.new(image.outputs["Color"], adjust.inputs["Color"])
        mat.node_tree.links.new(adjust.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = 0.9
        bsdf.inputs["Specular IOR Level"].default_value = 0.1
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    return obj


def world_vertices(obj: bpy.types.Object) -> list:
    return [obj.matrix_world @ v.co for v in obj.data.vertices]


def apply_transform(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def normalise(obj: bpy.types.Object, length: float) -> None:
    """Feet on the ground at the origin, head toward +X, nose to rump `length` metres."""
    points = world_vertices(obj)
    # The body's long axis, seen from above: the principal axis of the vertices in the
    # ground plane. Not simply the longer side of the bounding box — the reference is a
    # three-quarter view and the model keeps that pose, so the body lies on a diagonal,
    # and measuring the box made a 2.3 m zebra stand 2.7 m tall and faced every sprite
    # direction 45 degrees off.
    mx = sum(p.x for p in points) / len(points)
    my = sum(p.y for p in points) / len(points)
    sxx = sum((p.x - mx) ** 2 for p in points)
    syy = sum((p.y - my) ** 2 for p in points)
    sxy = sum((p.x - mx) * (p.y - my) for p in points)
    heading = 0.5 * math.atan2(2 * sxy, sxx - syy)
    obj.rotation_euler.z -= heading
    apply_transform(obj)
    points = world_vertices(obj)

    # The head end stands higher than the rump: compare the tallest point at each end.
    min_x = min(p.x for p in points)
    max_x = max(p.x for p in points)
    reach = (max_x - min_x) * 0.25
    front = max((p.z for p in points if p.x > max_x - reach), default=0)
    back = max((p.z for p in points if p.x < min_x + reach), default=0)
    if back > front:
        obj.rotation_euler.z += math.pi
        apply_transform(obj)
        points = world_vertices(obj)

    min_x = min(p.x for p in points)
    max_x = max(p.x for p in points)
    scale = length / (max_x - min_x)
    obj.scale = (scale, scale, scale)
    apply_transform(obj)
    points = world_vertices(obj)
    centre_x = (min(p.x for p in points) + max(p.x for p in points)) / 2
    centre_y = (min(p.y for p in points) + max(p.y for p in points)) / 2
    floor = min(p.z for p in points)
    obj.location = (-centre_x, -centre_y, -floor)
    apply_transform(obj)


def decimate(obj: bpy.types.Object) -> None:
    faces = len(obj.data.polygons)
    if faces <= TARGET_FACES:
        return
    modifier = obj.modifiers.new("decimate", "DECIMATE")
    modifier.ratio = TARGET_FACES / faces
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def find_legs(points: list) -> dict:
    """
    Four leg columns from the vertices below the belly.

    Below `belly` there is nothing but legs, so splitting what is there by front/back and
    left/right finds them — robust to a mesh that is noisy everywhere else, which is the
    kind this has to take.
    """
    height = max(p.z for p in points)
    belly = height * 0.34
    low = [p for p in points if p.z < belly]
    mid_x = (min(p.x for p in low) + max(p.x for p in low)) / 2
    legs = {}
    for pair, front in (("fore", True), ("hind", False)):
        side_points = [p for p in low if (p.x > mid_x) == front]
        mid_y = sorted(p.y for p in side_points)[len(side_points) // 2]
        for side, left in (("l", True), ("r", False)):
            column = [p for p in side_points if (p.y > mid_y) == left] or side_points
            cx = sum(p.x for p in column) / len(column)
            cy = sum(p.y for p in column) / len(column)
            legs[f"{pair}_{side}"] = mathutils.Vector((cx, cy, 0.0))
    return {"legs": legs, "height": height, "belly": belly}


def rig(obj: bpy.types.Object) -> bpy.types.Object:
    points = world_vertices(obj)
    found = find_legs(points)
    legs, height, belly = found["legs"], found["height"], found["belly"]
    min_x = min(p.x for p in points)
    max_x = max(p.x for p in points)
    back_z = height * 0.62

    armature_data = bpy.data.armatures.new("rig")
    armature = bpy.data.objects.new("rig", armature_data)
    bpy.context.scene.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    edit = armature_data.edit_bones

    fore_x = (legs["fore_l"].x + legs["fore_r"].x) / 2
    hind_x = (legs["hind_l"].x + legs["hind_r"].x) / 2
    body = edit.new("body")
    body.head = (hind_x, 0, back_z)
    body.tail = (fore_x, 0, back_z)

    neck = edit.new("neck")
    neck.head = (fore_x, 0, back_z)
    neck.tail = (max_x - (max_x - fore_x) * 0.25, 0, height * 0.9)
    neck.parent = body

    tail = edit.new("tail")
    tail.head = (hind_x - (hind_x - min_x) * 0.3, 0, back_z)
    tail.tail = (min_x, 0, back_z * 0.7)
    tail.parent = body

    for name, foot in legs.items():
        top = edit.new(f"{name}_upper")
        top.head = (foot.x, foot.y, belly * 1.35)
        top.tail = (foot.x, foot.y, belly * 0.55)
        top.parent = body
        low = edit.new(f"{name}_lower")
        low.head = top.tail.copy()
        low.tail = (foot.x, foot.y, 0.0)
        low.parent = top
        low.use_connect = True

    bpy.ops.object.mode_set(mode="OBJECT")

    # Weights by proximity to each bone's segment: every vertex to its nearest bone, and
    # a second bone blended in where two are nearly as close (the joints). Legs claim only
    # what is below the belly on their own side, so a leg never drags the flank.
    bones = [(b.name, b.head_local.copy(), b.tail_local.copy()) for b in armature_data.bones]
    groups = {name: obj.vertex_groups.new(name=name) for name, _, _ in bones}
    for vertex in obj.data.vertices:
        p = vertex.co
        distances = []
        for name, head, tail in bones:
            if "_upper" in name or "_lower" in name:
                if p.z > belly * 1.5:
                    continue
            segment = tail - head
            t = max(0.0, min(1.0, (p - head).dot(segment) / max(segment.length_squared, 1e-9)))
            distances.append(((head + segment * t - p).length, name))
        distances.sort()
        nearest, first = distances[0]
        groups[first].add([vertex.index], 1.0, "REPLACE")
        if len(distances) > 1:
            second, name2 = distances[1]
            if second < nearest * 1.25 + 0.02:
                blend = 0.5 * (1 - (second - nearest) / (nearest * 0.25 + 0.02))
                groups[first].add([vertex.index], 1 - blend, "REPLACE")
                groups[name2].add([vertex.index], blend, "REPLACE")

    modifier = obj.modifiers.new("rig", "ARMATURE")
    modifier.object = armature
    obj.parent = armature
    return armature


def pose(armature: bpy.types.Object, name: str, pitch: float) -> None:
    """Rotate a bone about the world Y axis — forward/back swing for something facing +X."""
    bone = armature.pose.bones[name]
    rest = bone.bone.matrix_local.to_3x3()
    world = mathutils.Matrix.Rotation(pitch, 3, "Y")
    local = rest.inverted() @ world @ rest
    bone.rotation_mode = "QUATERNION"
    bone.rotation_quaternion = local.to_quaternion()


def animate(armature: bpy.types.Object, anim: str, frames: int) -> None:
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frames
    for frame in range(1, frames + 1):
        phase = (frame - 1) / frames * math.tau
        if anim == "idle":
            # Head down to graze and a little up again; legs still.
            pose(armature, "neck", math.radians(38 + 10 * math.sin(phase)))
            for leg in ("fore_l", "fore_r", "hind_l", "hind_r"):
                pose(armature, f"{leg}_upper", 0)
                pose(armature, f"{leg}_lower", 0)
            pose(armature, "tail", math.radians(6 * math.sin(phase * 2)))
        else:
            fast = anim == "run"
            reach = math.radians(28 if fast else 16)
            for leg, offset in (("fore_l", 0), ("hind_r", 0), ("fore_r", math.pi), ("hind_l", math.pi)):
                swing = reach * math.sin(phase + offset)
                pose(armature, f"{leg}_upper", swing)
                # The lower leg folds on the way forward and straightens to take weight.
                fold = max(0.0, math.sin(phase + offset + math.pi / 2)) * math.radians(35 if fast else 22)
                pose(armature, f"{leg}_lower", -fold if leg.startswith("fore") else fold)
            pose(armature, "neck", math.radians((-8 if fast else 2) + 4 * math.sin(phase * 2)))
            pose(armature, "tail", math.radians(-25 if fast else -4))
        for bone in armature.pose.bones:
            bone.keyframe_insert("rotation_quaternion", frame=frame)


def load_renderer():
    import importlib.util

    spec = importlib.util.spec_from_file_location("render_sprites", os.path.join(HERE, "render_sprites.py"))
    renderer = importlib.util.module_from_spec(spec)
    saved = sys.argv
    sys.argv = ["blender", "--"]
    spec.loader.exec_module(renderer)
    sys.argv = saved
    return renderer


def build(args):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    spec = SPECIES[args.kind]
    obj = import_mesh(args.mesh, args.texture, args.up, spec.get("saturation", 1.0))
    normalise(obj, spec["length"])
    decimate(obj)
    armature = rig(obj)
    root = bpy.data.objects.new("root", None)
    bpy.context.scene.collection.objects.link(root)
    armature.parent = root
    return root, armature


def main() -> None:
    args = parse_args()
    spec = SPECIES[args.kind]
    renderer = load_renderer() if args.render else None
    origin = None
    written = 0

    for anim, frames in ANIMATIONS.items():
        root, armature = build(args)
        animate(armature, anim, frames)
        if args.save and anim == "walk":
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save))
        if renderer is None:
            continue
        renderer.setup_camera(spec["size"], scale=spec["ortho"], target=spec["target"])
        renderer.setup_render(spec["size"])
        renderer.ensure_light()
        scene = bpy.context.scene
        bpy.context.view_layer.update()
        from bpy_extras.object_utils import world_to_camera_view

        at = world_to_camera_view(scene, scene.camera, mathutils.Vector((0.0, 0.0, 0.0)))
        origin = {"x": at.x * spec["size"], "y": (1.0 - at.y) * spec["size"], "pixelsPerUnit": spec["size"] / spec["ortho"]}
        os.makedirs(args.render, exist_ok=True)
        for direction in range(8):
            root.rotation_euler.z = direction * math.tau / 8
            for frame in range(frames):
                scene.frame_set(frame + 1)
                scene.render.filepath = os.path.join(args.render, f"{args.kind}_{anim}_{direction}_{frame:02d}.png")
                bpy.ops.render.render(write_still=True)
                written += 1

    if args.render and origin is not None:
        path = os.path.join(args.render, "origins.json")
        origins = json.load(open(path)) if os.path.exists(path) else {}
        origins[args.kind] = origin
        with open(path, "w") as handle:
            json.dump(origins, handle, indent=1)
    print(f"[make_wild_mesh] {args.kind}: {written} frames")


if __name__ == "__main__":
    main()
