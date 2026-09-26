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

# People, after the dress notes in make_unit.py (and docs/CONTENT.md): men in the umutsha
# of hide and tails, the married man's headring; women in the pleated leather isidwaba
# with a hide cape; cultivation with the short-handled hoe; loads on the head on a grass
# ring; herding boys' work, with a switch rather than a weapon. Every reference is looked
# at before it becomes a sprite — for accuracy and for dignity (CONTENT.md section 5).
PEOPLE = {
    "villager": "a Zulu man of the early nineteenth century standing relaxed, wearing a traditional umutsha loin covering of hide and animal tails and a fur headband, barefoot, hands empty at his sides",
    "herd-boy": "a Zulu herd boy of about twelve standing, wearing a small hide loin covering, barefoot, holding a long thin herding stick upright beside him",
    # Rewritten after the first three: "iron hoe" drew a garden fork, and "work the soil"
    # drew a heap of it, which would have become part of the mesh.
    "field-hand": "a Zulu woman of the early nineteenth century bending forward holding a short wooden-handled hoe with one broad flat iron blade, wearing a pleated leather isidwaba skirt and a hide cape over her shoulders, barefoot, standing on nothing, no soil",
    # "On a coiled grass ring" drew the ring on the ground round her feet.
    "carrier": "a Zulu woman of the early nineteenth century standing upright, balancing a large round clay pot on top of her head, one hand steadying it, wearing a pleated leather isidwaba skirt and a hide cape over her shoulders, barefoot, nothing on the ground",
    "elder": "an elderly Zulu man of the early nineteenth century standing, wearing a hide cloak over his shoulders and a black headring, barefoot, leaning on a long wooden staff",
    "hunter": "a Zulu hunter of the early nineteenth century standing, wearing a hide loin covering, barefoot, carrying two long throwing spears slanting forward",
}
PEOPLE_STYLE = (
    "whole figure in frame from head to feet, three-quarter view from the front left, "
    "isolated on a plain pure white background, even soft studio lighting, sharp focus, "
    "realistic, historically accurate, dignified"
)

BUILDINGS = {
    # Said precisely after the first three came back as rondavels — conical roofs on mud
    # walls, a Sotho and Xhosa form. The iQhugwane has no walls: the thatch dome comes
    # down to the ground (docs/CONTENT.md).
    "umuzi": "a small group of three traditional Zulu iQhugwane beehive huts, each one a rounded dome made entirely of thatched grass that reaches all the way down to the ground like an upturned basket, with no walls and no conical roof, a small low arched doorway, on bare earth",
    "isibaya": "a large empty circular cattle enclosure, a ring fence of stacked thorn branches between wooden posts, standing on bare earth",
    "grain-store": "a small traditional African granary, a woven grass storage basket with a conical thatched roof raised on short wooden stilts",
    "ikhanda": "a large traditional Zulu homestead, many beehive grass huts arranged in a wide ring around an open central cattle enclosure",
    "indlunkulu": "a single large traditional Zulu great hut, a big beehive dome of woven grass thatch with an arched doorway, standing on bare earth",
    "umgodi": "a sealed traditional grain storage pit, a small low round mound of packed earth with a flat stone lid on top",
    "isiziba": "a small weir of stacked grey stones and wooden stakes, built across the end of a narrow stream",
    "goat-fold": "a small square livestock pen fenced with woven branches, with a small thatched lean-to shelter in one corner, standing on bare earth",
    "hunters-camp": "a small hunters' camp: a wooden A-frame drying rack with two animal hides hanging on it, beside a small low dome shelter of grass",
    "well": "a traditional water well, a low ring of stacked stones around a dark shaft, with a wooden frame over it holding a clay pot on a rope",
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
    "elephant": "whole animal in frame from trunk to tail and feet, side view in profile facing left, slightly from the front, "
    "isolated on a plain pure white background, even soft studio lighting, sharp focus, realistic wildlife photograph",
}


def sources() -> dict:
    return json.loads(SOURCES.read_text()) if SOURCES.exists() else {}


def prompt_for(kind: str) -> str:
    if kind in PEOPLE:
        return f"photograph of {PEOPLE[kind]}, {PEOPLE_STYLE}"
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


def mesh(kind: str, seed: int) -> None:
    folder = RAW / kind
    ref = folder / f"ref_{seed}.png"
    if not ref.exists():
        raise SystemExit(f"no reference {ref}; run `refs {kind}` first")
    subprocess.run(
        [str(TRIPO_PYTHON), str(TRIPO), str(ref), "--output-dir", str(folder / "tripo"),
         "--mc-resolution", "256", "--bake-texture", "--texture-resolution", "1024"],
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
    builder = "make_building_mesh.py" if kind in BUILDINGS else "make_wild_mesh.py"
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
    names = {entry["file"] for entry in new}
    for entry in new:
        shutil.copy(trimmed / entry["file"], SPRITES / entry["file"])
    manifest_path = SPRITES / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["sprites"] = sorted(
        [e for e in manifest["sprites"] if e["file"] not in names] + new, key=lambda e: e["file"]
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
    parser.add_argument("kind", choices=sorted({**SUBJECTS, **PEOPLE, **BUILDINGS}))
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
