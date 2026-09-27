"""
The mesh route for sprites, end to end: reference image, 3D model, sprites.

    python tools/art/mesh_pipeline.py refs impala              # candidate references
    python tools/art/mesh_pipeline.py mesh impala --seed 23    # the chosen one to 3D
    python tools/art/mesh_pipeline.py render impala            # rig, animate, render, trim
    python tools/art/.venv/bin/python tools/art/pack_atlas.py  # then pack as usual

Three steps a person looks between, because two of them go wrong in ways only looking
catches: an image model sometimes draws a two-headed zebra, and an image-to-3D model
sometimes fuses legs. `refs` makes several candidates to choose from; `mesh` records the
choice (prompt and seed in mesh_sources.json, a small copy of the image in reference/) so the sprite can
be regenerated exactly; `render` does the rest without a person.

Run with any Python: it drives three other environments — the mflux one for images
(`.venv`), the TripoSR one for meshes (`.venv-3d`, with the checkout in `triposr/`), and
Blender for the render — rather than importing any of them.
"""

import argparse
import json
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RAW = HERE / "raw" / "mesh"
SOURCES = HERE / "mesh_sources.json"
REFERENCE = HERE / "reference"
SPRITES = HERE / "out" / "sprites"

MFLUX = HERE / ".venv" / "bin" / "mflux-generate"
TRIPO_PYTHON = HERE / ".venv-3d" / "bin" / "python"
TRIPO = HERE / "triposr" / "run.py"
PYTHON = HERE / ".venv" / "bin" / "python"

MODEL = "mflux-community/flux-1-schnell-mflux-q4"

# What each subject is, in words an image model draws accurately. Southern African
# animals, named precisely: "an antelope" gets a generic deer, "a greater kudu bull with
# long spiral horns" gets a kudu.
SUBJECTS = {
    "zebra": "a single plains zebra standing",
    "elephant": "a single adult African bush elephant standing, with ivory tusks and large ears",
    "kudu": "a single greater kudu bull standing, with long spiral horns and thin white stripes on its grey-brown body",
    "impala": "a single impala ram standing, reddish-brown with lyre-shaped horns",
    "eland": "a single common eland bull standing, tawny with a dewlap and straight spiralled horns",
    "wildebeest": "a single blue wildebeest standing, dark grey with a black mane, beard and curved horns",
    "warthog": "a single common warthog standing on all four legs, with curved tusks and a mane",
    "buffalo": "a single African Cape buffalo bull standing, black, with heavy curved horns meeting in a boss",
    # The village's own herd. Nguni cattle: lean and fine-boned, a short glossy coat, a
    # small hump over the shoulders, long lyre-shaped horns dark at the tips, and a hide
    # patterned like no other beast's. Two coats, so a herd is not a row of one cow
    # (entities.ts picks by handle).
    "nguni": "a single Nguni cow standing, a lean fine-boned African cattle breed with a short glossy coat patched irregularly in rich red-brown and white with small speckles, a small hump over the shoulders, long upswept lyre-shaped horns dark at the tips",
    "nguni-dark": "a single Nguni cow standing, a lean fine-boned African cattle breed with a short glossy coat of black with irregular white patches and fine white speckling on the flanks, a small hump over the shoulders, long upswept lyre-shaped horns dark at the tips",
    "hippo": "a single hippopotamus standing on dry land, on all four legs",
    "lion": "a single adult male African lion standing, with a dark mane",
    "leopard": "a single African leopard standing on all four legs, golden with black rosettes",
    "hyena": "a single spotted hyena standing, sloping back, spotted coat",
    "baboon": "a single chacma baboon walking on all four legs",
    "ostrich": "a single male ostrich standing, black body plumage with white wing and tail feathers, long bare neck",
    # Said three ways over: the first prompt gave three long-legged crane- and
    # vulture-like birds. A guineafowl is a plump, short-legged ground bird.
    "guineafowl": "a single helmeted guineafowl, a plump round-bodied short-legged ground bird shaped like a chicken, slate-grey feathers covered all over in small white dots, a small bare blue and red head with a short bony casque on top",
}

STYLE = (
    "whole animal in frame from nose to tail and feet, three-quarter view from the front left, "
    "isolated on a plain pure white background, even soft studio lighting, sharp focus, realistic wildlife photograph"
)

# Props: things that stand still, drawn as three variants of one mesh (make_prop_mesh.py).
# Trees are what the village fells and what it lives among; the goats and chickens are
# kept at every finished dwelling (entities.ts setLivestock), and had no art at all.
PROPS = {
    "acacia": "a single umbrella thorn acacia tree of the African savanna, a wide flat-topped spreading crown of fine green foliage on a short forked dark trunk",
    "marula": "a single marula tree of the African savanna, a dense rounded crown of green leaves on a stout grey trunk with a few spreading limbs",
    "yellowwood": "a single tall African yellowwood tree, a tall narrow dark green crown of fine needle-like leaves on a straight trunk with flaking brown bark",
    "baobab": "a single African baobab tree, a massive swollen smooth grey barrel trunk with short stubby spreading branches at the top carrying a few green leaves",
    # Green, not grey-green: the silvery first bush baked to grey and read as a boulder.
    "scrub": "a single low dense African thornveld bush, an irregular rounded clump of small bright olive-green leaves on thin brown woody stems",
    "aloe": "a single tall aloe plant of the South African veld, a rosette of thick spiky blue-green leaves on a short stem with a tall orange-red flower spike",
    "goat": "a single small African Nguni goat standing, a short glossy coat patched in brown, black and white, small upswept horns",
    "chicken": "a single African village chicken standing, a small hen with speckled red-brown, black and golden feathers and a red comb",
}
PROP_STYLE = (
    "whole subject in frame from the ground to the top, side view, isolated on a plain pure white background, "
    "even soft studio lighting, sharp focus, realistic photograph"
)

# People in full ceremonial dress, after the owner's references (ADR-0024): beadwork in
# every colour, leopard and cow hide, the wide isicholo hat. It is later than the period
# the game is set in, and chosen over it on purpose.
#
# The garment the player's outfit colour replaces is asked for in one solid KEY colour,
# vivid magenta, which is in none of the beadwork: make_wild_mesh.py finds it in the baked
# texture and renders it as a separate pale pass the game tints (see OUTFIT_KEY there).
# Every reference is looked at before it becomes a sprite, for dignity as much as for
# the key (CONTENT.md section 5).
KEY = "solid plain vivid magenta"
BEADS = "bright glass beadwork in red, yellow, blue, green, white and black geometric triangles and diamonds"
PEOPLE = {
    "villager": f"a Zulu man in full traditional ceremonial dress, a {KEY} cloth draped over one shoulder and a {KEY} knee-length skirt, a leopard-skin collar, {BEADS} across his chest and on his arms and ankles, white cow-tail bands on his upper arms and calves, a beaded headband, barefoot, hands empty at his sides",
    "herd-boy": f"a Zulu boy of about twelve in traditional ceremonial dress, a {KEY} short skirt and a {KEY} sash across his chest, {BEADS} necklaces and armbands, barefoot, holding a long thin herding stick upright beside him",
    # Standing, not bent to the soil: bent double in a full skirt and hat, she came back
    # from image-to-3D as a mound of cloth with the figure lost inside it.
    "field-hand": f"a Zulu woman in full traditional ceremonial dress standing upright, carrying a short wooden-handled hoe with one broad flat iron blade resting on her shoulder, a wide flat-topped {KEY} isicholo hat, a {KEY} pleated knee-length skirt, a beaded apron and collar of {BEADS}, barefoot, standing on nothing, no soil",
    "carrier": f"a Zulu woman in full traditional ceremonial dress standing upright, balancing a large round clay pot on top of her head, one hand steadying it, a {KEY} shawl over her shoulders and a {KEY} pleated knee-length skirt, a beaded apron and collar of {BEADS}, barefoot, nothing on the ground",
    "elder": f"an elderly Zulu man in full traditional ceremonial dress, a {KEY} cloak over his shoulders, a leopard-skin headband, {BEADS} necklaces, white cow-tail bands on his arms, barefoot, leaning on a long wooden staff",
    # The soldiers of the combat era. Nothing spawns them now (ADR-0019), but they keep
    # their art, redone like everyone else's at the owner's request.
    "impi": f"a Zulu warrior in full traditional ceremonial regalia, a {KEY} knee-length kilt and a {KEY} cape over one shoulder, a leopard-skin headband, white cow-tail bands on his arms and legs, {BEADS} across his chest, holding a tall oval black and white cowhide shield at his side and a short spear, barefoot, standing",
    # A Griqua rider, in the European-style riding dress the Griqua wore, not regalia.
    "commando": f"a Griqua horseman of southern Africa sitting on a brown horse, wearing a wide-brimmed leather hat and a {KEY} riding coat, a long musket slung across his back, seen from a distance so the entire horse is in frame with all four legs and hooves standing on the ground and space around it",
    "hunter": f"a Zulu hunter in traditional ceremonial dress, a {KEY} knee-length skirt and a {KEY} band across his chest, a leopard-skin collar, {BEADS} armbands, barefoot, carrying two long throwing spears slanting forward",
}
PEOPLE_STYLE = (
    "whole figure in frame from head to feet, three-quarter view from the front left, "
    "isolated on a plain pure white background, even soft studio lighting, sharp focus, "
    "realistic, dignified"
)

# The owner's references (ADR-0024): walls of whitewashed clay painted in the Ndebele
# manner, bold flat shapes outlined in black. Asked for on every building that has a
# wall to carry it; the weir and the hunters' drying rack have none and keep their form.
PAINT = "whitewashed clay painted all over in bold Ndebele geometric patterns, large flat triangles, diamonds, chevrons and stepped shapes in bright red, yellow, blue and green, each outlined in thick black lines"
BUILDINGS = {
    # Composed from three of the indlunkulu (make_building_mesh.py COMPOSED); the prompt is
    # what a single reference would be asked for.
    "umuzi": f"a small group of three traditional round huts with low round walls of {PAINT}, under conical thatched grass roofs, arched doorways",
    # Asked for a painted wall, not a fence: rails and wattle do not survive
    # image-to-3D (the first goat fold came back as floating sticks); a solid wall does.
    "isibaya": f"a large empty circular cattle enclosure with a low solid round wall of {PAINT}, open to the sky, one wide gap for a gateway, standing on bare earth",
    "grain-store": f"a small traditional African granary, a round storage bin of {PAINT}, with a conical thatched roof, raised on short wooden stilts",
    "ikhanda": f"a large traditional homestead, many round huts with walls of {PAINT} under conical thatched roofs, in a wide ring around an open central cattle enclosure",
    "indlunkulu": f"a single large traditional round great hut, a round wall of {PAINT}, under a tall conical thatched grass roof, an arched doorway, the wall meeting the white background directly with no ground, sand or shadow beneath it",
    "umgodi": f"a sealed traditional grain storage pit, a small low round raised rim of {PAINT}, with a flat stone lid on top",
    "isiziba": "a small weir of stacked grey stones and wooden stakes, built across the end of a narrow stream",
    # Not used: the fold is the isibaya's mesh, smaller (make_building_mesh.py COMPOSED).
    # Asked for itself it came back as a hood or a tunnel, in every wording tried.
    "goat-fold": f"a small empty circular goat enclosure with a low solid round wall of {PAINT}, open to the sky, standing on bare earth",
    "hunters-camp": "a small hunters' camp: a wooden A-frame drying rack with two animal hides hanging on it, beside a small low dome shelter of grass",
    # Seen from the side: from above, the model painted the inside of the shaft and never
    # saw the outside wall, which came back as ochre wicker from every angle.
    "well": f"a traditional water well seen from the side at eye level, a low round drum-shaped outer wall of {PAINT} facing the camera, with a simple wooden frame above it holding a clay pot on a rope",
}
BUILDING_STYLE = (
    "whole structure in frame, three-quarter view from slightly above, isolated on a plain pure white background, "
    "even soft lighting, sharp focus, realistic photograph"
)


# A different camera for subjects the three-quarter front view fails. Image-to-3D
# underestimates depth from a near-frontal view, and an elephant photographed from the
# front is mostly ears and trunk: the first came back lumpy and short-bodied. From the
# side the model sees the length of the body it has to build.
VIEWS = {
    # A horse and rider from the side, as the cattle: the length of the horse is what the
    # model has to build, and a three-quarter front foreshortened the cows.
    "commando": "side view in profile facing left, slightly from the front, isolated on a plain pure white background, "
    "even soft studio lighting, sharp focus, realistic, dignified",
    # The cattle too: from three-quarters front the first cow came back foreshortened,
    # its legs splayed as if bucking and its back tilted at rest.
    "nguni": "whole animal in frame from nose to tail and feet, side view in profile facing left, slightly from the front, "
    "isolated on a plain pure white background, even soft studio lighting, sharp focus, realistic photograph",
    "nguni-dark": "whole animal in frame from nose to tail and feet, side view in profile facing left, slightly from the front, "
    "isolated on a plain pure white background, even soft studio lighting, sharp focus, realistic photograph",
    "elephant": "whole animal in frame from trunk to tail and feet, side view in profile facing left, slightly from the front, "
    "isolated on a plain pure white background, even soft studio lighting, sharp focus, realistic wildlife photograph",
}


def sources() -> dict:
    return json.loads(SOURCES.read_text()) if SOURCES.exists() else {}


def prompt_for(kind: str) -> str:
    if kind in PEOPLE:
        return f"photograph of {PEOPLE[kind]}, {VIEWS.get(kind, PEOPLE_STYLE)}"
    if kind in PROPS:
        return f"photograph of {PROPS[kind]}, {PROP_STYLE}"
    if kind in BUILDINGS:
        return f"photograph of {BUILDINGS[kind]}, {BUILDING_STYLE}"
    return f"wildlife photograph of {SUBJECTS[kind]}, {VIEWS.get(kind, STYLE)}"


def refs(kind: str, seeds: list[int]) -> None:
    folder = RAW / kind
    folder.mkdir(parents=True, exist_ok=True)
    for seed in seeds:
        out = folder / f"ref_{seed}.png"
        if out.exists():
            continue
        subprocess.run(
            [str(MFLUX), "--model", MODEL, "--base-model", "schnell", "--steps", "4",
             "--width", "768", "--height", "768", "--seed", str(seed),
             "--prompt", prompt_for(kind), "--output", str(out)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        print(f"  {out.relative_to(ROOT)}")


# Marching-cubes resolution, where the default is wrong for a subject. A dense bush of
# small leaves at 256 made a surface whose texture bake ran for over 100 CPU minutes
# without finishing; at the size a bush is drawn, one fused clump is what it should be.
MC_RESOLUTION = {"scrub": 160}


def mesh(kind: str, seed: int) -> None:
    folder = RAW / kind
    ref = folder / f"ref_{seed}.png"
    if not ref.exists():
        raise SystemExit(f"no reference {ref}; run `refs {kind}` first")
    subprocess.run(
        [str(TRIPO_PYTHON), str(TRIPO), str(ref), "--output-dir", str(folder / "tripo"),
         "--mc-resolution", str(MC_RESOLUTION.get(kind, 256)), "--bake-texture", "--texture-resolution", "1024"],
        check=True, cwd=str(TRIPO.parent), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    # TripoSR's texture-baking path writes OBJ whatever the requested format.
    produced = folder / "tripo" / "0"
    shutil.copy(produced / "mesh.obj", folder / "mesh.obj")
    shutil.copy(produced / "texture.png", folder / "texture.png")
    # Kept for looking at, not for rebuilding: the prompt and seed regenerate the exact
    # image, so the copy in git is a 512 px JPEG rather than a 600 KB PNG per subject.
    REFERENCE.mkdir(exist_ok=True)
    subprocess.run(
        [str(PYTHON), "-c",
         "import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGB').resize((512,512)).save(sys.argv[2],quality=88)",
         str(ref), str(REFERENCE / f"{kind}.jpg")],
        check=True,
    )
    record = sources()
    record[kind] = {"prompt": prompt_for(kind), "seed": seed}
    SOURCES.write_text(json.dumps(record, indent=2) + "\n")
    print(f"  {kind}: mesh from seed {seed}")


def render(kind: str, turn: float = 0.0) -> None:
    builder = "make_building_mesh.py" if kind in BUILDINGS else "make_prop_mesh.py" if kind in PROPS else "make_wild_mesh.py"
    folder = RAW / kind
    frames = folder / "frames"
    trimmed = folder / "trimmed"
    for path in (frames, trimmed):
        if path.exists():
            shutil.rmtree(path)
    subprocess.run(
        ["blender", "-b", "-noaudio", "-P", str(HERE / builder), "--",
         "--kind", kind, "--mesh", str(folder / "mesh.obj"), "--texture", str(folder / "texture.png"),
         "--render", str(frames)] + (["--turn", str(turn)] if kind in BUILDINGS else []),
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        [str(PYTHON), str(HERE / "postprocess.py"), "sprite", "--in", str(frames), "--out", str(trimmed)],
        check=True, stdout=subprocess.DEVNULL,
    )
    # Into the sprite set the atlas is packed from: frames, manifest entries, origin.
    new = json.loads((trimmed / "manifest.json").read_text())["sprites"]
    # Everything this kind had before goes first, body and overlay. A rebuild can have
    # fewer frames than the art it replaces (the primitive cattle walked in twelve, a mesh
    # animal in eight), and frames it did not overwrite would play inside the new cycle.
    # The trailing underscore keeps "nguni" from taking "nguni-dark" with it.
    stale = (f"{kind}_", f"{kind}-team_", f"{kind}-shield_")
    for path in SPRITES.iterdir():
        if path.name.startswith(stale):
            path.unlink()
    for entry in new:
        shutil.copy(trimmed / entry["file"], SPRITES / entry["file"])
    manifest_path = SPRITES / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["sprites"] = sorted(
        [e for e in manifest["sprites"] if not e["file"].startswith(stale)] + new, key=lambda e: e["file"]
    )
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    origin = json.loads((frames / "origins.json").read_text())
    for path in (HERE / "out" / "origins.json", SPRITES / "origins.json"):
        origins = json.loads(path.read_text())
        origins.update(origin)
        path.write_text(json.dumps(origins, indent=1))
    print(f"  {kind}: {len(new)} frames into {SPRITES.relative_to(ROOT)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("step", choices=("refs", "mesh", "render"))
    parser.add_argument("kind", choices=sorted({**SUBJECTS, **PEOPLE, **BUILDINGS, **PROPS}))
    parser.add_argument("--turn", type=float, default=0.0, help="Buildings: extra turn in degrees")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--seeds", type=int, nargs="*", default=[11, 23, 47])
    args = parser.parse_args()
    if args.step == "refs":
        refs(args.kind, args.seeds)
    elif args.step == "mesh":
        mesh(args.kind, args.seed)
    else:
        render(args.kind, args.turn)
    return 0


if __name__ == "__main__":
    sys.exit(main())
