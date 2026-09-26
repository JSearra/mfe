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

import bmesh
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
    "zebra": {"length": 2.3, "stand": 2.1, "ortho": 4.2, "target": 1.2, "size": 168, "saturation": 0.35},
    # `value` scales brightness the same way: the elephant's bake came back pale
    # grey-beige, like stone, and an elephant is dark slate.
    "elephant": {"length": 4.2, "stand": 3.4, "ortho": 6.4, "target": 1.5, "size": 192, "belly": 0.36, "saturation": 0.45, "value": 0.55},
    "kudu": {"length": 2.3, "stand": 2.5, "ortho": 3.4, "target": 0.9, "size": 128},
    "impala": {"length": 1.5, "stand": 1.3, "ortho": 2.4, "target": 0.6, "size": 96},
    "eland": {"length": 2.8, "stand": 2.2, "ortho": 3.8, "target": 1.0, "size": 128, "saturation": 0.75, "value": 0.9},
    "wildebeest": {"length": 2.3, "stand": 1.75, "ortho": 3.4, "target": 0.8, "size": 128},
    "warthog": {"length": 1.3, "stand": 0.85, "ortho": 2.2, "target": 0.4, "size": 96, "belly": 0.3, "saturation": 0.7, "value": 0.55},
    "buffalo": {"length": 3.0, "stand": 1.7, "ortho": 4.0, "target": 0.9, "size": 128},
    "hippo": {"length": 3.6, "stand": 1.6, "ortho": 4.6, "target": 0.7, "size": 128, "belly": 0.24, "saturation": 0.6, "value": 0.62},
    "lion": {"length": 2.2, "stand": 1.3, "ortho": 3.4, "target": 0.6, "size": 128},
    "leopard": {"length": 1.7, "stand": 0.95, "ortho": 2.8, "target": 0.5, "size": 96},
    "hyena": {"length": 1.5, "stand": 1.0, "ortho": 2.6, "target": 0.6, "size": 96, "saturation": 0.5, "value": 0.85},
    "baboon": {"length": 1.0, "stand": 0.85, "ortho": 2.0, "target": 0.45, "size": 96, "belly": 0.3, "saturation": 0.8, "value": 0.72},
    "ostrich": {"length": 1.5, "stand": 2.5, "ortho": 3.4, "target": 1.2, "size": 128, "legs": 2, "belly": 0.4},
    # People (the villagers of make_unit.py), scaled by HEIGHT rather than length, rendered
    # sharper — the primitive figures were drawn at 58 px/m and a person is small — with
    # a two-legged rig whose idle is a breath rather than grazing.
    "villager": {"height": 1.72, "person": True, "ppm": 56},
    "herd-boy": {"height": 1.25, "person": True, "ppm": 56},
    "field-hand": {"height": 1.2, "person": True, "ppm": 56},
    "carrier": {"height": 1.95, "person": True, "ppm": 56},
    "elder": {"height": 1.68, "person": True, "ppm": 56},
    "hunter": {"height": 1.72, "person": True, "ppm": 56},
    "guineafowl": {"length": 0.55, "stand": 0.55, "ortho": 1.3, "target": 0.28, "size": 64, "legs": 2, "belly": 0.28},
}

ANIMATIONS = {"idle": 4, "walk": 8, "run": 8}

# Pixels per metre every mesh-built animal renders at, so they agree with each other and
# sit within the range the primitive sprites used (37 to 58).
PIXELS_PER_METRE = 40.0


def framing(obj: bpy.types.Object, ppm: float = PIXELS_PER_METRE) -> dict:
    """
    The camera for this animal, from its own size rather than a table.

    A generated model stands in whatever pose the reference had — the zebra came back
    with its head up and ran out of a frame set by hand for a primitive one — so the
    frame is made from the mesh: wide enough for its full length turned any way, tall
    enough for its head, with room for a stride and a raised neck. The resolution follows
    from PIXELS_PER_METRE.
    """
    points = world_vertices(obj)
    # The 98th percentile rather than the farthest point: a generated mesh carries the
    # odd stray vertex well clear of the animal, and framing to it put the elephant in a
    # corner of a frame four times its size.
    radii = sorted(math.sqrt(p.x * p.x + p.y * p.y) for p in points)
    heights = sorted(p.z for p in points)
    reach = radii[int(len(radii) * 0.98)]
    height = heights[int(len(heights) * 0.99)]
    ortho = max(2.3 * reach, 2.0 * height) * 1.12
    size = int(round(ortho * ppm / 8) * 8)
    return {"ortho": size / ppm, "target": height * 0.48, "size": size}
# More than a sprite strictly needs: collapsing a reconstructed mesh much further tears
# holes in it, which render as dark cracks.
TARGET_FACES = 24000


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


def pad_islands(image: bpy.types.Image, passes: int = 12) -> None:
    """
    Grow each UV island's colour out into the empty texture around it.

    The bake packs the hide into hundreds of small islands on black, and sampling at
    sprite size reaches across island edges into that black: the elephant came out
    covered in dark specks. Pushing each island's edge colour outward a pixel a pass —
    edge padding, as any game texture gets — leaves nothing dark to reach. Numpy ships
    with Blender.
    """
    import numpy as np

    width, height = image.size
    rgba = np.array(image.pixels[:], dtype=np.float32).reshape(height, width, 4)
    colour = rgba[..., :3]
    # Island pixels are the ones the bake wrote; the background is black.
    filled = colour.max(axis=2) > 0.02
    for _ in range(passes):
        total = np.zeros_like(colour)
        count = np.zeros((height, width), dtype=np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted_fill = np.roll(filled, (dy, dx), axis=(0, 1))
            shifted = np.roll(colour, (dy, dx), axis=(0, 1))
            total += shifted * shifted_fill[..., None]
            count += shifted_fill
        grow = (~filled) & (count > 0)
        colour[grow] = total[grow] / count[grow][:, None]
        filled = filled | grow
    rgba[..., :3] = colour
    rgba[..., 3] = 1.0
    image.pixels[:] = rgba.ravel()


def clean(obj: bpy.types.Object) -> None:
    """
    Weld, face outward, shade smooth. Reconstructed meshes carry duplicate vertices and
    inward-facing patches, which rendered as dark cracks across an untextured elephant.
    """
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.0005)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.shade_smooth()


def import_mesh(path: str, texture: str, up: str, saturation: float = 1.0, value: float = 1.0) -> bpy.types.Object:
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
        pad_islands(image.image)
        # Colour correction in the shader rather than on the pixels, so the texture file
        # the model produced stays exactly as it was.
        adjust = nodes.new("ShaderNodeHueSaturation")
        adjust.inputs["Saturation"].default_value = saturation
        adjust.inputs["Value"].default_value = value
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


def normalise(obj: bpy.types.Object, length: float, height: float = 0.0, stand: float = 0.0) -> None:
    """
    Feet on the ground at the origin, head toward +X, nose to rump `length` metres — or,
    for a person, standing `height` metres and facing +X.

    A person's long horizontal axis is shoulder to shoulder, not front to back, so they
    are turned three quarters further than an animal: the reference faces the viewer,
    and TripoSR keeps that facing as -X after the principal-axis turn.
    """
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

    if height > 0:
        # Shoulders on X after that turn; three quarters of a turn puts them across and
        # facing +X. (A quarter turn faced every person away from the camera — the
        # reference looks at the viewer, and TripoSR keeps that as -X.)
        obj.rotation_euler.z += math.pi * 1.5
        apply_transform(obj)
        points = world_vertices(obj)
        scale = height / (max(p.z for p in points) - min(p.z for p in points))
        obj.scale = (scale, scale, scale)
        apply_transform(obj)
        points = world_vertices(obj)
        centre_x = sum(p.x for p in points) / len(points)
        centre_y = sum(p.y for p in points) / len(points)
        obj.location = (-centre_x, -centre_y, -min(p.z for p in points))
        apply_transform(obj)
        return

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
    # Length and height each to the real animal, not one scale for both. Image-to-3D
    # underestimates depth from a near-frontal reference: scaled by length alone the
    # elephant stood 4.5 m tall (a real one, about 3.4) and the zebra was similarly
    # stubby. Width follows the mean of the two.
    if stand > 0:
        tall = stand / (max(p.z for p in points) - min(p.z for p in points))
        obj.scale = (scale, (scale + tall) / 2, tall)
    else:
        obj.scale = (scale, scale, scale)
    apply_transform(obj)
    points = world_vertices(obj)
    centre_x = (min(p.x for p in points) + max(p.x for p in points)) / 2
    centre_y = (min(p.y for p in points) + max(p.y for p in points)) / 2
    floor = min(p.z for p in points)
    obj.location = (-centre_x, -centre_y, -floor)
    apply_transform(obj)


def drop_ground(obj: bpy.types.Object, share: float = 0.025) -> None:
    """
    Delete what lies flat on the ground: a shadow in the reference photograph comes back
    from the model as a plate under the feet. Everything in the bottom 2.5% of the
    height goes — a hoof loses a sliver, a plate is gone entirely.
    """
    points = [v.co for v in obj.data.vertices]
    top = max(p.z for p in points)
    cut = top * share
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    doomed = [v for v in mesh.verts if v.co.z < cut]
    bmesh.ops.delete(mesh, geom=doomed, context="VERTS")
    mesh.to_mesh(obj.data)
    mesh.free()
    # Stand what is left back on the ground.
    obj.location.z -= min(v.co.z for v in obj.data.vertices)
    apply_transform(obj)


def decimate(obj: bpy.types.Object) -> None:
    faces = len(obj.data.polygons)
    if faces <= TARGET_FACES:
        return
    modifier = obj.modifiers.new("decimate", "DECIMATE")
    modifier.ratio = TARGET_FACES / faces
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def find_legs(points: list, count: int, belly_share: float) -> dict:
    """
    The leg columns, from the vertices below the belly.

    Below `belly` there is nothing but legs, so splitting what is there by front/back and
    left/right finds them — robust to a mesh that is noisy everywhere else, which is the
    kind this has to take. Two legs (a bird) split left/right only. Where the belly sits
    is per species: a hippo's is a quarter of its height, an ostrich's well over a third.
    """
    height = max(p.z for p in points)
    belly = height * belly_share
    low = [p for p in points if p.z < belly]
    legs = {}
    if count == 2:
        mid_y = sorted(p.y for p in low)[len(low) // 2]
        for side, left in (("l", True), ("r", False)):
            column = [p for p in low if (p.y > mid_y) == left] or low
            legs[f"leg_{side}"] = mathutils.Vector(
                (sum(p.x for p in column) / len(column), sum(p.y for p in column) / len(column), 0.0)
            )
        return {"legs": legs, "height": height, "belly": belly}
    mid_x = (min(p.x for p in low) + max(p.x for p in low)) / 2
    for pair, front in (("fore", True), ("hind", False)):
        side_points = [p for p in low if (p.x > mid_x) == front]
        mid_y = sorted(p.y for p in side_points)[len(side_points) // 2]
        for side, left in (("l", True), ("r", False)):
            column = [p for p in side_points if (p.y > mid_y) == left] or side_points
            cx = sum(p.x for p in column) / len(column)
            cy = sum(p.y for p in column) / len(column)
            legs[f"{pair}_{side}"] = mathutils.Vector((cx, cy, 0.0))
    return {"legs": legs, "height": height, "belly": belly}


def rig(obj: bpy.types.Object, spec: dict) -> bpy.types.Object:
    points = world_vertices(obj)
    found = find_legs(points, spec.get("legs", 4), spec.get("belly", 0.34))
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

    if "fore_l" in legs:
        fore_x = (legs["fore_l"].x + legs["fore_r"].x) / 2
        hind_x = (legs["hind_l"].x + legs["hind_r"].x) / 2
    else:
        # A bird: the body spans either side of the legs it stands on.
        stance = (legs["leg_l"].x + legs["leg_r"].x) / 2
        fore_x = stance + (max_x - stance) * 0.35
        hind_x = stance - (stance - min_x) * 0.35
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


def rig_person(obj: bpy.types.Object) -> bpy.types.Object:
    """
    Two legs and a body. Arms and whatever is in the hands move with the body.

    A person's arms cannot be found from a mesh the way legs can — they hang against the
    body, cross it, hold a hoe or carry a load — and a scripted weighting that guessed
    wrong would tear them. So the rig is legs below the hips, and everything above rides
    one body bone that bobs with the stride. Fifty pixels tall, the legs are what say
    "walking".
    """
    points = world_vertices(obj)
    height = max(p.z for p in points)
    hips = height * 0.46
    low = [p for p in points if p.z < hips * 0.8]
    mid_y = sorted(p.y for p in low)[len(low) // 2] if low else 0.0
    feet = {}
    for side, left in (("l", True), ("r", False)):
        column = [p for p in low if (p.y > mid_y) == left] or low
        feet[side] = mathutils.Vector((sum(p.x for p in column) / len(column), sum(p.y for p in column) / len(column), 0.0))

    data = bpy.data.armatures.new("rig")
    armature = bpy.data.objects.new("rig", data)
    bpy.context.scene.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    body = data.edit_bones.new("body")
    body.head = (0, 0, hips)
    body.tail = (0, 0, height)
    for side, foot in feet.items():
        upper = data.edit_bones.new(f"leg_{side}_upper")
        upper.head = (foot.x, foot.y, hips)
        upper.tail = (foot.x, foot.y, hips * 0.5)
        upper.parent = body
        lower = data.edit_bones.new(f"leg_{side}_lower")
        lower.head = upper.tail.copy()
        lower.tail = (foot.x, foot.y, 0.0)
        lower.parent = upper
        lower.use_connect = True
    bpy.ops.object.mode_set(mode="OBJECT")

    groups = {name: obj.vertex_groups.new(name=name) for name in ("body", "leg_l_upper", "leg_l_lower", "leg_r_upper", "leg_r_lower")}
    for vertex in obj.data.vertices:
        p = vertex.co
        if p.z > hips:
            groups["body"].add([vertex.index], 1.0, "REPLACE")
            continue
        side = "l" if p.y > mid_y else "r"
        part = "upper" if p.z > hips * 0.5 else "lower"
        # A long blend into the body from the hip to the knee. Skirts and aprons hang
        # there, and weighted wholly to one leg they fanned out sideways with the stride.
        share = min(1.0, (hips - p.z) / (hips * 0.5)) ** 1.5
        groups[f"leg_{side}_{part}"].add([vertex.index], share, "REPLACE")
        if share < 1.0:
            groups["body"].add([vertex.index], 1.0 - share, "REPLACE")

    modifier = obj.modifiers.new("rig", "ARMATURE")
    modifier.object = armature
    obj.parent = armature
    return armature


def animate_person(armature: bpy.types.Object, anim: str, frames: int) -> None:
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frames
    body = armature.pose.bones["body"]
    for frame in range(1, frames + 1):
        phase = (frame - 1) / frames * math.tau
        if anim == "idle":
            # Weight shifting from foot to foot: the body sways a little, the legs stay.
            body.location = (0, 0, 0)
            pose(armature, "body", math.radians(1.5) * math.sin(phase))
            for side in ("l", "r"):
                pose(armature, f"leg_{side}_upper", 0)
                pose(armature, f"leg_{side}_lower", 0)
        else:
            # Gentler than an animal's: at 20 degrees and a 30-degree knee the lower leg
            # kicked out behind flat to the ground.
            reach = math.radians(18 if anim == "run" else 13)
            for side, offset in (("l", 0), ("r", math.pi)):
                pose(armature, f"leg_{side}_upper", reach * math.sin(phase + offset))
                fold = max(0.0, math.sin(phase + offset + math.pi / 2)) * math.radians(14)
                pose(armature, f"leg_{side}_lower", -fold)
            # The body rises over each step and leans a touch into the walk.
            body.location = (0, abs(math.sin(phase)) * 0.02, 0)
            pose(armature, "body", math.radians(-3))
        for bone in armature.pose.bones:
            bone.keyframe_insert("rotation_quaternion", frame=frame)
        body.keyframe_insert("location", frame=frame)


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
    names = {bone.name for bone in armature.pose.bones}
    # Diagonal pairs for four legs; two legs simply alternate.
    gait = (
        (("leg_l", 0), ("leg_r", math.pi))
        if "leg_l_upper" in names
        else (("fore_l", 0), ("hind_r", 0), ("fore_r", math.pi), ("hind_l", math.pi))
    )
    for frame in range(1, frames + 1):
        phase = (frame - 1) / frames * math.tau
        if anim == "idle":
            # Head down to graze and a little up again; legs still.
            pose(armature, "neck", math.radians(38 + 10 * math.sin(phase)))
            for leg, _ in gait:
                pose(armature, f"{leg}_upper", 0)
                pose(armature, f"{leg}_lower", 0)
            pose(armature, "tail", math.radians(6 * math.sin(phase * 2)))
        else:
            fast = anim == "run"
            reach = math.radians(28 if fast else 16)
            for leg, offset in gait:
                swing = reach * math.sin(phase + offset)
                pose(armature, f"{leg}_upper", swing)
                # The lower leg folds on the way forward and straightens to take weight.
                fold = max(0.0, math.sin(phase + offset + math.pi / 2)) * math.radians(35 if fast else 22)
                # Knees bend back on the forelegs, hocks forward on the hind and on a bird.
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
    obj = import_mesh(args.mesh, args.texture, args.up, spec.get("saturation", 1.0), spec.get("value", 1.0))
    clean(obj)
    normalise(obj, spec.get("length", 0.0), spec.get("height", 0.0), spec.get("stand", 0.0))
    # People stand on the floor shadow of the photograph, which is not quite flat: a thin
    # line of it survived 2.5%.
    drop_ground(obj, 0.05 if spec.get("person") else 0.025)
    decimate(obj)
    frame = framing(obj, spec.get("ppm", PIXELS_PER_METRE))
    armature = rig_person(obj) if spec.get("person") else rig(obj, spec)
    root = bpy.data.objects.new("root", None)
    bpy.context.scene.collection.objects.link(root)
    armature.parent = root
    return root, armature, frame


def main() -> None:
    args = parse_args()
    spec = SPECIES[args.kind]
    renderer = load_renderer() if args.render else None
    origin = None
    written = 0

    animations = {"idle": 8, "walk": 8} if spec.get("person") else ANIMATIONS
    for anim, frames in animations.items():
        root, armature, frame = build(args)
        spec = {**spec, **frame}
        if spec.get("person"):
            animate_person(armature, anim, frames)
        else:
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
