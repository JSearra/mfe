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

# Set per build() call; the thatch-course and doorway helpers read them. Declared here
# so the module is legible without having to find where they are assigned.
BANDING = None
SHADOW = None

KINDS = (
    "isibaya",
    "umuzi",
    "grain-store",
    "ikhanda",
    "indlunkulu",
    "umgodi",
    "isiziba",
    "goat-fold",
    "hunters-camp",
)
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


def thatch_courses(root, radius, height, band, location=(0.0, 0.0, 0.0), courses=8):
    """
    The horizontal grass courses that run round a beehive hut.

    This is the single most recognisable thing about an iQhugwane and the domes had
    none of it: photographs of them show strong horizontal banding all the way up,
    from the courses of grass themselves and from the braided rope that binds each one
    down. Without it a beehive hut is a smooth shell, which is what ours were — closer
    to a plastic bowl than to thatch.

    Each ring sits on the dome's own profile, so they hug the surface rather than
    floating off it: at a fraction `t` of the way to the apex the surface is at
    `sin(t·π/2)` of the height and `cos(t·π/2)` of the radius.

    Eight thin ones rather than six fat ones. The first pass used a minor radius of
    0.052 of the hut and they read as stacked tyres — a hoop standing proud of the shell
    rather than a course lying in it. Thatch banding is a shadow line, so what is wanted
    is many shallow ones.
    """
    for i in range(courses):
        t = (i + 0.5) / courses
        ring_radius = math.cos(t * math.pi / 2) * radius
        # Too small to read, and a torus that tight renders as a blob at the apex.
        if ring_radius < radius * 0.18:
            continue
        bpy.ops.mesh.primitive_torus_add(
            major_radius=ring_radius,
            minor_radius=radius * 0.032,
            major_segments=20,
            minor_segments=6,
            location=(location[0], location[1], location[2] + math.sin(t * math.pi / 2) * height),
        )
        ring = bpy.context.active_object
        ring.name = f"course_{i}"
        ring.data.materials.append(band)
        ring.parent = root


def doorway(root, radius, facing, dark, location=(0.0, 0.0, 0.0)):
    """
    The low entrance.

    Deliberately low: the door of an iQhugwane is small enough to stoop through, which
    holds the heat in and controls who comes in and how. At this size it is one dark
    notch, and a dark notch is most of what tells a viewer which way a hut faces.
    """
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=12,
        radius=radius * 0.26,
        # Shallow, so it breaks the shell as a notch rather than sticking out of it as
        # a spout. A door is four pixels at the size this is actually seen.
        depth=radius * 0.25,
        location=(
            location[0] + math.cos(facing) * radius * 0.91,
            location[1] + math.sin(facing) * radius * 0.91,
            location[2] + radius * 0.24,
        ),
        rotation=(math.pi / 2, 0.0, facing),
    )
    door = bpy.context.active_object
    door.name = "door"
    door.data.materials.append(dark)
    door.parent = root


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

        # Taller than it was. References for the iQhugwane describe it as notably
        # taller than wide; ours was 0.85 of its own radius, which is a squashed bowl.
        hut = dome(f"hut_{i}", HUT_RADIUS, HUT_RADIUS * 1.05, (x, y, 0.02))
        hut.data.materials.append(thatch)
        hut.parent = root
        thatch_courses(root, HUT_RADIUS, HUT_RADIUS * 1.05, BANDING, (x, y, 0.02))
        # Doors face the yard, which is what a homestead's huts actually do.
        doorway(root, HUT_RADIUS, angle + math.pi, SHADOW, (x, y, 0.02))


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


# --- the three added with Part II of the roadmap ------------------------------------
#
# The brief at the top of this file is that they differ in OUTLINE before they differ in
# detail, because at forty pixels the outline is all there is. The five that came before
# are a wide low ring, a cluster of domes, a small drum on legs, a large compound and a
# great house — all of them ROUND and all of them standing up off the ground. So:
#
#   umgodi     flat. The only thing on the map with no height at all: a rim of spoil
#              around a dark mouth. Read by its absence rather than its mass.
#   isiziba    linear. The only straight thing on the map, laid across a watercourse
#              rather than sitting on a patch of ground.
#   goat-fold  square. A pen with corners, against a kraal that is a circle — which is
#              the one distinction that has to survive, because a small round pen and a
#              large round pen at this size are the same picture.


def build_umgodi(root, stage, thatch, timber, earth):
    """
    The grain pit: a mouth in the ground with its spoil heaped around it.

    Deliberately the flattest thing in the catalogue. Everything else here stands up off
    the ground and this one goes into it, so at tile size it is told apart by having no
    silhouette to speak of — a dark disc inside a pale ring.
    """
    spoil = material("spoil", (0.115, 0.080, 0.046))
    void = material("void", (0.022, 0.016, 0.010))
    # Darker than it looks like it should be. These values are LINEAR and the render is
    # sRGB-encoded on the way out, so a mid grey here leaves as pale concrete — the same
    # trap the note above `build()` records for the thatch and timber.
    stone = material("capstone", (0.048, 0.043, 0.037))

    # The ring of excavated earth. Always present: a dug pit is a dug pit from the first
    # day, and the spoil is what says so from above.
    bpy.ops.mesh.primitive_torus_add(
        major_radius=0.78, minor_radius=0.22, major_segments=22, minor_segments=8,
        location=(0, 0, 0.10),
    )
    rim = bpy.context.active_object
    rim.name = "rim"
    rim.scale = (1.0, 1.0, 0.45)
    rim.data.materials.append(spoil)
    rim.parent = root

    if stage == 0:
        return

    # The mouth. Sunk slightly so the rim reads as standing proud of it.
    mouth = cylinder("mouth", 0.62, 0.10, (0, 0, 0.0), verts=20)
    mouth.data.materials.append(void)
    mouth.parent = root

    if stage == 1:
        return

    # Sealed: the capstone laid over, which is the whole of why a pit keeps grain where
    # a basket does not. Offset a little, so it reads as a lid rather than as a floor.
    cap = cylinder("cap", 0.56, 0.09, (0.06, 0.04, 0.11), verts=14)
    cap.data.materials.append(stone)
    cap.parent = root

    # Stones weighting it down. THREE and irregular, not two and symmetric: two round
    # stones either side of a disc read as a pair of eyes, which is exactly what the
    # first render of this came out looking like.
    for i, (x, y, r) in enumerate(((0.30, -0.20, 0.13), (-0.24, 0.20, 0.10), (0.05, 0.31, 0.08))):
        weight = dome(f"weight_{i}", r, 0.07, (x, y, 0.13))
        weight.data.materials.append(stone)
        weight.parent = root


def build_isiziba(root, stage, thatch, timber, earth):
    """
    The weir: a low wall laid across a watercourse, and the pool it holds.

    The only straight thing in the catalogue. Everything else is built on a patch of
    ground and is round; this one is built ACROSS something and is a bar, which is the
    whole of how it is told apart at tile size.
    """
    stone = material("weir-stone", (0.068, 0.062, 0.055))
    # Held water, not open water: duller and browner than the river the renderer paints,
    # because a weir pool is a few inches of it over mud.
    water = material("held-water", (0.024, 0.040, 0.044), roughness=0.3)

    length = 2.9

    # Stakes driven in a line: the first thing anyone does, and the stage-0 read.
    stakes = 5 if stage == 0 else 9
    for i in range(stakes):
        t = (i / max(stakes - 1, 1)) - 0.5
        stake = cylinder(
            f"stake_{i}", 0.055, 0.55 if stage == 0 else 0.34,
            (t * length, 0.0, 0.27 if stage == 0 else 0.17), verts=6,
        )
        stake.data.materials.append(timber)
        stake.parent = root

    if stage == 0:
        return

    # The wall itself, packed stone between the stakes.
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.22 if stage == 1 else 0.30))
    wall = bpy.context.active_object
    wall.name = "wall"
    # A size-1 cube spans -0.5..0.5, so scaling by S gives a total extent of S rather
    # than 2S. The first pass halved every one of these and the wall stopped a third of
    # the way along its own line of stakes.
    wall.scale = (length, 0.30, 0.22 if stage == 1 else 0.30)
    wall.data.materials.append(stone)
    wall.parent = root

    if stage == 1:
        return

    # The pool standing behind it. Upstream only — water on both sides would read as a
    # bridge rather than as something holding water back.
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0.88, 0.11))
    pool = bpy.context.active_object
    pool.name = "pool"
    pool.scale = (length * 0.92, 1.30, 0.06)
    pool.data.materials.append(water)
    pool.parent = root

    # The furrow leading off. It is what makes the weir agricultural rather than
    # structural: the point is not the wall, it is the water reaching the fields.
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(length * 0.40, -0.70, 0.10))
    furrow = bpy.context.active_object
    furrow.name = "furrow"
    furrow.scale = (0.16, 1.15, 0.05)
    furrow.data.materials.append(water)
    furrow.parent = root


def build_goat_fold(root, stage, thatch, timber, earth):
    """
    The small-stock fold: a square brush pen with a lean-to in one corner.

    SQUARE, and that is the only decision here that matters. A goat fold is a small
    cattle kraal in every respect a modeller would care about, and at forty pixels a
    small round pen and a large round pen are the same picture — so the fold has corners
    and the kraal does not, and the two can never be confused however far the camera
    pulls back.
    """
    half = 1.35

    floor = cylinder("floor", half * 1.42, 0.05, (0, 0, 0.025), verts=4)
    floor.rotation_euler = (0, 0, math.pi / 4)
    floor.data.materials.append(earth)
    floor.parent = root

    if stage == 0:
        return

    # Corner posts first, then the runs between them: a fence is built as a frame.
    height = 0.95 if stage == 2 else 0.5
    for i in range(4):
        angle = (i / 4) * math.tau + math.pi / 4
        post = cylinder(
            f"corner_{i}", 0.09, height + 0.14,
            (math.cos(angle) * half * 1.42, math.sin(angle) * half * 1.42, (height + 0.14) / 2),
            verts=6,
        )
        post.data.materials.append(timber)
        post.parent = root

    if stage == 1:
        return

    # Four straight runs of packed thorn. Cubes rather than a torus, which is what
    # keeps the corners sharp — a rounded fence is a kraal again.
    for i in range(4):
        angle = (i / 4) * math.tau
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(
            math.cos(angle) * half, math.sin(angle) * half, height * 0.43,
        ))
        run = bpy.context.active_object
        run.name = f"run_{i}"
        run.rotation_euler = (0, 0, angle)
        # The side of a square whose circumradius is half*1.42 is half*2.0, and a
        # size-1 cube's extent is its scale rather than twice it. Getting either of
        # those wrong leaves the fence short of its own corner posts, which is what the
        # first render did.
        run.scale = (0.16, half * 2.0, height * 0.86)
        run.data.materials.append(thatch)
        run.parent = root

    # The lean-to the stock shelter under. One sloped slab in a corner: it is the only
    # thing standing above the fence line and it says "kept animals" rather than "pen".
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(half * 0.58, half * 0.58, 0.80))
    roof = bpy.context.active_object
    roof.name = "lean-to"
    roof.rotation_euler = (0, -0.42, math.pi / 4)
    roof.scale = (1.15, 1.30, 0.07)
    roof.data.materials.append(thatch)
    roof.parent = root


def build_hunters_camp(root, stage, thatch, timber, earth):
    """
    The hunters' camp (ADR-0022): a drying rack with hides on it, and a brush shelter.

    The RACK is the read. Every other building on the map is a round or square thing of
    thatch; this is the one that stands up as a frame with pale rectangles stretched in
    it, which is what drying skins look like from anywhere, and it says what the place
    is for — what comes back from the hunt is hung here.
    """
    floor = cylinder("floor", 1.55, 0.05, (0, 0, 0.025), verts=10)
    floor.data.materials.append(earth)
    floor.parent = root

    if stage == 0:
        return

    # The rack: two A-frames and a ridge pole, on the far side so the shelter is in
    # front of it from the camera.
    # Each pole runs from its foot to the apex, so the pair meets under the ridge. The
    # first pass leaned them by eye and they missed it by a hand's breadth either side.
    rack_x = -0.35
    apex = 1.85
    for end, y in (("a", 0.85), ("b", -0.85)):
        for lean, foot in (("in", 0.45), ("out", -0.45)):
            span = math.sqrt(foot * foot + apex * apex)
            pole = cylinder(f"pole_{end}_{lean}", 0.045, span, (rack_x + foot / 2, y, apex / 2), verts=6)
            pole.rotation_euler = (0, math.atan2(-foot, apex), 0)
            pole.data.materials.append(timber)
            pole.parent = root
    ridge = cylinder("ridge", 0.04, 1.9, (rack_x, 0, apex), (math.pi / 2, 0, 0), verts=6)
    ridge.data.materials.append(timber)
    ridge.parent = root

    if stage == 1:
        return

    hide = material("hide", (0.52, 0.38, 0.22))
    hide_dark = material("hide_dark", (0.3, 0.19, 0.09))
    # Two hides hung over the ridge, pale and dark, so they read as two things.
    for index, (y, mat) in enumerate(((0.38, hide), (-0.4, hide_dark))):
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(rack_x + 0.02, y, 1.28))
        skin = bpy.context.active_object
        skin.name = f"skin_{index}"
        skin.scale = (0.05, 0.68, 0.95)
        skin.rotation_euler = (0, math.radians(8), 0)
        skin.data.materials.append(mat)
        skin.parent = root

    # The shelter: a low half-dome of brush in front of the rack.
    # A true dome: the sphere's lower half pressed flat. Sunk into the ground instead, it
    # bulged out under the floor's front edge, which the camera looks straight at.
    shelter = dome("shelter", 0.7, 0.62, (0.5, 0.35, 0.0))
    for vertex in shelter.data.vertices:
        if vertex.co.z < 0:
            vertex.co.z = 0
    shelter.data.materials.append(thatch)
    shelter.parent = root

    # A fire ring, and spears leaning on the rack.
    for i in range(6):
        angle = i / 6 * math.tau
        stone = cylinder(f"stone_{i}", 0.06, 0.08, (0.65 + math.cos(angle) * 0.22, -0.55 + math.sin(angle) * 0.22, 0.04), verts=5)
        stone.data.materials.append(material("stone", (0.12, 0.11, 0.1)))
        stone.parent = root
    ash = cylinder("ash", 0.16, 0.03, (0.65, -0.55, 0.02), verts=8)
    ash.data.materials.append(SHADOW)
    ash.parent = root
    for i in range(3):
        spear = cylinder(f"spear_{i}", 0.018, 1.7, (rack_x + 0.45, -0.1 + i * 0.12, 0.85), (0, math.radians(-18), 0), verts=5)
        spear.data.materials.append(timber)
        spear.parent = root


def build_ikhanda(root, stage, thatch, timber, earth):
    """
    A military homestead: a ring of houses around its own enclosure, and bigger.

    Read against the umuzi at tile size, the difference has to be scale and ORDER — an
    ikhanda is laid out, not grown. So the huts are evenly spaced on a true ring with a
    palisade behind them, where the umuzi's sit at a scatter of distances.
    """
    radius = 3.1
    yard = cylinder("yard", radius * 0.62, 0.06, (0, 0, 0.03), verts=24)
    yard.data.materials.append(earth)
    yard.parent = root

    if stage == 0:
        for i in range(8):
            angle = (i / 8) * math.tau
            post = cylinder(
                f"peg_{i}", 0.07, 0.4,
                (math.cos(angle) * radius, math.sin(angle) * radius, 0.2), verts=6,
            )
            post.data.materials.append(timber)
            post.parent = root
        return

    huts = 5 if stage == 1 else 9
    for i in range(huts):
        angle = (i / huts) * math.tau
        hut_radius = HUT_RADIUS * 1.05
        hut_height = HUT_RADIUS * 1.0
        at = (math.cos(angle) * radius * 0.78, math.sin(angle) * radius * 0.78, 0.02)
        hut = dome(f"hut_{i}", hut_radius, hut_height, at)
        hut.data.materials.append(thatch)
        hut.parent = root
        # The same thatched courses. An ikhanda is a homestead laid out like any other,
        # larger and around the king's authority rather than a family's — the huts in it
        # are the same iQhugwane.
        thatch_courses(root, hut_radius, hut_height, BANDING, at)
        doorway(root, hut_radius, angle + math.pi, SHADOW, at)

    if stage < 2:
        return

    # The palisade. A regiment's homestead is enclosed; a family's is not.
    for i in range(26):
        angle = (i / 26) * math.tau
        post = cylinder(
            f"pale_{i}", 0.075, 1.25,
            (math.cos(angle) * radius, math.sin(angle) * radius, 0.62), verts=6,
        )
        post.data.materials.append(timber)
        post.parent = root


def build_indlunkulu(root, stage, thatch, timber, earth):
    """
    The great house: one large dome on a swept platform, with a screened entrance.

    Deliberately a single mass rather than a cluster. It is the only structure in a
    homestead that stands alone and above, and at tile size one big dome beside the
    umuzi's several small ones is the fastest way to read which is which.
    """
    platform = cylinder("platform", 1.95, 0.12, (0, 0, 0.06), verts=24)
    platform.data.materials.append(earth)
    platform.parent = root

    if stage == 0:
        for rib in range(7):
            tilt = (rib / 7) * math.pi
            arc = cylinder(
                f"rib_{rib}", 0.035, 2.9, (0, 0, 0.85),
                rotation=(math.pi / 2, 0, tilt), verts=6,
            )
            arc.data.materials.append(timber)
            arc.parent = root
        return

    height = 1.05 if stage == 1 else 1.5
    hut = dome("great_house", 1.72, height, (0, 0, 0.08))
    # The indlunkulu is the biggest iQhugwane on the map rather than a different kind of
    # building, so it is coursed like the rest — with more of them, because it is larger
    # and the banding should stay roughly the same size on screen.
    thatch_courses(root, 1.72, height, BANDING, (0, 0, 0.08), courses=11)
    hut.data.materials.append(thatch)
    hut.parent = root

    if stage < 2:
        return

    # A screen across the doorway, which is where the entrance actually is on one of
    # these, and the one piece of asymmetry in an otherwise radial shape.
    screen = cylinder("screen", 0.95, 0.9, (1.55, 0, 0.45), verts=16)
    screen.data.materials.append(timber)
    screen.parent = root


BUILDERS = {
    "isibaya": build_isibaya,
    "umuzi": build_umuzi,
    "grain-store": build_grain_store,
    "ikhanda": build_ikhanda,
    "indlunkulu": build_indlunkulu,
    "umgodi": build_umgodi,
    "isiziba": build_isiziba,
    "goat-fold": build_goat_fold,
    "hunters-camp": build_hunters_camp,
}

FRAMING = {
    # kind: (ortho scale, camera target height)
    "isibaya": (8.4, 0.9),
    "umuzi": (6.6, 0.9),
    "grain-store": (3.4, 1.0),
    "ikhanda": (9.2, 1.0),
    "indlunkulu": (5.4, 1.0),
    # The pit is tiny and flat, so it is framed close or it would be four dark pixels.
    "umgodi": (2.6, 0.2),
    "isiziba": (4.2, 0.4),
    "goat-fold": (4.6, 0.6),
    "hunters-camp": (4.2, 0.9),
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
    # Warmer and lighter than it was. References for the iQhugwane describe golden-brown
    # to tan thatch; 0.20/0.13/0.05 read as a flat mid brown with no straw in it.
    thatch = material("thatch", (0.27, 0.175, 0.062))
    timber = material("timber", (0.085, 0.052, 0.028))
    earth = material("earth", (0.125, 0.088, 0.052))

    # Module-level rather than threaded through eight builder signatures, and set fresh
    # on every call because `build` reads factory settings first and every material in
    # the file goes with the old scene. The helpers that need them reach for them here.
    global BANDING, SHADOW
    # The rope and the shadow under each grass course: the same thatch, darker, so the
    # banding reads as depth rather than as a painted stripe.
    BANDING = material("banding", (0.155, 0.098, 0.034))
    # A doorway is a hole. Nearly black, because at this size that is all it can be.
    SHADOW = material("shadow", (0.018, 0.013, 0.008))

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
