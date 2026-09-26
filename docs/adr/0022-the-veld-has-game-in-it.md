# ADR-0022: The veld has game in it

**Status:** Accepted — 2026-09-26

Reverses the backlog entry in `docs/ROADMAP.md` that recorded wild animals as
"considered and deliberately not built". That entry said huntable game "would touch
entities, pathing and possibly the food economy" and "wants a design decision before
any code". This is that decision. The project owner made it on 2026-09-26.

## Context

The village has three kinds of food and they all work the same way. Fields, cattle and
fish are all managed close to home and are all steady. Nothing in the game is a gamble
worth taking, and nothing lives on the land except what the village put there.

The owner asked for hunters. They should go out after wild animals and rarely succeed,
but bring back a lot when they do. The game should include elephant, kudu and impala,
and predators that are a danger to the people who go out.

## Decision

**Resources are tracked separately.** Meat is not grain. The owner's words: "We need
separate tracking of meat, grain, water, skins, and possibly other resources in future."
The ledger gets meat, skins and ivory as columns of their own. They are appended after
cattle, grain and timber, so no existing index moves.

- **Meat** is food. People eat meat before grain, because it spoils fast and grain
  keeps. Cattle eat grain only, since fodder is not food. The cull now yields meat and
  skins where it used to yield grain.
- **Skins and ivory** are goods. They are for trade and for building with.
- **Water** is named but not built here. It needs rules for who draws it, who drinks it
  and what a drought does to it, and that is a phase of its own. The ledger is widened
  so that it drops in as one more column.

**Game is simulated.** Wild animals are entities of a new kind. They graze, flee from
people and regrow at their own rate, so a hunted-out range recovers slowly. Every
position they take goes through `MovementSystem.displace`, as cattle do (ADR-0018). The
roster:

- Game: elephant, kudu, impala, eland, blue wildebeest, Burchell's zebra, warthog.
- Dangerous game: Cape buffalo and hippo. These can be hunted, but they fight back.
- Predators: lion, leopard and spotted hyena.
- Scenery: helmeted guinea fowl, ostrich and chacma baboon. These cannot be hunted.

**Hunters get work both ways.** A hunters' camp draws hunters from nearby homesteads,
the same way every other workplace does (Phase B2). Any villager can also be sent after
a particular animal directly. Most hunts fail. A kill pays in meat, skins and, from an
elephant, ivory, far more than a season in a field.

**Predators are a disaster, not an enemy.** They do three things:

- **They take cattle.** They stalk the herd, kill a beast and frighten the rest, which
  feeds the stampede mechanic ADR-0014 built.
- **They maul hunters.** A mauled hunter is injured, not killed, and is laid up for a
  while.
- **They can be driven off.** Enough people close by turn a predator away.

Nobody hunts predators. ADR-0019 retired combat, and this does not bring it back. A lion
is weather with teeth, not a side.

## Consequences

- There is a new `EntityKind` (value 3), and new `CommandKind` and `EventType` values.
  Each is appended. Retired values stay gaps (CLAUDE.md).
- The replay hash changes, because the ledger is widened and wild herds spawn on the
  replay map. It is re-recorded under the CLAUDE.md procedure: self-agreement, and the
  old fixture reproduced without the change.
- The save format moves a version.
- Every new mechanic budgets for being told on screen (CLAUDE.md): alerts for a kill, a
  mauling and a lost beast, and readouts for the new stores and for a hunt in progress.
