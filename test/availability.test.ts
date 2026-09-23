import { describe, expect, it } from 'vitest';
import { BUILDINGS, BuildingType } from '../src/shared/buildings/index.js';
import { TECHS, TechId } from '../src/shared/tech/index.js';
import { buildAvailability, researchAvailability, trainAvailability, Refusal } from '../src/ui/availability.js';

/**
 * Why an action cannot be taken.
 *
 * `tasks/plan.md` section F has recorded since September that "the command panel offers
 * actions that silently fail": Train on an unfinished building, and buildings or techs
 * that cannot be afforded. The click did nothing and said nothing, which is worse than
 * not offering the action at all — a player cannot tell a broken game from a rule they
 * have not learned.
 *
 * Pure, and tested here rather than in a browser, because the interesting part is the
 * ORDER: a village short of two things should be told about the one it is shortest of,
 * or the message changes as it earns half of what it needs and reads as noise.
 */

const rich = { grain: 10_000, wood: 10_000, cattle: 10_000 };

describe('building', () => {
  it('allows what the village can pay for', () => {
    expect(buildAvailability(BUILDINGS[BuildingType.Umuzi], rich)).toBe(Refusal.None);
  });

  it('names the resource that is missing', () => {
    const spec = BUILDINGS[BuildingType.Umuzi];
    expect(buildAvailability(spec, { ...rich, grain: 0 })).toBe(Refusal.Grain);
    expect(buildAvailability(spec, { ...rich, wood: 0 })).toBe(Refusal.Wood);
    expect(buildAvailability(spec, { ...rich, cattle: 0 })).toBe(Refusal.Cattle);
  });

  it('names the one the village is furthest from, not the first one checked', () => {
    // A umuzi costs 90 grain, 55 timber and 2 cattle. Short of both grain and timber,
    // the useful thing to say is which shortage is actually holding the village up —
    // and it has to stay the same answer while the smaller gap closes, or the message
    // flickers between two and reads as noise.
    const spec = BUILDINGS[BuildingType.Umuzi];
    expect(buildAvailability(spec, { grain: 89, wood: 0, cattle: 10 })).toBe(Refusal.Wood);
    expect(buildAvailability(spec, { grain: 0, wood: 54, cattle: 10 })).toBe(Refusal.Grain);
  });

  it('says a weir needs water, which is a place and not a price', () => {
    // The one refusal a player answers by walking somewhere else rather than by
    // waiting, so it outranks affordability: telling a player to save up for a weir
    // they are standing in the wrong place for is the wrong advice.
    const weir = BUILDINGS[BuildingType.Isiziba];
    expect(buildAvailability(weir, rich)).toBe(Refusal.NeedsWater);
    expect(buildAvailability(weir, { grain: 0, wood: 0, cattle: 0 })).toBe(Refusal.NeedsWater);
  });
});

describe('research', () => {
  it('refuses what is already known', () => {
    const spec = TECHS[TechId.Amabutho];
    expect(researchAvailability(spec, rich, true, false)).toBe(Refusal.AlreadyKnown);
  });

  it('refuses what is already being learned', () => {
    const spec = TECHS[TechId.Amabutho];
    expect(researchAvailability(spec, rich, false, true)).toBe(Refusal.InProgress);
  });

  it('puts knowing it ahead of being able to afford it', () => {
    // "You already have this" is true whatever the granary says, and a player told to
    // save up for something they own would go and do it.
    const spec = TECHS[TechId.Amabutho];
    expect(researchAvailability(spec, { grain: 0, wood: 0, cattle: 0 }, true, false)).toBe(
      Refusal.AlreadyKnown,
    );
  });

  it('otherwise names the shortage', () => {
    const spec = TECHS[TechId.Amabutho];
    expect(researchAvailability(spec, { ...rich, grain: 0 }, false, false)).toBe(Refusal.Grain);
    expect(researchAvailability(spec, rich, false, false)).toBe(Refusal.None);
  });
});

describe('training', () => {
  it('refuses on a site that is not built yet', () => {
    expect(trainAvailability(rich, false, 0, 5, { grain: 60, cattle: 0 })).toBe(Refusal.Unfinished);
  });

  it('puts being unbuilt ahead of the price', () => {
    expect(
      trainAvailability({ grain: 0, wood: 0, cattle: 0 }, false, 0, 5, { grain: 60, cattle: 0 }),
    ).toBe(Refusal.Unfinished);
  });

  it('refuses a full queue', () => {
    expect(trainAvailability(rich, true, 5, 5, { grain: 60, cattle: 0 })).toBe(Refusal.QueueFull);
  });

  it('allows an order the village can pay for on a finished building', () => {
    expect(trainAvailability(rich, true, 1, 5, { grain: 60, cattle: 0 })).toBe(Refusal.None);
  });
});
