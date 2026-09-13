import { describe, expect, it } from 'vitest';
import { EventType, type SimEvent } from '../src/shared/events.js';
import { Modifier, TECHS, TechId, validateTechTree } from '../src/shared/tech/index.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { FactionId } from '../src/shared/factions/index.js';
import { createTechState } from '../src/sim/tech.js';

function setup(players = 2) {
  const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], 1);
  const tech = createTechState(players);
  economy.add(0, Resource.Grain, 5000);
  economy.add(0, Resource.Cattle, 200);
  return { economy, tech };
}

function research(tech: ReturnType<typeof createTechState>, id: TechId, events: SimEvent[] = []) {
  for (let i = 0; i <= TECHS[id].researchTicks; i++) tech.update(i, events);
}

describe('the tech tree', () => {
  it('is well formed', () => {
    // Catches the two mistakes a tech tree actually makes: a prerequisite that does not
    // exist, and a cycle that makes something permanently unresearchable in silence.
    expect(validateTechTree()).toEqual([]);
  });

  it('gives every advance an effect', () => {
    for (const spec of Object.values(TECHS)) {
      expect(Object.keys(spec.effects).length).toBeGreaterThan(0);
    }
  });
});

describe('research', () => {
  it('starts at no effect, so a system that forgets to ask behaves as before', () => {
    const { tech } = setup();
    for (const modifier of Object.values(Modifier)) {
      expect(tech.modifier(0, modifier)).toBe(1);
    }
  });

  it('charges for a start and refuses what cannot be paid for', () => {
    const { economy, tech } = setup();
    const spec = TECHS[TechId.Amabutho];
    const before = economy.balance(0, Resource.Grain);

    expect(tech.begin(0, TechId.Amabutho, economy)).toBe(true);
    expect(economy.balance(0, Resource.Grain)).toBe(before - spec.grainCost);

    // Player 1 starts with grain of their own, so empty it before testing refusal.
    economy.spend(1, Resource.Grain, economy.balance(1, Resource.Grain));
    expect(tech.begin(1, TechId.Amabutho, economy)).toBe(false);
  });

  it('honours prerequisites', () => {
    const { economy, tech } = setup();
    expect(tech.canResearch(0, TechId.CattleLore)).toBe(false);
    expect(tech.begin(0, TechId.CattleLore, economy)).toBe(false);

    tech.begin(0, TechId.Umkhosi, economy);
    research(tech, TechId.Umkhosi);

    expect(tech.isComplete(0, TechId.Umkhosi)).toBe(true);
    expect(tech.canResearch(0, TechId.CattleLore)).toBe(true);
  });

  it('will not start the same advance twice', () => {
    const { economy, tech } = setup();
    expect(tech.begin(0, TechId.Amabutho, economy)).toBe(true);
    expect(tech.begin(0, TechId.Amabutho, economy)).toBe(false);
  });

  it('takes time, then applies and announces', () => {
    const { economy, tech } = setup();
    const events: SimEvent[] = [];
    tech.begin(0, TechId.Amabutho, economy);

    tech.update(1, events);
    expect(tech.isComplete(0, TechId.Amabutho)).toBe(false);
    expect(tech.modifier(0, Modifier.CombatDamage)).toBe(1);

    research(tech, TechId.Amabutho, events);
    expect(tech.isComplete(0, TechId.Amabutho)).toBe(true);
    expect(tech.modifier(0, Modifier.CombatDamage)).toBeCloseTo(1.25, 6);
    expect(events.some((e) => e.type === EventType.TechCompleted)).toBe(true);
  });

  it('compounds two advances touching the same number', () => {
    const { economy, tech } = setup();
    tech.begin(0, TechId.Amabutho, economy);
    research(tech, TechId.Amabutho);
    tech.begin(0, TechId.MountedCommando, economy);
    research(tech, TechId.MountedCommando);

    // Multiplicative, so the later advance adds to the earlier rather than replacing it.
    expect(tech.modifier(0, Modifier.CombatDamage)).toBeCloseTo(1.25 * 1.1, 6);
    expect(tech.modifier(0, Modifier.MoveSpeed)).toBeCloseTo(1.2, 6);
  });

  it('benefits only the player who researched it', () => {
    const { economy, tech } = setup();
    tech.begin(0, TechId.Amabutho, economy);
    research(tech, TechId.Amabutho);

    expect(tech.modifier(0, Modifier.CombatDamage)).toBeGreaterThan(1);
    expect(tech.modifier(1, Modifier.CombatDamage)).toBe(1);
  });

  it('returns a neutral modifier for a player that does not exist', () => {
    const { tech } = setup(2);
    expect(tech.modifier(9, Modifier.CombatDamage)).toBe(1);
  });

  it('lowers herd stress rather than raising it', () => {
    const { economy, tech } = setup();
    tech.begin(0, TechId.Umkhosi, economy);
    research(tech, TechId.Umkhosi);
    tech.begin(0, TechId.CattleLore, economy);
    research(tech, TechId.CattleLore);

    // Below 1: a wider band for a herder to work in, which is the point of the advance.
    expect(tech.modifier(0, Modifier.HerdStress)).toBeLessThan(1);
  });
});
