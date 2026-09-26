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

# Human proportions in Blender units, where 1.0 is about a metre.
#
# The first set had the hip at 0.52m on a 1.75m figure and gave arms and legs the same
# length, which is a toddler's proportions, not an adult's — and no amount of detail
# rescues a figure whose skeleton is wrong. A standing adult is about seven and a half
# heads tall, the hip sits a little over half the total height, and the arm is
# appreciably shorter than the leg.
HEIGHT = 1.78
HEAD = 0.235
NECK = 0.07
HIP_HEIGHT = 0.92
TORSO = 0.56
ARM = 0.70
LEG = HIP_HEIGHT
SHOULDER_WIDTH = 0.40

BIPEDS = {
    # name:        (skin,                  cloth,               shield,  has_spear)
    #
    # Skin was a mid-tan that, under a warm fill, came out the same value as the hide,
    # the cloth and the ground — everything beige. These are darker and more saturated so
    # the key light does the describing rather than the fill.
    "impi": ((0.21, 0.115, 0.070), (0.40, 0.27, 0.15), True, True),
    "herder": ((0.21, 0.115, 0.070), (0.55, 0.47, 0.33), False, True),
    "musketeer": ((0.26, 0.16, 0.11), (0.28, 0.26, 0.23), False, True),
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

# Mounted Griqua: a rider with a firearm, which is the whole of why they matter here.
# Horse rather than a bigger man — `Mounted` is a movement class with its own cost
# profile over slope and drift, and a unit that moves differently should look like it.
MOUNTED = {
    # name:       (hide,                  rider cloth)
    # Linear albedo, sRGB out. 0.30 here came back as pale grey the first time, which
    # is the same trap the building materials fell into. See make_building.py.
    "commando": ((0.16, 0.095, 0.055), (0.115, 0.10, 0.082)),
}

# Villagers: the people the game actually counts.
#
# The game counts households, and every figure on the map was the same soldier, so a
# village of sixty read as a barracks. These exist to break that, and they are built to
# ONE rule: they are told apart by silhouette, never by colour. At fifty pixels a recolour
# is not a variant, it is the same sprite. So each of these changes the outline in a way
# that survives being half the size of this paragraph's line height:
#
#   herd-boy    two thirds the height of a man, thin, one long vertical stick
#   field-hand  bent almost double, a low horizontal wedge with the head at a man's hip
#   carrier     a man's height plus a wide load on top, on a bell of a skirt
#   elder       broad cloaked shoulders and a diagonal staff planted ahead of the feet
#
# Grounding, per docs/CONTENT.md: herding is boys' work and a herd-boy carries a switch
# rather than a weapon; cultivation is hoe culture and it is women's work, with a
# short-handled iron hoe (isiZulu *igeja*); loads travel on the head over a coiled grass
# pad (*inkatha*); married women wear the *isidwaba*, a heavy pleated leather skirt, which
# is where the bell comes from; a married man wears the *isicoco*, a sewn headring. None
# of these names is user-facing here, so nothing is translated — the geometry is just
# geometry and the naming decision stays in CONTENT.md where it belongs.
#
# `stoop` is structural rather than animated, and that is a legibility decision over a
# realistic one. A field-hand who straightens up to walk to the next field is, for those
# seconds, a generic figure — and identity that switches off is not identity. She is
# always bent, and she is instantly hers at any moment of any frame.
VILLAGERS = {
    "herd-boy": {
        # A boy, not a small man: the head barely shrinks while the body does, which is
        # most of what the eye uses to read a child at any size.
        "stature": 0.70,
        "head_scale": 1.34,
        "build": 1.02,
        "stoop": 4.0,
        "skin": (0.20, 0.110, 0.068),
        "cloth": (0.115, 0.085, 0.060),
        "skirt": None,
        "prop": "stick",
        "stride": 26.0,
        "free_arm": "l",
        "ortho": 2.2,
        "target": 0.72,
    },
    "field-hand": {
        "stature": 0.96,
        "head_scale": 1.0,
        "build": 0.94,
        # Deep. A real hoeing stoop is nearer forty-five degrees, and at forty-five this
        # figure read as a man leaning, which is not a silhouette. Fifty-eight puts the
        # head at the height of an impi's hip and the spine near horizontal, and that
        # reads at any size.
        "stoop": 58.0,
        "skin": (0.20, 0.110, 0.068),
        "cloth": (0.075, 0.062, 0.055),
        # (hem radius, waist radius, length) of the isidwaba.
        "skirt": (0.27, 0.16, 0.50),
        "prop": "hoe",
        "stride": 16.0,
        "free_arm": None,
        "ortho": 2.5,
        "target": 0.55,
    },
    "carrier": {
        "stature": 0.97,
        "head_scale": 1.0,
        "build": 0.92,
        # Leaning back, because the load is in front of the spine's line and a carrier
        # who does not counterweight it falls over.
        "stoop": -6.0,
        "skin": (0.20, 0.110, 0.068),
        "cloth": (0.075, 0.062, 0.055),
        "skirt": (0.29, 0.17, 0.54),
        "prop": "headload",
        "stride": 13.0,
        "free_arm": "r",
        "ortho": 2.45,
        # The one kind that needs its own framing. A head-load tops out above two metres
        # and the figure camera holds 2.12 before it starts cutting heads off — which is
        # a defect this project has already shipped once. Aiming higher costs nothing:
        # `pixelsPerUnit` comes from the ortho scale alone, so raising the target moves
        # the recorded origin and not the drawn size.
        "target": 1.15,
    },
    # The villager with nothing in particular to do: walking to work, building, fishing,
    # standing about. The role code draws everyone without a role as this figure, and it
    # was the impi — isihlangu and stabbing spear — so after work began finding its own
    # people (Phase B2) most of a village going about its day was drawn as a regiment.
    # An upright man in the umutsha with empty hands, and the umqhele, the fur headband,
    # at the brow. Told apart from the impi by what is missing: the shield is the largest
    # thing in the soldier's outline, and this outline has none.
    "villager": {
        "stature": 1.0,
        "head_scale": 1.0,
        "build": 1.0,
        "stoop": 4.0,
        "skin": (0.20, 0.110, 0.068),
        "cloth": (0.105, 0.080, 0.058),
        "skirt": None,
        "prop": None,
        "stride": 24.0,
        "free_arm": "both",
        "ortho": 2.2,
        "target": 0.76,
    },
    "elder": {
        "stature": 0.92,
        "head_scale": 1.0,
        "build": 1.04,
        "stoop": 22.0,
        "skin": (0.19, 0.105, 0.066),
        "cloth": (0.105, 0.080, 0.058),
        "skirt": None,
        "prop": "staff",
        "stride": 11.0,
        "free_arm": "l",
        "ortho": 2.2,
        "target": 0.76,
    },
    # The hunter (ADR-0022): a man leaning into the stalk, with a pair of long throwing
    # spears slanting ahead of him. The slant is the silhouette — the herd-boy's switch
    # is vertical, the elder's staff planted, and nothing else on the map carries a long
    # line pointing forward and up.
    "hunter": {
        "stature": 1.0,
        "head_scale": 1.0,
        "build": 0.98,
        "stoop": 12.0,
        "skin": (0.19, 0.105, 0.066),
        "cloth": (0.16, 0.11, 0.06),
        "skirt": None,
        "prop": "spears",
        "stride": 22.0,
        "free_arm": "l",
        # Framed wider than the others: the spears reach higher and further than any
        # other figure's prop, and ran out of the top of a 2.2 frame and then out of the
        # sides of a 2.9 one on the two diagonals where they point across the screen.
        # A bigger frame rather than a wider camera alone, so the figure keeps its
        # resolution; `pixelsPerUnit` carries the difference to the renderer.
        "ortho": 4.0,
        "target": 1.0,
        "size": 176,
    },
}


# The veld's own animals (ADR-0022), built by one parametric quadruped plus a small bird
# rig, because fifteen hand-built models would never agree with each other about what a
# metre is. Proportions are real ones in metres — length of the barrel, depth of it, leg
# to the withers — so an elephant stands twice a cow and an impala half one, and the
# renderer needs no per-species scale: `pixelsPerUnit` carries it.
#
# Each is picked, like the vegetation, for the part of it that survives forty pixels:
# the elephant's ears and trunk, the kudu's spiral horns, the zebra's stripes, the
# wildebeest's front-heavy slope, the hippo's barrel on stumps, the lion's mane. Colour
# is chosen against the ochre veld first — the Nguni's first hide vanished into the dust,
# and these would too if they were painted true to a field guide.
#
# Keys in `feature` switch on the parts a species has; the builder ignores the rest.
WILD = {
    # name:      proportions (m)                          hide, belly/accent          features
    "elephant": {"length": 2.9, "depth": 1.45, "width": 1.1, "leg": 1.45, "leg_r": 0.2,
                 "hide": (0.075, 0.07, 0.066), "accent": (0.06, 0.056, 0.052),
                 "head": (0.8, 0.7, 0.8), "neck": 0.25, "size": 192, "ortho": 5.6, "target": 1.45,
                 "feature": {"trunk", "tusks"}},
    "kudu": {"length": 1.5, "depth": 0.58, "width": 0.38, "leg": 0.95, "leg_r": 0.045,
             "hide": (0.13, 0.085, 0.05), "accent": (0.7, 0.67, 0.6),
             "head": (0.34, 0.15, 0.17), "neck": 0.55, "size": 128, "ortho": 3.2, "target": 1.0,
             "feature": {"spiral", "stripes_thin", "ears_big"}},
    "impala": {"length": 1.0, "depth": 0.4, "width": 0.26, "leg": 0.62, "leg_r": 0.03,
               "hide": (0.26, 0.1, 0.035), "accent": (0.72, 0.66, 0.56),
               "head": (0.24, 0.1, 0.12), "neck": 0.34, "size": 96, "ortho": 2.2, "target": 0.7,
               "feature": {"lyre", "ears"}},
    "eland": {"length": 1.95, "depth": 0.78, "width": 0.52, "leg": 0.9, "leg_r": 0.06,
              "hide": (0.2, 0.12, 0.06), "accent": (0.5, 0.42, 0.3),
              "head": (0.38, 0.17, 0.2), "neck": 0.42, "size": 128, "ortho": 3.4, "target": 1.0,
              "feature": {"straight", "dewlap", "stripes_thin"}},
    "wildebeest": {"length": 1.55, "depth": 0.7, "width": 0.46, "leg": 0.78, "leg_r": 0.05,
                   "hide": (0.06, 0.06, 0.065), "accent": (0.025, 0.025, 0.025),
                   "head": (0.42, 0.18, 0.24), "neck": 0.3, "size": 128, "ortho": 3.0, "target": 0.85,
                   "feature": {"cow_horns", "mane", "beard", "slope"}},
    "zebra": {"length": 1.5, "depth": 0.62, "width": 0.42, "leg": 0.8, "leg_r": 0.05,
              "hide": (0.72, 0.7, 0.66), "accent": (0.02, 0.02, 0.02),
              "head": (0.44, 0.16, 0.2), "neck": 0.45, "size": 128, "ortho": 3.0, "target": 0.85,
              "feature": {"stripes", "mane", "ears"}},
    "warthog": {"length": 0.95, "depth": 0.46, "width": 0.36, "leg": 0.34, "leg_r": 0.04,
                "hide": (0.1, 0.075, 0.06), "accent": (0.05, 0.035, 0.025),
                "head": (0.36, 0.22, 0.22), "neck": 0.05, "size": 96, "ortho": 2.2, "target": 0.45,
                "feature": {"tusks_up", "mane", "tail_up"}},
    "buffalo": {"length": 2.0, "depth": 0.86, "width": 0.66, "leg": 0.72, "leg_r": 0.075,
                "hide": (0.03, 0.028, 0.028), "accent": (0.02, 0.02, 0.02),
                "head": (0.46, 0.26, 0.28), "neck": 0.2, "size": 128, "ortho": 3.4, "target": 0.85,
                "feature": {"boss", "hump"}},
    "hippo": {"length": 2.4, "depth": 1.0, "width": 0.95, "leg": 0.42, "leg_r": 0.14,
              "hide": (0.12, 0.085, 0.09), "accent": (0.34, 0.16, 0.15),
              "head": (0.7, 0.5, 0.42), "neck": 0.05, "size": 128, "ortho": 3.8, "target": 0.7,
              "feature": {"snout"}},
    "lion": {"length": 1.7, "depth": 0.56, "width": 0.4, "leg": 0.58, "leg_r": 0.07,
             "hide": (0.34, 0.2, 0.07), "accent": (0.46, 0.33, 0.17),
             "head": (0.34, 0.26, 0.26), "neck": 0.2, "size": 128, "ortho": 3.0, "target": 0.7,
             "feature": {"mane_lion", "tail_long", "cat"}},
    "leopard": {"length": 1.35, "depth": 0.42, "width": 0.3, "leg": 0.46, "leg_r": 0.05,
                "hide": (0.4, 0.24, 0.07), "accent": (0.02, 0.015, 0.012),
                "head": (0.24, 0.18, 0.18), "neck": 0.16, "size": 96, "ortho": 2.6, "target": 0.55,
                "feature": {"rosettes", "tail_long", "cat"}},
    "hyena": {"length": 1.2, "depth": 0.52, "width": 0.36, "leg": 0.6, "leg_r": 0.055,
              "hide": (0.22, 0.17, 0.1), "accent": (0.04, 0.03, 0.025),
              "head": (0.32, 0.2, 0.2), "neck": 0.2, "size": 96, "ortho": 2.6, "target": 0.7,
              "feature": {"spots", "slope", "ears_round", "mane"}},
    "baboon": {"length": 0.7, "depth": 0.36, "width": 0.3, "leg": 0.42, "leg_r": 0.05,
               "hide": (0.15, 0.13, 0.08), "accent": (0.1, 0.06, 0.04),
               "head": (0.24, 0.18, 0.18), "neck": 0.05, "size": 96, "ortho": 2.0, "target": 0.5,
               "feature": {"tail_hook", "muzzle_long"}},
    # The two birds: a body carried on two legs, and the rig is a bird's, not a quadruped's.
    "guineafowl": {"length": 0.46, "depth": 0.34, "width": 0.3, "leg": 0.2, "leg_r": 0.014,
                   "hide": (0.08, 0.09, 0.12), "accent": (0.85, 0.85, 0.9),
                   "head": (0.08, 0.07, 0.09), "neck": 0.14, "size": 64, "ortho": 1.3, "target": 0.3,
                   "feature": {"bird", "dots", "casque"}},
    "ostrich": {"length": 1.0, "depth": 0.7, "width": 0.62, "leg": 1.05, "leg_r": 0.04,
                "hide": (0.05, 0.045, 0.045), "accent": (0.86, 0.84, 0.8),
                "head": (0.14, 0.09, 0.1), "neck": 0.9, "size": 128, "ortho": 3.3, "target": 1.3,
                "feature": {"bird", "plumes"}},
}

KINDS = {**BIPEDS, **CATTLE, **MOUNTED, **VILLAGERS, **WILD}

# Horse proportions, metres. Longer in the leg and shallower in the barrel than a cow,
# which is most of what separates the two silhouettes at tile size.
HORSE_LENGTH = 1.55
HORSE_DEPTH = 0.56
HORSE_WIDTH = 0.40
HORSE_LEG = 0.88

# Cattle proportions, metres. A cow is longer than a man is tall and half his height at
# the withers, which is why it needs its own camera framing.
COW_LENGTH = 1.42
COW_DEPTH = 0.60
COW_WIDTH = 0.46
COW_LEG = 0.62

# "run" is the stampede. It exists for cattle first, but an impi that can only walk
# looks wrong next to one, so bipeds get it too.
ANIMATIONS = {"idle": 8, "walk": 12, "attack": 10, "run": 10}

# Villagers cost a third of what a soldier costs, deliberately.
#
# A soldier is four animations at eight directions plus two tinted overlay passes: 960
# frames of atlas for one man. A villager stands and walks and that is all, with no
# livery to overlay, which is 128 — and four villagers together still cost half of one
# impi. The saving is in the frame COUNT and in the animation LIST, not in the direction
# count, and the difference matters:
#
#   Frame counts are per kind in the atlas (`kinds[kind][anim]`), so cutting walk from
#   twelve frames to eight needs no renderer change at all. Eight frames at 1.25 ticks
#   each is a ten-tick stride, which is the same cadence as the impi's twelve-frame walk
#   read at the same speed — it is a coarser cycle, not a faster one.
#
#   The direction count is GLOBAL to the atlas (`pack_atlas` takes the maximum, and
#   entities.ts indexes every kind by it), so a four-direction villager would return a
#   null frame on the four directions it does not have and simply not draw. Four
#   directions is a renderer change, not an art one, and it is not worth making: these
#   walk across open ground at arbitrary angles and quarter-turn facing on a 2:1 diamond
#   reads as sliding sideways. Eight stays. `--mirror` still halves the RENDER, which is
#   the cost that is actually being paid on a laptop.
VILLAGER_ANIMATIONS = {"idle": 8, "walk": 8}

# The wild runs shorter still. Fifteen species at eight directions is a lot of atlas,
# and a grazing animal's idle is a head going down and coming up again: four frames say
# it. Walk and run keep eight, because a gait with fewer reads as a skip.
WILD_ANIMATIONS = {"idle": 4, "walk": 8, "run": 8}

# Which animations make sense for which kind. A cow does not thrust a spear, and a woman
# carrying a season's grain on her head does not break into a stampede.
KIND_ANIMATIONS = (
    {name: ("idle", "walk", "attack", "run") for name in BIPEDS}
    | {name: ("idle", "walk", "run") for name in CATTLE}
    | {name: ("idle", "walk", "attack", "run") for name in MOUNTED}
    | {name: ("idle", "walk") for name in VILLAGERS}
    | {name: ("idle", "walk", "run") for name in WILD}
)


def frame_count(kind: str, anim: str) -> int:
    """How many frames this kind's cycle runs for. Villagers run shorter cycles."""
    if kind in VILLAGERS:
        return VILLAGER_ANIMATIONS[anim]
    if kind in WILD:
        return WILD_ANIMATIONS[anim]
    return ANIMATIONS[anim]


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


def blob(
    name: str,
    size: tuple[float, float, float],
    location: tuple[float, float, float],
    smooth: bool = True,
    segments: int = 16,
    rings: int = 10,
):
    """
    An ellipsoid, smooth-shaded by default and faceted on request.

    Cattle were built from cubes and read as crates on legs. An animal is all curve, so
    smooth shading is right for them. It is NOT right for a man at forty pixels, and that
    took a second look to see: a smooth ellipsoid resolves to a soft gradient, and a
    figure assembled from soft gradients has no edges anywhere — which is exactly the
    complaint that it looks blobby. Facets give each plane its own value, and those
    survive the downscale when a gradient does not.
    """
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    if smooth:
        bpy.ops.object.shade_smooth()
    return obj


def taper(
    name: str,
    lower: float,
    upper: float,
    depth: float,
    location,
    rotation=(0.0, 0.0, 0.0),
    smooth: bool = True,
    verts: int = 12,
):
    """A truncated cone, for limbs and necks that should not be tubes."""
    bpy.ops.mesh.primitive_cone_add(
        vertices=verts, radius1=lower, radius2=upper, depth=depth, location=location
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rotation
    if smooth:
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


def build_wild(kind: str):
    """A wild animal standing on the origin, facing +X. Quadruped, or a bird on two legs."""
    spec = WILD[kind]
    features = spec["feature"]
    length, depth, width, leg_len = spec["length"], spec["depth"], spec["width"], spec["leg"]
    hide = material("hide", spec["hide"])
    accent = material("accent", spec["accent"])
    horn = material("horn", (0.12, 0.10, 0.08))
    ivory = material("ivory", (0.86, 0.80, 0.66))

    root = bpy.data.objects.new("wild", None)
    bpy.context.scene.collection.objects.link(root)
    back = leg_len + depth / 2

    if "bird" in features:
        return build_bird(kind, spec, root, hide, accent)

    body = blob("body", (length, width, depth), (0, 0, back))
    body.data.materials.append(hide)
    body.parent = root

    # Front-heavy animals: a deep chest and a back that falls to the tail. It is the
    # whole silhouette of a wildebeest or a hyena at tile size.
    if "slope" in features:
        chest = blob("chest", (length * 0.5, width * 1.08, depth * 1.2), (length * 0.2, 0, back + depth * 0.1))
        chest.data.materials.append(hide)
        chest.parent = root
    # Shoulder and haunch: the masses a leg hangs from. Without them every animal was an
    # ellipsoid on four sticks — a coffee table — and that is what the first pass read as.
    if "slope" not in features:
        shoulder = blob("shoulder", (length * 0.42, width * 1.06, depth * 1.02), (length * 0.24, 0, back - depth * 0.04))
        shoulder.data.materials.append(hide)
        shoulder.parent = root
    haunch = blob("haunch", (length * 0.42, width * 1.04, depth * 1.0), (-length * 0.26, 0, back - depth * 0.05))
    haunch.data.materials.append(hide)
    haunch.parent = root
    if "hump" in features:
        hump = blob("hump", (length * 0.36, width * 0.8, depth * 0.5), (length * 0.2, 0, back + depth * 0.34))
        hump.data.materials.append(hide)
        hump.parent = root

    # Pale belly on the antelope, the cheapest way to stop a body reading as one lump.
    if kind in ("kudu", "impala", "eland", "zebra", "lion", "leopard"):
        belly = blob("belly", (length * 0.7, width * 0.78, depth * 0.34), (0, 0, back - depth * 0.36))
        belly.data.materials.append(accent if kind != "zebra" else hide)
        belly.parent = root

    # --- markings, pressed onto the flank as flattened blobs (the cattle patches' trick)
    if "stripes" in features:
        # Bold, near vertical bands. Wide ones, because thin stripes average to grey
        # at forty pixels and a grey horse is not a zebra.
        for i in range(7):
            x = -length * 0.42 + i * length * 0.14
            band = blob(f"stripe_{i}", (length * 0.055, width * 1.04, depth * 1.02), (x, 0, back))
            band.rotation_euler = (0, math.radians(-12 if i < 4 else 14), 0)
            band.data.materials.append(accent)
            band.parent = root
    if "stripes_thin" in features:
        for i in range(4):
            x = -length * 0.2 + i * length * 0.12
            band = blob(f"stripe_{i}", (length * 0.025, width * 1.02, depth * 0.7), (x, 0, back + depth * 0.1))
            band.data.materials.append(accent)
            band.parent = root
    if "rosettes" in features or "spots" in features or "dots" in features:
        count = 14 if "rosettes" in features else 9
        for i in range(count):
            u = (i * 0.618) % 1.0
            v = (i * 0.382) % 1.0
            x = -length * 0.4 + u * length * 0.8
            z = back - depth * 0.25 + v * depth * 0.5
            spot = blob(f"spot_{i}", (length * 0.07, width * 1.03, depth * 0.12), (x, 0, z))
            spot.data.materials.append(accent)
            spot.parent = root

    # --- neck and head, on a pivot so the gait can drop it to graze -----------------
    neck_pivot = bpy.data.objects.new("neck", None)
    bpy.context.scene.collection.objects.link(neck_pivot)
    neck_pivot.location = (length * 0.42, 0, back + depth * 0.2)
    neck_pivot.parent = root
    neck_len = spec["neck"]
    hx, hy, hz = spec["head"]
    if neck_len > 0.1:
        neck = taper("neck_mesh", width * 0.28, width * 0.18, neck_len, (neck_len * 0.3, 0, neck_len * 0.4),
                     (0, math.radians(42), 0))
        neck.data.materials.append(hide)
        neck.parent = neck_pivot
    head_at = (neck_len * 0.6 + hx * 0.4, 0, neck_len * 0.8)
    head = blob("head", (hx, hy, hz), head_at)
    head.data.materials.append(hide)
    head.parent = neck_pivot

    def part(name, size, at, mat, rot=(0.0, 0.0, 0.0)):
        obj = blob(name, size, (head_at[0] + at[0], at[1], head_at[2] + at[2]))
        obj.rotation_euler = rot
        obj.data.materials.append(mat)
        obj.parent = neck_pivot
        return obj

    def spike(name, lower, upper, depth_, at, rot, mat):
        obj = taper(name, lower, upper, depth_, (head_at[0] + at[0], at[1], head_at[2] + at[2]), rot)
        obj.data.materials.append(mat)
        obj.parent = neck_pivot
        return obj

    if "muzzle_long" in features:
        part("muzzle", (hx * 0.7, hy * 0.6, hz * 0.6), (hx * 0.5, 0, -hz * 0.1), accent)
    if "snout" in features:
        part("snout", (hx * 0.7, hy * 1.05, hz * 0.8), (hx * 0.45, 0, -hz * 0.15), hide)
    if "beard" in features:
        part("beard", (hx * 0.3, hy * 0.4, hz * 0.8), (hx * 0.05, 0, -hz * 0.6), accent)
    if "dewlap" in features:
        part("dewlap", (hx * 0.6, hy * 0.5, hz * 1.4), (-hx * 0.3, 0, -hz * 0.9), hide)

    for side, y in (("l", 1.0), ("r", -1.0)):
        if "ears" in features or "ears_big" in features or "ears_round" in features:
            big = 1.6 if "ears_big" in features else 1.0
            part(f"ear_{side}", (hx * 0.18, hy * 0.5 * big, hz * 0.5 * big), (-hx * 0.3, y * hy * 0.6, hz * 0.45), hide)
        if kind == "elephant":
            # The ears are most of what says elephant at any size, so they are big —
            # and its only ears: "ears" is kept out of its features, or the generic pair
            # is built as well, inside these.
            part(f"ear_{side}", (hx * 0.18, hy * 1.4, hz * 1.35), (-hx * 0.35, y * hy * 0.75, 0.02), hide)
        if "lyre" in features:
            spike(f"horn_{side}", 0.02, 0.008, 0.36, (-hx * 0.25, y * hy * 0.25, hz * 0.6), (math.radians(-18 * y), math.radians(-28), 0), horn)
        if "spiral" in features:
            # Two twists, as two angled segments: the kudu's corkscrew, read as a zig-zag.
            spike(f"horn_a_{side}", 0.03, 0.02, 0.45, (-hx * 0.3, y * hy * 0.35, hz * 0.8), (math.radians(-35 * y), math.radians(-20), 0), horn)
            spike(f"horn_b_{side}", 0.02, 0.006, 0.45, (-hx * 0.45, y * hy * 0.25, hz * 1.55), (math.radians(30 * y), math.radians(-35), 0), horn)
        if "straight" in features:
            spike(f"horn_{side}", 0.03, 0.008, 0.42, (-hx * 0.3, y * hy * 0.2, hz * 0.8), (0, math.radians(-38), 0), horn)
        if "cow_horns" in features:
            spike(f"horn_{side}", 0.03, 0.01, 0.3, (-hx * 0.15, y * hy * 0.8, hz * 0.5), (math.radians(-70 * y), 0, 0), horn)
        if "boss" in features:
            # The buffalo's boss: a heavy curve out, down and up again.
            spike(f"horn_a_{side}", 0.06, 0.04, 0.38, (-hx * 0.15, y * hy * 0.6, hz * 0.4), (math.radians(-100 * y), 0, 0), horn)
            spike(f"horn_b_{side}", 0.04, 0.01, 0.26, (-hx * 0.1, y * hy * 1.3, hz * 0.35), (math.radians(-35 * y), math.radians(-25), 0), horn)
        if "tusks" in features:
            # Rotating Z about Y by +θ points it toward +X: forward and down, as a tusk does.
            spike(f"tusk_{side}", 0.05, 0.018, 0.75, (hx * 0.55, y * hy * 0.25, -hz * 0.55), (0, math.radians(125), 0), ivory)
        if "tusks_up" in features:
            spike(f"tusk_{side}", 0.02, 0.006, 0.16, (hx * 0.4, y * hy * 0.4, -hz * 0.1), (math.radians(-30 * y), math.radians(20), 0), ivory)
    if "casque" in features:
        part("casque", (hx * 0.4, hy * 0.3, hz * 0.8), (0, 0, hz * 0.6), accent)
    if "trunk" in features:
        # Three segments hanging and curling a little forward.
        # Near vertical, stepping forward as it falls, so it hangs from the face rather
        # than sticking out of it. (The first pass had the rotation's sign backwards and
        # the trunk ran back under the chin.)
        for i, at in enumerate(((hx * 0.5, 0, -hz * 0.35), (hx * 0.56, 0, -hz * 0.9), (hx * 0.66, 0, -hz * 1.4))):
            spike(f"trunk_{i}", 0.14 - i * 0.03, 0.11 - i * 0.03, 0.5, at, (0, math.radians(8 + i * 6), 0), hide)

    # Manes. The lion's is a ruff round the head, the thing that says lion before
    # anything else does; the others are a crest along the neck.
    if "mane_lion" in features:
        ruff = blob("ruff", (hx * 1.3, hy * 2.0, hz * 2.1), (head_at[0] - hx * 0.35, 0, head_at[2] - hz * 0.2))
        ruff.data.materials.append(material("mane", (0.11, 0.055, 0.02)))
        ruff.parent = neck_pivot
    elif "mane" in features:
        crest = blob("crest", (neck_len * 0.9 + 0.15, width * 0.14, depth * 0.3), (neck_len * 0.25, 0, neck_len * 0.55))
        crest.rotation_euler = (0, math.radians(42), 0)
        crest.data.materials.append(accent)
        crest.parent = neck_pivot

    # --- tail ------------------------------------------------------------------------
    tail_pivot = bpy.data.objects.new("tail", None)
    bpy.context.scene.collection.objects.link(tail_pivot)
    tail_pivot.location = (-length / 2, 0, back + depth * 0.25)
    tail_pivot.parent = root
    tail_len = length * (0.55 if "tail_long" in features else 0.3)
    tail = taper("tail_mesh", 0.025 + width * 0.03, 0.01, tail_len, (0, 0, -tail_len / 2))
    if "tail_up" in features or "tail_hook" in features:
        tail.location = (0, 0, tail_len / 2)
    if "tail_long" in features:
        # Hanging close behind the haunch and curving out at the end, rather than the
        # stiff diagonal stick the first pass gave.
        tail.rotation_euler = (0, math.radians(-12), 0)
        tail.location = (-tail_len * 0.1, 0, -tail_len * 0.5)
        tuft = blob("tuft", (0.07, 0.07, 0.12), (-tail_len * 0.2, 0, -tail_len * 0.98))
        tuft.data.materials.append(accent)
        tuft.parent = tail_pivot
    tail.data.materials.append(hide)
    tail.parent = tail_pivot

    # --- legs ------------------------------------------------------------------------
    limbs = {"neck": neck_pivot, "tail": tail_pivot}
    radius = spec["leg_r"]
    for pair, x in (("fore", length * 0.32), ("hind", -length * 0.32)):
        for side, y in (("l", width * 0.3), ("r", -width * 0.3)):
            pivot = bpy.data.objects.new(f"{pair}_{side}", None)
            bpy.context.scene.collection.objects.link(pivot)
            pivot.location = (x, y, leg_len + depth * 0.1)
            pivot.parent = root
            length_here = leg_len + depth * 0.1
            leg = taper(f"leg_{pair}_{side}", radius * 1.7, radius * 0.8, length_here, (0, 0, -length_here / 2))
            leg.data.materials.append(hide)
            leg.parent = pivot
            foot = blob(f"foot_{pair}_{side}", (radius * 2.2, radius * 2.2, radius * 1.4), (0, 0, -length_here + radius * 0.6))
            foot.data.materials.append(accent if kind in ("zebra", "impala", "kudu", "eland") else hide)
            foot.parent = pivot
            limbs[f"{pair}_{side}"] = pivot

    return root, limbs


def build_bird(kind, spec, root, plumage, accent):
    """A bird: a body on two legs and a neck. Rigged with hips, and a neck that pecks."""
    length, depth, width, leg_len = spec["length"], spec["depth"], spec["width"], spec["leg"]
    back = leg_len + depth / 2
    skin = material("bird_skin", (0.55, 0.42, 0.36) if kind == "ostrich" else (0.2, 0.3, 0.55))
    body = blob("body", (length, width, depth), (0, 0, back))
    body.data.materials.append(plumage)
    body.parent = root
    features = spec["feature"]
    if "dots" in features:
        for i in range(10):
            u = (i * 0.618) % 1.0
            v = (i * 0.382) % 1.0
            dot = blob(f"dot_{i}", (length * 0.08, width * 1.03, depth * 0.08),
                       (-length * 0.35 + u * length * 0.7, 0, back - depth * 0.2 + v * depth * 0.45))
            dot.data.materials.append(accent)
            dot.parent = root
    if "plumes" in features:
        # White wing and tail plumes: the ostrich cock's black and white is its read.
        for side, y in (("l", 1.0), ("r", -1.0)):
            wing = blob(f"wing_{side}", (length * 0.5, width * 0.12, depth * 0.35), (-length * 0.15, y * width * 0.45, back + depth * 0.05))
            wing.data.materials.append(accent)
            wing.parent = root
        tail = blob("plume", (length * 0.3, width * 0.5, depth * 0.3), (-length * 0.5, 0, back + depth * 0.2))
        tail.data.materials.append(accent)
        tail.parent = root

    neck_pivot = bpy.data.objects.new("neck", None)
    bpy.context.scene.collection.objects.link(neck_pivot)
    neck_pivot.location = (length * 0.35, 0, back + depth * 0.2)
    neck_pivot.parent = root
    neck_len = spec["neck"]
    neck = taper("neck_mesh", width * 0.12, width * 0.07, neck_len, (0, 0, neck_len / 2))
    neck.data.materials.append(skin)
    neck.parent = neck_pivot
    hx, hy, hz = spec["head"]
    head = blob("head", (hx, hy, hz), (hx * 0.3, 0, neck_len))
    head.data.materials.append(skin if kind == "ostrich" else accent)
    head.parent = neck_pivot
    if "casque" in features:
        casque = blob("casque", (hx * 0.4, hy * 0.35, hz * 0.8), (0, 0, neck_len + hz * 0.55))
        casque.data.materials.append(material("casque", (0.7, 0.55, 0.3)))
        casque.parent = neck_pivot
    beak = taper("beak", hy * 0.25, 0.004, hx * 0.8, (hx * 0.8, 0, neck_len), (0, math.radians(90), 0))
    beak.data.materials.append(material("beak", (0.6, 0.5, 0.35)))
    beak.parent = neck_pivot

    limbs = {"neck": neck_pivot}
    for side, y in (("l", width * 0.2), ("r", -width * 0.2)):
        pivot = bpy.data.objects.new(f"hip_{side}", None)
        bpy.context.scene.collection.objects.link(pivot)
        pivot.location = (0, y, leg_len)
        pivot.parent = root
        leg = taper(f"leg_{side}", spec["leg_r"] * 1.4, spec["leg_r"], leg_len, (0, 0, -leg_len / 2))
        leg.data.materials.append(skin)
        leg.parent = pivot
        foot = blob(f"foot_{side}", (spec["leg_r"] * 5, spec["leg_r"] * 3, spec["leg_r"] * 1.2), (spec["leg_r"] * 1.5, 0, -leg_len))
        foot.data.materials.append(skin)
        foot.parent = pivot
        limbs[f"hip_{side}"] = pivot
    return root, limbs


def animate_bird(limbs: dict, anim: str, frames: int) -> None:
    """Two legs and a pecking neck. A strut, not a man's walk: the neck bobs with the step."""
    scene = bpy.context.scene
    for frame in range(1, frames + 1):
        phase = (frame - 1) / frames * math.tau
        scene.frame_set(frame)
        if anim == "idle":
            limbs["neck"].rotation_euler = (0, math.radians(35 + 30 * max(0.0, math.sin(phase))), 0)
            limbs["hip_l"].rotation_euler = (0, 0, 0)
            limbs["hip_r"].rotation_euler = (0, 0, 0)
        else:
            fast = anim == "run"
            swing = math.radians(38 if fast else 24) * math.sin(phase)
            limbs["hip_l"].rotation_euler = (0, swing, 0)
            limbs["hip_r"].rotation_euler = (0, -swing, 0)
            limbs["neck"].rotation_euler = (0, math.radians(20 if fast else 8) + math.radians(8) * math.sin(phase * 2), 0)
        for pivot in limbs.values():
            pivot.keyframe_insert("rotation_euler", frame=frame)


def build_mounted(kind: str):
    """A rider on a horse, standing on the origin, facing +X."""
    hide_colour, cloth_colour = MOUNTED[kind]
    hide = material("hide", hide_colour)
    cloth = material("cloth", cloth_colour)
    skin = material("skin", (0.21, 0.115, 0.070))
    mane = material("mane", (0.09, 0.06, 0.04))
    metal = material("metal", (0.30, 0.31, 0.30))
    player = material("player_colour", (0.78, 0.42, 0.20))

    root = bpy.data.objects.new("mounted", None)
    bpy.context.scene.collection.objects.link(root)

    back = HORSE_LEG + HORSE_DEPTH / 2

    body = blob("barrel", (HORSE_LENGTH, HORSE_WIDTH, HORSE_DEPTH), (0, 0, back))
    body.data.materials.append(hide)
    body.parent = root

    chest = blob("chest", (HORSE_LENGTH * 0.42, HORSE_WIDTH * 1.04, HORSE_DEPTH * 0.98),
                 (HORSE_LENGTH * 0.22, 0, back - 0.01))
    chest.data.materials.append(hide)
    chest.parent = root

    hind = blob("haunch", (HORSE_LENGTH * 0.40, HORSE_WIDTH * 1.02, HORSE_DEPTH * 1.0),
                (-HORSE_LENGTH * 0.30, 0, back + 0.02))
    hind.data.materials.append(hide)
    hind.parent = root

    neck_pivot = bpy.data.objects.new("neck", None)
    bpy.context.scene.collection.objects.link(neck_pivot)
    neck_pivot.location = (HORSE_LENGTH * 0.40, 0, back + HORSE_DEPTH * 0.26)
    neck_pivot.parent = root

    # Carried high and angled, which is the line that reads as horse rather than cow.
    neck = taper("neck_mesh", 0.15, 0.10, 0.52, (0.13, 0, 0.20), (0, math.radians(48), 0))
    neck.data.materials.append(hide)
    neck.parent = neck_pivot

    head = blob("head", (0.34, 0.15, 0.17), (0.31, 0, 0.40))
    head.data.materials.append(hide)
    head.parent = neck_pivot

    muzzle = blob("muzzle", (0.16, 0.11, 0.11), (0.44, 0, 0.34))
    muzzle.data.materials.append(mane)
    muzzle.parent = neck_pivot

    crest = blob("mane", (0.30, 0.075, 0.13), (0.14, 0, 0.42))
    crest.data.materials.append(mane)
    crest.parent = neck_pivot

    tail_pivot = bpy.data.objects.new("tail", None)
    bpy.context.scene.collection.objects.link(tail_pivot)
    tail_pivot.location = (-HORSE_LENGTH / 2, 0, back + HORSE_DEPTH * 0.30)
    tail_pivot.parent = root
    tail = taper("tail_mesh", 0.07, 0.02, 0.62, (0, 0, -0.30))
    tail.data.materials.append(mane)
    tail.parent = tail_pivot

    # The rider, seated. Simplified deliberately: at this size the legs astride and the
    # firearm across the saddle are the read, and anything more is pixels nobody sees.
    seat = back + HORSE_DEPTH / 2
    torso = blob("rider_torso", (0.30, 0.34, 0.46), (-0.04, 0, seat + 0.24))
    torso.data.materials.append(cloth)
    torso.parent = root

    rider_head = blob("rider_head", (0.20, 0.19, 0.23), (-0.04, 0, seat + 0.58))
    rider_head.data.materials.append(skin)
    rider_head.parent = root

    hat = blob("hat", (0.34, 0.34, 0.09), (-0.04, 0, seat + 0.66))
    hat.data.materials.append(cloth)
    hat.parent = root

    for side, y in (("l", 1.0), ("r", -1.0)):
        thigh = taper(f"rider_thigh_{side}", 0.075, 0.055, 0.36,
                      (0.06, y * 0.20, seat + 0.02), (0, math.radians(70), 0))
        thigh.data.materials.append(cloth)
        thigh.parent = root

        shin = taper(f"rider_shin_{side}", 0.05, 0.035, 0.34,
                     (0.14, y * 0.22, seat - 0.22))
        shin.data.materials.append(cloth)
        shin.parent = root

    # The firearm, carried across. It is why this unit exists.
    barrel = cylinder("musket", 0.022, 1.05, (0.10, -0.18, seat + 0.26),
                      (math.radians(90), 0, math.radians(24)))
    barrel.data.materials.append(metal)
    barrel.parent = root

    stock = box("stock", (0.30, 0.06, 0.09), (-0.22, -0.10, seat + 0.22))
    stock.data.materials.append(mane)
    stock.parent = root

    # A blanket under the saddle carries the faction, since a rider has no shield.
    blanket = blob("blanket", (0.62, HORSE_WIDTH + 0.06, 0.22), (-0.06, 0, seat - 0.10))
    blanket.data.materials.append(player)
    blanket.parent = root

    limbs = {"neck": neck_pivot, "tail": tail_pivot}
    for pair, x in (("fore", HORSE_LENGTH * 0.34), ("hind", -HORSE_LENGTH * 0.34)):
        for side, y in (("l", HORSE_WIDTH * 0.32), ("r", -HORSE_WIDTH * 0.32)):
            pivot = bpy.data.objects.new(f"{pair}_{side}", None)
            bpy.context.scene.collection.objects.link(pivot)
            pivot.location = (x, y, HORSE_LEG)
            pivot.parent = root

            leg = taper(f"leg_{pair}_{side}", 0.07, 0.032, HORSE_LEG, (0, 0, -HORSE_LEG / 2))
            leg.data.materials.append(hide)
            leg.parent = pivot

            hoof = blob(f"hoof_{pair}_{side}", (0.10, 0.09, 0.09), (0, 0, -HORSE_LEG + 0.03))
            hoof.data.materials.append(mane)
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

        if anim in ("idle", "attack"):
            # Grazing, or standing while the rider works: head down, weight shifting.
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


def build_villager(kind: str):
    """A villager standing on the origin, facing +X.

    Separate from `build` rather than folded into it with flags. The impi's builder is
    dense with impi — shield, patches, laces, spear, amashoba — and threading four
    postures through it would have made one long function that nobody can read and that
    breaks the soldier every time a villager changes. The primitives are shared; the
    assembly is not.

    The one piece of structure a soldier does not have is a SPINE pivot. Everything from
    the waist up hangs off it, so one rotation bends the whole upper body — which is the
    entire silhouette of the field-hand and most of the elder's. Arms counter-rotate by
    the same angle, because an arm hangs under gravity whatever the back is doing; a
    stooped figure whose arms stick out forward at the angle of the spine reads as a
    zombie, and that was the first version.
    """
    spec = VILLAGERS[kind]
    stature = spec["stature"]
    build_ratio = spec["build"]
    stoop = math.radians(spec["stoop"])

    skin = material("skin", spec["skin"])
    cloth = material("cloth", spec["cloth"])
    # Pale grass, for the head-ring, the basket and the herding stick. These are the only
    # light values on a villager, and they are placed where they help the outline: on top
    # of the head, and along a vertical line beside the body.
    grass = material("grass", (0.40, 0.32, 0.155))
    iron = material("iron", (0.22, 0.20, 0.19))

    root = bpy.data.objects.new("villager", None)
    bpy.context.scene.collection.objects.link(root)

    hip_z = HIP_HEIGHT * stature
    torso = TORSO * stature
    arm = ARM * stature
    leg = hip_z
    neck = NECK * stature
    head_d = HEAD * spec["head_scale"] * stature
    shoulders = SHOULDER_WIDTH * stature * build_ratio
    girth = stature * build_ratio

    # The spine: an empty at the hip. Local Z is measured up from the hip from here on.
    spine = bpy.data.objects.new("spine", None)
    bpy.context.scene.collection.objects.link(spine)
    spine.location = (0, 0, hip_z)
    spine.rotation_euler = (0, stoop, 0)
    spine.parent = root

    facet = {"smooth": False, "segments": 8, "rings": 5}
    limb = {"smooth": False, "verts": 7}

    chest = blob("chest", (0.32 * girth, shoulders, 0.33 * stature), (0, 0, torso - 0.12), **facet)
    chest.data.materials.append(skin)
    chest.parent = spine

    waist = blob("waist", (0.25 * girth, 0.27 * girth, 0.25 * stature),
                 (0, 0, torso * 0.34), **facet)
    waist.data.materials.append(skin)
    waist.parent = spine

    # At the HIP, on the root. The hips do not pitch with the back, so the root is the
    # right parent — but the root stands on the ground, and this was placed as if it hung
    # from the spine, at 0.05. Every villager carried a ball of pelvis between its ankles:
    # hidden by the legs at rest, and plain between them at every stride of the walk.
    pelvis = blob("pelvis", (0.28 * girth, 0.31 * girth, 0.23 * stature), (0, 0, hip_z + 0.05), **facet)
    pelvis.data.materials.append(skin)
    pelvis.parent = root

    throat = taper("neck", 0.052 * girth, 0.046 * girth, neck * 1.6, (0, 0, torso + neck * 0.35))
    throat.data.materials.append(skin)
    throat.parent = spine

    head = blob("head", (head_d * 0.82, head_d * 0.80, head_d),
                (0, 0, torso + neck + head_d / 2), **facet)
    head.data.materials.append(skin)
    head.parent = spine

    if spec["skirt"] is not None:
        # The isidwaba: a heavy pleated leather skirt, hem near the calf. It hangs from
        # the hips whatever the back is doing, so it parents to the ROOT and not to the
        # spine — a skirt that pitches with the shoulders reads as a tail.
        #
        # This is also the single most useful thing in the set for legibility. It ends the
        # figure in a solid bell instead of two legs, and two legs is what every other
        # sprite in this game ends in.
        hem, waist_r, length = spec["skirt"]
        skirt = taper("skirt", hem, waist_r, length, (0, 0, hip_z - length / 2 + 0.10), verts=14)
        skirt.data.materials.append(cloth)
        skirt.parent = root
    else:
        # The umutsha: a hide belt and apron, the same dress the impi wears, because a
        # herd-boy and an elder are wearing what men wear.
        belt = blob("belt", (0.27 * girth, 0.30 * girth, 0.08 * stature), (0, 0, hip_z + 0.02))
        belt.data.materials.append(cloth)
        belt.parent = root

        apron = blob("umutsha_front", (0.09, 0.21 * girth, 0.26 * stature),
                     (0.10, 0, hip_z - 0.08 * stature))
        apron.data.materials.append(cloth)
        apron.parent = root

        rear = blob("ibheshu", (0.11, 0.26 * girth, 0.28 * stature),
                    (-0.10, 0, hip_z - 0.09 * stature))
        rear.data.materials.append(cloth)
        rear.parent = root

    if kind == "elder":
        # The ingubo: a hide cloak over the shoulders. Its job in the silhouette is width
        # at the top — it makes the elder the broadest figure on the map from the neck
        # down to the ribs, which is the opposite of the boy and reads before the staff
        # does.
        # The ingubo: a hide cloak worn over the shoulders and hanging down the BACK.
        #
        # Two earlier versions were a single wide ellipsoid over the chest, and both read
        # as a balloon strapped to the man — first swallowing his head, then, once it was
        # lowered clear of the neck, hanging off him like a shell. The mistake was depth:
        # anything 0.3m thick at chest height is a body, not a garment. A cloak is a flat
        # panel that falls from the shoulders, so this one is thin in X, offset behind
        # him, and long enough to reach the hips.
        #
        # A cone rather than an ellipsoid, and that is the whole of what made it work.
        # Every ellipsoid version read as a large oval mass carried beside the body —
        # which is precisely the impi's isihlangu, the one silhouette in this game a
        # villager must not borrow. A cone narrow at the neck and wide at the hem follows
        # the body instead of hanging off it, and what it produces is the outline of a
        # draped man: wider at the bottom, no separate lump anywhere.
        # Smooth, and the one place in a human figure where that is right. Ten flat
        # facets on a cone this size are 36 degrees apart, and what they produced was a
        # plank strapped to his back. Cloth is the exception the cattle already prove.
        cloak = taper("cloak", 0.225, 0.14, 0.56 * stature, (-0.045, 0, torso - 0.30),
                      smooth=True, verts=18)
        cloak.data.materials.append(cloth)
        cloak.parent = spine

        # The isicoco: the sewn headring of a married man. A ring, so it widens the skull
        # rather than raising it, which at this size is the difference between "an old
        # man" and "a man in a hat".
        ring = blob("isicoco", (head_d * 1.12, head_d * 1.10, head_d * 0.17),
                    (0, 0, torso + neck + head_d * 0.62))
        ring.data.materials.append(cloth)
        ring.parent = spine

    if kind == "villager":
        # The umqhele: a band of fur round the brow. Low on the skull and thick, so it
        # reads as a band and not as the elder's headring, which sits on the crown.
        # Barely wider than the skull (0.82 x 0.80 of head_d): any wider and at play size
        # it read as a brimmed hat — a pith helmet, of all things.
        band = blob("umqhele", (head_d * 0.90, head_d * 0.88, head_d * 0.22),
                    (0, 0, torso + neck + head_d * 0.42))
        band.data.materials.append(material("fur", (0.14, 0.10, 0.065)))
        band.parent = spine

    limbs = {"spine": spine}
    for side, y in (("l", 1.0), ("r", -1.0)):
        hip_y = y * 0.090 * girth
        shoulder_y = y * (shoulders / 2 - 0.03)

        leg_pivot = bpy.data.objects.new(f"hip_{side}", None)
        bpy.context.scene.collection.objects.link(leg_pivot)
        leg_pivot.location = (0, hip_y, hip_z)
        leg_pivot.parent = root
        limbs[f"hip_{side}"] = leg_pivot

        thigh = taper(f"thigh_{side}", 0.072 * girth, 0.048 * girth, leg * 0.52,
                      (0, 0, -leg * 0.26), **limb)
        thigh.data.materials.append(skin)
        thigh.parent = leg_pivot

        knee = blob(f"knee_{side}", (0.09 * girth, 0.09 * girth, 0.085 * girth),
                    (0.012, 0, -leg * 0.5), **facet)
        knee.data.materials.append(skin)
        knee.parent = leg_pivot

        calf = taper(f"calf_{side}", 0.056 * girth, 0.028 * girth, leg * 0.50,
                     (-0.012, 0, -leg * 0.76), **limb)
        calf.data.materials.append(skin)
        calf.parent = leg_pivot

        foot = blob(f"foot_{side}", (0.17 * stature, 0.085, 0.065), (0.033, 0, -leg + 0.033),
                    **facet)
        foot.data.materials.append(skin)
        foot.parent = leg_pivot

        # Shoulders hang off the SPINE, so they travel when the back bends.
        arm_pivot = bpy.data.objects.new(f"shoulder_{side}", None)
        bpy.context.scene.collection.objects.link(arm_pivot)
        arm_pivot.location = (0, shoulder_y, torso - 0.03)
        arm_pivot.parent = spine
        limbs[f"shoulder_{side}"] = arm_pivot

        deltoid = blob(f"deltoid_{side}", (0.135 * girth, 0.125 * girth, 0.14 * girth),
                       (0, 0, -0.02), **facet)
        deltoid.data.materials.append(skin)
        deltoid.parent = arm_pivot

        upper = taper(f"upper_arm_{side}", 0.054 * girth, 0.037 * girth, arm * 0.48,
                      (0, 0, -arm * 0.26), **limb)
        upper.data.materials.append(skin)
        upper.parent = arm_pivot

        elbow = blob(f"elbow_{side}", (0.078 * girth, 0.078 * girth, 0.074 * girth),
                     (0.01, 0, -arm * 0.49), **facet)
        elbow.data.materials.append(skin)
        elbow.parent = arm_pivot

        fore = taper(f"forearm_{side}", 0.044 * girth, 0.028 * girth, arm * 0.46,
                     (-0.01, 0, -arm * 0.72), **limb)
        fore.data.materials.append(skin)
        fore.parent = arm_pivot

        hand = blob(f"hand_{side}", (0.085, 0.055, 0.095), (0, 0, -arm * 0.98), **facet)
        hand.data.materials.append(skin)
        hand.parent = arm_pivot

    build_villager_prop(kind, spec, limbs, root, {
        "arm": arm, "torso": torso, "neck": neck, "head_d": head_d,
        "hip_z": hip_z, "stature": stature, "grass": grass, "iron": iron, "cloth": cloth,
    })

    return root, limbs


def build_villager_prop(kind: str, spec: dict, limbs: dict, root, size: dict) -> None:
    """The thing in the villager's hands, which is half of what tells them apart.

    Props parent to the right shoulder pivot, not to the root. That means the animation
    decides whether a prop travels: a hoe parented to the arm that swings IS the hoe
    stroke and needs no separate rigging, while a staff parented to an arm the animation
    holds still stays planted. One attachment, two behaviours, chosen in the cycle.
    """
    arm = size["arm"]
    hand_z = -arm * 0.95
    right = limbs["shoulder_r"]
    grass, iron, cloth = size["grass"], size["iron"], size["cloth"]

    if spec["prop"] == "spears":
        # Two, parallel and a hand apart, leaning well forward: at forty pixels one spear
        # is a scratch and two are a sheaf.
        # Held near the butt and carried up and forward from the hand, not balanced at
        # the middle: centred on the hand, the lower half ran down through his legs.
        tilt = math.radians(52)
        along_x, along_z = math.sin(tilt), math.cos(tilt)
        for index, offset in enumerate((0.0, 0.05)):
            mid = 0.62
            spear = cylinder(f"spear_{index}", 0.016, 1.7, (0.04 + offset + along_x * mid, -0.03 - offset, hand_z + along_z * mid))
            spear.data.materials.append(grass)
            spear.rotation_euler = (0, tilt, 0)
            spear.parent = right
            tip = mid + 0.9
            head = taper(f"spearhead_{index}", 0.03, 0.002, 0.16, (0.04 + offset + along_x * tip, -0.03 - offset, hand_z + along_z * tip), (0, tilt, 0))
            head.data.materials.append(iron)
            head.parent = right
        return

    if spec["prop"] == "stick":
        # A herding switch, not a weapon. Long, thin, near vertical, and it rises well
        # above the boy's head — which is the point. He is the shortest figure on the map
        # with the tallest single line coming out of him, and no other sprite has that
        # combination.
        # Offset to his own right and leaned back, not straight up through the middle
        # of him. Centred and vertical it ran through the skull in half the directions
        # and read as a flagpole growing out of his head rather than as something held.
        # Thicker, too: at thirteen millimetres it resolved to a single pixel and looked
        # like a scratch on the atlas.
        stick = cylinder("stick", 0.022, 1.46, (-0.02, -0.02, hand_z + 0.44))
        stick.data.materials.append(grass)
        stick.rotation_euler = (0, math.radians(-13), 0)
        stick.parent = right
        return

    if spec["prop"] == "hoe":
        # The igeja: a short haft and a broad iron blade, worked with the back bent
        # rather than with the arms. Short — a long handle is a European hoe and would
        # put the stoop out of a job.
        # A positive Y rotation tips the TOP of a cylinder toward +X, which sent the
        # haft's lower end backward and left the blade floating a third of a metre in
        # front of it. Negative plants the blade ahead of her, which is where a hoe goes.
        haft = cylinder("hoe_haft", 0.024, 0.58, (0.10, 0, hand_z - 0.17))
        haft.data.materials.append(cloth)
        haft.rotation_euler = (0, math.radians(-24), 0)
        haft.parent = right

        # Broad. The first blade was 0.15 across, which is under three pixels at play
        # zoom: the hoe read as a golf club and the one detail that says "cultivation"
        # rather than "holding a stick" was not there at all.
        blade = blob("hoe_blade", (0.26, 0.22, 0.07), (0.205, 0, hand_z - 0.425))
        blade.data.materials.append(iron)
        blade.parent = right
        return

    if spec["prop"] == "headload":
        # A grain basket on a coiled grass pad, carried on the head. The mass goes to the
        # TOP of the figure, which is the reverse of every other sprite in the game — the
        # impi's weight is a shield at mid-height, the cow's is a barrel at knee height.
        # Top-heavy is a silhouette nothing else here occupies.
        spine = limbs["spine"]
        crown = size["torso"] + size["neck"] + size["head_d"] * 0.95

        # The inkatha: the grass coil that goes between skull and load. Small, but it
        # separates two pale masses that would otherwise fuse into one lump.
        pad = blob("inkatha", (size["head_d"] * 0.78, size["head_d"] * 0.78, 0.055),
                   (0, 0, crown + 0.02))
        pad.data.materials.append(grass)
        pad.parent = spine

        basket = taper("headload", 0.235, 0.20, 0.22, (0, 0, crown + 0.16), verts=14)
        basket.data.materials.append(grass)
        basket.parent = spine

        rim = blob("headload_rim", (0.42, 0.42, 0.10), (0, 0, crown + 0.27))
        rim.data.materials.append(iron)
        rim.parent = spine
        return

    if spec["prop"] == "staff":
        # A long staff planted ahead of the feet. Parented to an arm the walk cycle holds
        # still, so it stays a fixed diagonal — and a diagonal is the one line nothing
        # else in this set draws. The boy's stick is vertical; this is not.
        staff = cylinder("staff", 0.024, 1.74, (0.14, -0.05, hand_z + 0.10))
        staff.data.materials.append(grass)
        staff.rotation_euler = (0, math.radians(-13), 0)
        staff.parent = right
        return


def build(kind: str):
    """A figure standing on the origin, facing +X."""
    if kind in CATTLE:
        return build_cattle(kind)
    if kind in WILD:
        return build_wild(kind)
    if kind in MOUNTED:
        return build_mounted(kind)
    if kind in VILLAGERS:
        return build_villager(kind)
    skin_colour, cloth_colour, has_shield, has_spear = BIPEDS[kind]
    skin = material("skin", skin_colour)
    cloth = material("cloth", cloth_colour)
    # Warm cream, deliberately. A neutral pale under the cool sky fill came out
    # grey-blue, which reads as a steel shield — wrong century, wrong continent.
    hide_pale = material("hide_pale", (0.92, 0.82, 0.62))
    blade_metal = material("blade", (0.70, 0.71, 0.70))
    # Player colour lives on its own material so a shader swap can find it later —
    # ARCHITECTURE section 9 wants player colour swapped, not pre-tinted per faction.
    player = material("player_colour", (0.78, 0.42, 0.20))

    root = bpy.data.objects.new("unit", None)
    bpy.context.scene.collection.objects.link(root)

    shoulder_z = HIP_HEIGHT + TORSO

    # Low, faceted geometry for the body. A smooth ellipsoid is a soft gradient and a
    # figure made of soft gradients has no edges anywhere, which is what reads as blobby
    # once the sprite is fifty pixels tall. Eight sides around and five up gives each
    # plane its own value against the key, and those planes survive the downscale.
    facet = {"smooth": False, "segments": 8, "rings": 5}
    limb = {"smooth": False, "verts": 7}

    # Torso as three masses rather than one box: a chest that carries the shoulders, a
    # narrower waist, and the pelvis. A single block has no waist, and a figure with no
    # waist reads as a crate however good the kit on it is.
    chest = blob("chest", (0.34, SHOULDER_WIDTH, 0.34), (0, 0, shoulder_z - 0.12), **facet)
    chest.data.materials.append(skin)
    chest.parent = root

    waist = blob("waist", (0.27, 0.28, 0.26), (0, 0, HIP_HEIGHT + TORSO * 0.34), **facet)
    waist.data.materials.append(skin)
    waist.parent = root

    pelvis = blob("pelvis", (0.29, 0.32, 0.24), (0, 0, HIP_HEIGHT + 0.05), **facet)
    pelvis.data.materials.append(skin)
    pelvis.parent = root

    neck = taper("neck", 0.055, 0.048, NECK * 1.6, (0, 0, shoulder_z + NECK * 0.35))
    neck.data.materials.append(skin)
    neck.parent = root

    head = blob("head", (HEAD * 0.82, HEAD * 0.80, HEAD), (0, 0, shoulder_z + NECK + HEAD / 2), **facet)
    head.data.materials.append(skin)
    head.parent = root

    if has_shield:
        # The umutsha: a hide belt with a front apron and the ibheshu behind it, rather
        # than a tunic. The earlier cloth block over the chest read as a European jerkin,
        # which is the one thing this figure must not look like.
        belt = blob("belt", (0.30, 0.33, 0.09), (0, 0, HIP_HEIGHT + 0.02))
        belt.data.materials.append(cloth)
        belt.parent = root

        front = blob("umutsha_front", (0.10, 0.24, 0.30), (0.11, 0, HIP_HEIGHT - 0.09))
        front.data.materials.append(cloth)
        front.parent = root

        rear = blob("ibheshu", (0.13, 0.30, 0.34), (-0.11, 0, HIP_HEIGHT - 0.10))
        rear.data.materials.append(cloth)
        rear.parent = root

        # Headband, sitting on the brow rather than around the crown.
        band = blob("headband", (HEAD * 0.86, HEAD * 0.84, 0.055),
                    (0, 0, shoulder_z + NECK + HEAD * 0.72))
        band.data.materials.append(hide_pale)
        band.parent = root

    limbs = {}
    for side, y in (("l", 1.0), ("r", -1.0)):
        hip_y = y * 0.095
        shoulder_y = y * (SHOULDER_WIDTH / 2 - 0.03)

        # Limbs hang DOWN from their joint with the joint at the pivot's origin, so
        # rotating the pivot swings the limb about the hip or shoulder. That is the trick
        # that avoids needing an armature; the segments below are rigid within it.
        leg_pivot = bpy.data.objects.new(f"hip_{side}", None)
        bpy.context.scene.collection.objects.link(leg_pivot)
        leg_pivot.location = (0, hip_y, HIP_HEIGHT)
        leg_pivot.parent = root
        limbs[f"hip_{side}"] = leg_pivot

        thigh = taper(f"thigh_{side}", 0.078, 0.052, LEG * 0.52, (0, 0, -LEG * 0.26), **limb)
        thigh.data.materials.append(skin)
        thigh.parent = leg_pivot

        # A knee: a small mass at the break, and the calf set back from the thigh's line.
        # A leg that is one straight cone from hip to ankle is a stick, and no amount of
        # shading rescues it.
        knee = blob(f"knee_{side}", (0.10, 0.10, 0.09), (0.012, 0, -LEG * 0.5), **facet)
        knee.data.materials.append(skin)
        knee.parent = leg_pivot

        calf = taper(f"calf_{side}", 0.060, 0.030, LEG * 0.50, (-0.012, 0, -LEG * 0.76), **limb)
        calf.data.materials.append(skin)
        calf.parent = leg_pivot

        foot = blob(f"foot_{side}", (0.19, 0.09, 0.07), (0.035, 0, -LEG + 0.035), **facet)
        foot.data.materials.append(skin)
        foot.parent = leg_pivot

        arm_pivot = bpy.data.objects.new(f"shoulder_{side}", None)
        bpy.context.scene.collection.objects.link(arm_pivot)
        arm_pivot.location = (0, shoulder_y, shoulder_z - 0.03)
        arm_pivot.parent = root
        limbs[f"shoulder_{side}"] = arm_pivot

        shoulder = blob(f"deltoid_{side}", (0.145, 0.135, 0.15), (0, 0, -0.02), **facet)
        shoulder.data.materials.append(skin)
        shoulder.parent = arm_pivot

        upper = taper(f"upper_arm_{side}", 0.058, 0.040, ARM * 0.48, (0, 0, -ARM * 0.26), **limb)
        upper.data.materials.append(skin)
        upper.parent = arm_pivot

        elbow = blob(f"elbow_{side}", (0.085, 0.085, 0.08), (0.01, 0, -ARM * 0.49), **facet)
        elbow.data.materials.append(skin)
        elbow.parent = arm_pivot

        fore = taper(f"forearm_{side}", 0.047, 0.030, ARM * 0.46, (-0.01, 0, -ARM * 0.72), **limb)
        fore.data.materials.append(skin)
        fore.parent = arm_pivot

        hand = blob(f"hand_{side}", (0.09, 0.06, 0.10), (0, 0, -ARM * 0.98), **facet)
        hand.data.materials.append(skin)
        hand.parent = arm_pivot

        if side == "l" and has_shield:
            # Through blob() like everything else, which takes diameters. Setting .scale
            # directly here meant this one object was sized in half-extents while its
            # neighbours were sized in full ones, and the marking below — written to the
            # other convention — came out thinner than the shield and vanished inside it.
            shield = blob("shield", (0.10, SHIELD_WIDTH, SHIELD_HEIGHT), (0, 0, 0))
            shield_hide = material("shield_hide", (0.92, 0.82, 0.62))
            # Pale hide, not player colour. Warriors were brown kit on brown ground and
            # sank into the terrain, while the cattle beside them read clearly — and the
            # reason is contrast, not size: the cattle carry big pale patches. A war
            # shield was oxhide in strong two-tone anyway, so the legible choice and the
            # accurate one are the same.
            shield.data.materials.append(shield_hide)
            shield.parent = arm_pivot
            shield.location = (0.11, 0.05, -ARM * 0.34)
            shield.rotation_euler = (0, math.radians(-8), 0)

            # Thicker than the shield, so it actually breaks the surface on both faces.
            # The hide patches.
            #
            # An isihlangu is a cow, and it keeps the cow's markings — irregular patches
            # of a second colour, not a painted band. This was one solid field across the
            # lower half, which reads as a shield that has been DECORATED rather than one
            # that WAS an animal. Same trick the cattle use: flattened blobs pressed
            # through the surface so they break it on both faces, sized and placed
            # unevenly, because nothing about a real hide is regular.
            patches = (
                (0.30, -0.26, SHIELD_WIDTH * 0.52, SHIELD_HEIGHT * 0.30),
                (-0.18, 0.20, SHIELD_WIDTH * 0.40, SHIELD_HEIGHT * 0.22),
                (0.22, 0.11, SHIELD_WIDTH * 0.26, SHIELD_HEIGHT * 0.15),
                (-0.26, -0.06, SHIELD_WIDTH * 0.22, SHIELD_HEIGHT * 0.12),
            )
            for index, (across, up, wide, tall) in enumerate(patches):
                patch = blob(
                    f"shield_patch_{index}",
                    (0.13, wide, tall),
                    (0.11, 0.05 + across * SHIELD_WIDTH * 0.5, -ARM * 0.34 + up * SHIELD_HEIGHT),
                )
                patch.data.materials.append(player)
                patch.parent = arm_pivot

            staff = cylinder("shield_staff", 0.012, SHIELD_HEIGHT * 1.18,
                             (0.09, 0.05, -ARM * 0.34))
            staff.data.materials.append(cloth)
            staff.parent = arm_pivot

            # The row of hide laces binding the shield to that staff — the one regular
            # feature a real one has, and the thing that says "assembled from an animal"
            # rather than "cut from a sheet".
            for lace in range(5):
                strip = box("shield_lace", (0.016, 0.06, 0.045), (0, 0, 0))
                strip.data.materials.append(cloth)
                strip.parent = arm_pivot
                strip.location = (0.075, 0.05, -ARM * 0.34 + (lace - 2) * SHIELD_HEIGHT * 0.17)

        if side == "r" and has_spear:
            # Short. The whole tactical point of the weapon is that it is not thrown, so
            # a long shaft reads as the wrong army.
            spear = cylinder("spear", 0.015, SPEAR_LENGTH, (0.05, 0, -ARM * 0.62))
            spear.data.materials.append(cloth)
            spear.parent = arm_pivot
            spear.rotation_euler = (math.radians(12), 0, 0)

            blade = taper("spear_blade", 0.030, 0.004, 0.22,
                          (0.05, 0, -ARM * 0.62 + SPEAR_LENGTH * 0.55))
            blade.data.materials.append(blade_metal)
            blade.parent = arm_pivot
            blade.rotation_euler = (math.radians(12), 0, 0)

        # Amashoba: cow-tail tufts at the upper arm and below the knee. Small, but they
        # break the limb outline and are one of the few details that survive the
        # downscale as anything other than a smudge.
        tuft_arm = blob(f"tuft_arm_{side}", (0.13, 0.13, 0.15), (0, 0, -ARM * 0.44))
        tuft_arm.data.materials.append(hide_pale)
        tuft_arm.parent = arm_pivot

        tuft_leg = blob(f"tuft_leg_{side}", (0.14, 0.14, 0.14), (0, 0, -LEG * 0.60))
        tuft_leg.data.materials.append(hide_pale)
        tuft_leg.parent = leg_pivot

    return root, limbs


def animate_villager(kind: str, limbs: dict, anim: str, frames: int) -> None:
    """Keyframe a villager cycle.

    Three departures from the soldier's cycle.

    **Limbs swing about Y, not about X.** A figure built facing +X has its fore-and-aft
    axis on X and its left-right axis on Y, so rotating a hip about X does not take a
    step — it lifts the leg sideways. `animate()` above rotates about X, which means the
    shipped impi and commando do not walk, they splay; it is not visible at fifty pixels,
    which is why it has survived, and it is not fixed here because fixing it re-renders
    every soldier frame in the atlas. Measured, not guessed: rotating (0, 0, -0.92) about
    X by 24 degrees gives (0, +0.374, -0.84) — displacement in Y, which is sideways.

    **Every pose is REST PLUS DELTA**, because a villager's rest pose is not zero: the
    spine carries the stoop and each shoulder carries its negation. Keyframing an absolute
    zero on a shoulder would stand the arms out at the angle of the back on frame one and
    leave them there — which is exactly what the first version looked like.

    **`idle` is not idling.** A villager at rest is a villager AT WORK — a stooped figure
    hoeing, a carrier shifting a load, a boy leaning on his stick. That is deliberate, and
    it is what makes this batch usable without touching the simulation: the sim already
    plays `idle` for anything that has stopped moving, so a field-hand who has reached her
    field hoes for free, with no new animation state and no new enum.
    """
    spec = VILLAGERS[kind]
    stoop = math.radians(spec["stoop"])
    free = spec["free_arm"]
    carry = spec["prop"] == "headload"
    scene = bpy.context.scene

    for frame in range(1, frames + 1):
        phase = (frame - 1) / frames * math.tau
        scene.frame_set(frame)

        # The rest pose. Arms counter the spine so they hang under gravity.
        pitch = stoop
        arm_l = arm_r = 0.0
        hip_l = hip_r = 0.0
        # Lateral abduction, about X. Used for one thing only: lifting the steadying arm
        # of a carrier out and up the side of her head, which is a sideways motion and
        # the one place the X axis is the right one.
        raise_l = 0.0

        if carry:
            # A hand to the load. It opens a triangle of sky between arm and head, and
            # that triangle is the clearest single statement in the whole batch that this
            # figure is carrying something rather than wearing a hat.
            # High and angled in toward the load. The arm is one rigid segment with no
            # elbow, so the angle is a compromise: at 126 degrees the hand ends up half a
            # metre out to her side holding nothing, and at 168 it is a vertical line
            # beside a vertical body, which at play size is indistinguishable from the
            # herd-boy's stick. 155 leaves a clear diagonal and a triangle of sky under
            # it, and that triangle is what says "carrying" rather than "wearing".
            raise_l = math.radians(155.0)

        if anim == "walk":
            swing = math.radians(spec["stride"]) * math.sin(phase)
            hip_l, hip_r = swing, -swing
            # Only the free arm swings, and not if it is holding the load up. An arm that
            # swings a planted staff or a balanced basket reads as a mistake, not motion.
            if free == "l" and not carry:
                arm_l = -swing * 0.65
            elif free == "r":
                arm_r = swing * 0.65
            elif free == "both":
                # Empty hands, so both arms swing against the legs.
                arm_l = -swing * 0.6
                arm_r = swing * 0.6
            # The whole body rises and falls a little over a stride. On the carrier this
            # is the only thing that says the load is heavy.
            pitch += math.radians(2.0) * math.sin(phase * 2)
        elif kind == "field-hand":
            # The hoe stroke. Asymmetric on purpose: a slow lift and a fast chop, which
            # is what a stroke is. `lift` runs 0 -> 1 -> 0 over the cycle and is squared
            # on the way back down so the blade drops faster than it rose.
            #
            # Backward, not forward. A positive Y rotation takes the hand behind her,
            # which draws the hoe up and back along the line of her own body and keeps
            # the whole stroke inside her silhouette. Swinging it forward instead threw
            # the blade a metre out in front and off the edge of the render.
            lift = (1.0 - math.cos(phase)) / 2.0
            drive = lift if phase < math.pi else lift * lift
            arm_l = arm_r = math.radians(34.0) * drive
            # The back straightens as she draws up and folds again as she drives down.
            pitch -= math.radians(11.0) * drive
            hip_l = math.radians(3.0) * drive
            hip_r = math.radians(-2.0) * drive
        elif kind == "carrier":
            # A weight shift from foot to foot, and the spine rocking a couple of degrees
            # under the load. Small: a carrier balancing twenty kilos on her head does not
            # move much, and that stillness is itself characterful beside a hoeing figure.
            sway = math.radians(2.5) * math.sin(phase)
            hip_l, hip_r = sway, -sway
            pitch += math.radians(1.6) * math.sin(phase)
        elif kind == "herd-boy":
            # Leaning on the stick, weight on one hip, looking at nothing in particular.
            sway = math.radians(4.5) * math.sin(phase)
            hip_l, hip_r = sway, -sway
            arm_l = math.radians(7.0) * math.sin(phase)
        elif kind == "villager":
            # Standing: a slow shift of weight, arms loose.
            sway = math.radians(3.0) * math.sin(phase)
            hip_l, hip_r = sway, -sway
            arm_l = math.radians(3.0) * math.sin(phase)
            arm_r = -arm_l
        else:  # elder
            sway = math.radians(2.0) * math.sin(phase)
            hip_l, hip_r = sway, -sway
            pitch += math.radians(1.2) * math.sin(phase)

        limbs["spine"].rotation_euler = (0, pitch, 0)
        limbs["hip_l"].rotation_euler = (0, hip_l, 0)
        limbs["hip_r"].rotation_euler = (0, hip_r, 0)
        # The shoulder's parent is the spine, which already carries +pitch, so subtracting
        # it here leaves the arm hanging vertically in the world whatever the back does.
        # Both terms are about the same axis, so they simply add.
        limbs["shoulder_l"].rotation_euler = (raise_l, arm_l - pitch, 0)
        limbs["shoulder_r"].rotation_euler = (0.0, arm_r - pitch, 0)

        for pivot in limbs.values():
            pivot.keyframe_insert("rotation_euler", frame=frame)


def animate(kind: str, limbs: dict, anim: str) -> int:
    """Keyframe a cycle. Returns the frame count."""
    frames = frame_count(kind, anim)
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = frames

    if "fore_l" in limbs:
        animate_quadruped(limbs, anim, frames)
        return frames
    if kind in WILD:
        animate_bird(limbs, anim, frames)
        return frames

    if kind in VILLAGERS:
        animate_villager(kind, limbs, anim, frames)
        return frames

    for frame in range(1, frames + 1):
        phase = (frame - 1) / frames * math.tau
        scene.frame_set(frame)

        if anim in ("walk", "run"):
            # Tuned down from 34/52. Those angles were set against legs half this
            # length, where a wide swing was the only way to read as motion at all; on a
            # correctly proportioned figure the same angle is a splay.
            swing = math.radians(24 if anim == "walk" else 40) * math.sin(phase)
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


def wears(obj, prefix: str) -> bool:
    """Does this object carry a material with this name prefix?"""
    if obj.type != "MESH" or obj.data is None:
        return False
    return any(slot is not None and slot.name.startswith(prefix) for slot in obj.data.materials)


def wears_player_colour(obj) -> bool:
    """Does this object carry the material a faction recolours?"""
    return wears(obj, "player_colour")


# Which parts get their own tinted overlay pass, and what each pass is called.
#
# One set of art, several choosable colours. A war shield was sorted into regiments by
# the colour of its hide and the marking on it, so those are exactly the two axes worth
# making choosable — and each is a separate small frame drawn over the body, which is the
# same trick that made player colour work without a per-faction atlas.
OVERLAYS = (("shield_hide", "shield"), ("player_colour", "team"))


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
    frames = animate(kind, limbs, anim)

    # Cattle need their own framing: longer than a man is tall and lower at the
    # shoulder, so the figure camera clips a nose or a rump depending on rotation.
    if kind in CATTLE:
        ortho, target = 2.9, 0.62
    elif kind in WILD:
        # Each framed to its own size, and rendered at its own resolution: a guinea fowl
        # needs a quarter of an elephant's pixels to say the same amount.
        ortho, target = WILD[kind]["ortho"], WILD[kind]["target"]
        args.size = WILD[kind]["size"]
    elif kind in MOUNTED:
        ortho, target = 3.1, 0.95
    elif kind in VILLAGERS:
        # Same ortho scale as the impi, so a villager and a soldier agree about how big a
        # metre is without the renderer having to reconcile them. Only the aim changes:
        # a stooped figure wastes the top of a frame framed for a standing one, and a
        # head-load walks straight out of the top of it.
        ortho, target = VILLAGERS[kind]["ortho"], VILLAGERS[kind]["target"]
        args.size = VILLAGERS[kind].get("size", args.size)
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

    # The team pass: the same frames again with everything hidden except the parts
    # carrying player colour, rendered pale so a tint multiplies cleanly.
    #
    # This is how one set of art serves four factions. ARCHITECTURE section 9 rules out
    # pre-tinted per-faction atlases because they multiply the budget by faction count
    # and asks for a shader swap instead — and a tinted sprite IS a shader swap, applied
    # in the renderer's own batch shader, which is the version that does not break the
    # batch. Drawn from the same page as the body, so the two batch together.
    #
    # Nearly free in atlas terms: a team frame is a shield marking and nothing else, so
    # it trims to a fraction of the body frame beside it.
    for prefix, suffix in OVERLAYS:
        parts = [obj for obj in bpy.data.objects if wears(obj, prefix)]
        if not parts:
            continue

        hidden = [obj for obj in bpy.data.objects if obj.type == "MESH" and obj not in parts]
        for obj in hidden:
            obj.hide_render = True
        # Rendered pale, so a tint multiplies cleanly rather than fighting a colour that
        # is already there.
        mask = material(f"{suffix}_mask", (0.88, 0.88, 0.88))
        kept = [(obj, list(obj.data.materials)) for obj in parts]
        for obj in parts:
            obj.data.materials.clear()
            obj.data.materials.append(mask)

        for direction in range(directions):
            root.rotation_euler.z = direction * step
            for frame in range(frames):
                scene.frame_set(scene.frame_start + frame)
                scene.render.filepath = os.path.join(
                    args.render, f"{kind}-{suffix}_{anim}_{direction}_{frame:02d}.png"
                )
                bpy.ops.render.render(write_still=True)
                written += 1

        for obj in hidden:
            obj.hide_render = False
        # Put the originals back, or the next overlay pass renders the previous one's
        # mask instead of the part it was looking for.
        for obj, materials in kept:
            obj.data.materials.clear()
            for slot in materials:
                obj.data.materials.append(slot)

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
        animate(args.kind, limbs, args.anim)
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
