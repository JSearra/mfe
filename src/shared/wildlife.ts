/**
 * The animals of the veld that nobody owns (ADR-0022).
 *
 * Shared, like the resource catalogue, because the renderer has to know which sprite a
 * species wears and the HUD what to call it, and neither may reach into `src/sim` for a
 * value. How each one BEHAVES — its numbers — lives in `tuning.json` under
 * `wildlife.species`, keyed by the name here, because that is simulation state and is
 * hashed into every replay.
 *
 * **Species values are durable.** They cross the worker boundary in the snapshot's
 * subtype byte and sit in saves, so a species is appended and a retired one leaves a
 * gap, exactly like the command and event enums (CLAUDE.md).
 */
export const Species = {
  Elephant: 0,
  Kudu: 1,
  Impala: 2,
  Eland: 3,
  Wildebeest: 4,
  Zebra: 5,
  Warthog: 6,
  Buffalo: 7,
  Hippo: 8,
  Lion: 9,
  Leopard: 10,
  Hyena: 11,
  GuineaFowl: 12,
  Ostrich: 13,
  Baboon: 14,
} as const;

export type Species = (typeof Species)[keyof typeof Species];

/**
 * What part a species plays.
 *
 * Game is hunted. Dangerous game is hunted and fights back. Predators hunt — the herd,
 * the game, and now and then a hunter — and are never hunted themselves (ADR-0019:
 * combat stays retired; a lion is weather with teeth). Scenery is life on the veld and
 * nothing more.
 */
export const Role = {
  Game: 0,
  Dangerous: 1,
  Predator: 2,
  Scenery: 3,
} as const;

export type Role = (typeof Role)[keyof typeof Role];

/**
 * Where a species wants to be, as the map can tell it.
 *
 * Water: within a few tiles of it — the hippo lives in it, the buffalo never strays far.
 * Open: the grass flats, low and middling ground. Broken: the high, stony, rougher
 * country — kudu and leopard. Anywhere: an elephant goes where it likes.
 */
export const Habitat = {
  Anywhere: 0,
  Water: 1,
  Open: 2,
  Broken: 3,
} as const;

export type Habitat = (typeof Habitat)[keyof typeof Habitat];

export interface SpeciesInfo {
  readonly species: Species;
  /** The key in `tuning.wildlife.species`, the sprite's kind name, and the i18n leaf. */
  readonly name: string;
  readonly role: Role;
  readonly habitat: Habitat;
}

export const SPECIES: readonly SpeciesInfo[] = [
  { species: Species.Elephant, name: 'elephant', role: Role.Dangerous, habitat: Habitat.Anywhere },
  { species: Species.Kudu, name: 'kudu', role: Role.Game, habitat: Habitat.Broken },
  { species: Species.Impala, name: 'impala', role: Role.Game, habitat: Habitat.Open },
  { species: Species.Eland, name: 'eland', role: Role.Game, habitat: Habitat.Open },
  { species: Species.Wildebeest, name: 'wildebeest', role: Role.Game, habitat: Habitat.Open },
  { species: Species.Zebra, name: 'zebra', role: Role.Game, habitat: Habitat.Open },
  { species: Species.Warthog, name: 'warthog', role: Role.Game, habitat: Habitat.Open },
  { species: Species.Buffalo, name: 'buffalo', role: Role.Dangerous, habitat: Habitat.Water },
  { species: Species.Hippo, name: 'hippo', role: Role.Dangerous, habitat: Habitat.Water },
  { species: Species.Lion, name: 'lion', role: Role.Predator, habitat: Habitat.Open },
  { species: Species.Leopard, name: 'leopard', role: Role.Predator, habitat: Habitat.Broken },
  { species: Species.Hyena, name: 'hyena', role: Role.Predator, habitat: Habitat.Anywhere },
  { species: Species.GuineaFowl, name: 'guineafowl', role: Role.Scenery, habitat: Habitat.Open },
  { species: Species.Ostrich, name: 'ostrich', role: Role.Scenery, habitat: Habitat.Open },
  { species: Species.Baboon, name: 'baboon', role: Role.Scenery, habitat: Habitat.Broken },
];

/** A species' entry, or the first one for a value this build does not know. */
export function speciesInfo(species: number): SpeciesInfo {
  return SPECIES[species] ?? SPECIES[0]!;
}

/** Whether people can hunt it. Predators and scenery are not quarry. */
export function isQuarry(species: number): boolean {
  const role = speciesInfo(species).role;
  return role === Role.Game || role === Role.Dangerous;
}
