# ADR-0024: Colour over period, in dress and dwellings

**Status:** Accepted — 2026-09-27

Reverses two choices the art pipeline had made for the sake of the 1815-1840 setting
(docs/CONTENT.md section 1). The project owner decided both on 2026-09-27, with the
conflict put to them first.

## Context

The owner supplied references for the people and the buildings. The people are in
modern Zulu ceremonial dress: the wide isicholo hat, beaded aprons, skirts and collars in
every colour, and leopard and cow hide. The buildings are almost all **Ndebele** painted
homesteads (Botshabelo, Mpumalanga): walled huts under thatch, the walls covered in bold
geometric painting.

The pipeline had been built the other way, deliberately:

- **Dwellings** were the Zulu iQhugwane, a beehive of thatch down to the ground with no
  wall. `mesh_pipeline.py` fought the image model to get it: asked for a Zulu hut, the
  model drew walled rondavels, "a Sotho and Xhosa form", and the umuzi was finally
  assembled from the one beehive reference that came out right. A beehive has no wall to
  paint.
- **Dress** was hide: the umutsha of hide and tails, the leather isidwaba, a hide cape.
  Glass beads reached the region by the 1820s, but as a scarce, controlled trade good.
  Beadwork in the quantities of the references, and the isicholo in its wide form, belong
  to the later nineteenth and the twentieth centuries. Ndebele wall painting as the
  references show it is mostly a twentieth-century practice.

Both choices also made the game hard to read. Hide, thatch and earth share one muted
range, and the owner reported that their own people were hard to find on the map.

## Decision

**Dwellings are painted-wall huts in the Ndebele style**, walls under a thatched roof.
Every building made from a mesh takes its reference from that form.

**People wear full ceremonial dress**, as the references show it.

**The player chooses what colour their people wear.** One garment on each figure (the
cloth, skirt, cape or hat) is generated in a key colour, vivid magenta, which appears
nowhere in the beadwork. `make_wild_mesh.py` finds that colour in the baked texture and
renders it twice: neutral in the body, and on its own in a pale `-team` pass with
everything else held out. The game tints that pass (`Livery.outfit`), so four colours,
or any number, cost one set of art. The same pass carries the blanket on the cattle.
The choice is in the setup menu. It also applies to a kept village, and it is
remembered in the browser.

## Consequences

- The game no longer claims period accuracy for dress or dwellings. docs/CONTENT.md
  still governs **names**: orthography, proper nouns and whose words describe the land.
  Those are unaffected.
- A painted-wall hut is the Ndebele form on every faction's buildings, including the
  amaZulu's. This is a stylisation, chosen for colour and legibility.
- The dignity check on every reference (CONTENT.md section 5) still applies, and the
  key colour has to be checked as well: a reference whose garment is not solid magenta
  gives a patchy overlay.
- The old reference images are superseded. Their prompts are replaced in
  `mesh_pipeline.py`, and the comments there explain why.
