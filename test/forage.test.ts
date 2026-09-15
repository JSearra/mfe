import { describe, expect, it } from 'vitest';
import { createForage, createForagePatches, updateForage } from '../src/sim/economy/forage.js';
import { createEconomy, Resource } from '../src/sim/economy/ledger.js';
import { FactionId } from '../src/shared/factions/index.js';
import { tuning } from '../src/sim/tuning.js';
import { createWorld, spawn, type World } from '../src/sim/world.js';
import { flatMap } from './simHarness.js';
import { heightmapFrom } from '../src/shared/heightmap.js';

const F = tuning.forage;

/** Ground in the middle bands, which is where the veld carries anything. */
const veld = (size = 48) => flatMap(size, F.minBand + 1);

function bench(size = 48) {
  const map = veld(size);
  const world = createWorld(64, 3);
  const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], 3, []);
  const forage = createForage(map, 3);
  return { map, world, economy, forage };
}

/** Put `count` villagers of `player` inside the first patch. */
function sendGatherers(world: World, forage: ReturnType<typeof createForage>, count: number, player = 0) {
  const patch = forage.patches[0]!;
  for (let i = 0; i < count; i++) {
    spawn(world, patch.tileX + 0.5 + i * 0.2, patch.tileY + 0.5, player);
  }
  return patch;
}

describe('where the veld carries food', () => {
  it('puts patches only on ground that would grow anything', () => {
    // The wet bottom and the stone tops carry nothing; the middle bands do.
    const patches = createForagePatches(veld(48), 1);
    expect(patches.length).toBeGreaterThan(0);

    const barren = createForagePatches(flatMap(48, 0), 1);
    expect(barren, 'the riverbed should carry no forage').toEqual([]);

    const stone = createForagePatches(flatMap(48, 7), 1);
    expect(stone, 'bare rock should carry no forage').toEqual([]);
  });

  it('spreads them out rather than clustering', () => {
    const patches = createForagePatches(veld(64), 5);
    const spacing = F.gatherRadius * 2.5;

    for (let i = 0; i < patches.length; i++) {
      for (let j = i + 1; j < patches.length; j++) {
        const dx = patches[i]!.tileX - patches[j]!.tileX;
        const dy = patches[i]!.tileY - patches[j]!.tileY;
        expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThanOrEqual(spacing);
      }
    }
  });

  it('lays the same veld out twice, so two machines agree', () => {
    const a = createForagePatches(veld(48), 99);
    const b = createForagePatches(veld(48), 99);
    expect(a).toEqual(b);
    // ...and a different map is a different veld.
    expect(createForagePatches(veld(48), 100)).not.toEqual(a);
  });
});

describe('gathering', () => {
  it('feeds whoever is standing in the patch', () => {
    const { world, economy, forage } = bench();
    sendGatherers(world, forage, 2);

    const before = economy.balance(0, Resource.Grain);
    updateForage(world, forage, economy, 1);

    expect(economy.balance(0, Resource.Grain)).toBeGreaterThan(before);
    // Nobody else worked, so nobody else eats.
    expect(economy.balance(1, Resource.Grain)).toBe(
      createEconomy([FactionId.Zulu, FactionId.Sotho], 3, []).balance(1, Resource.Grain),
    );
  });

  it('pays nothing to a village that sent nobody', () => {
    const { world, economy, forage } = bench();
    const before = economy.balance(0, Resource.Grain);
    updateForage(world, forage, economy, 1);
    expect(economy.balance(0, Resource.Grain)).toBe(before);
  });

  it('takes the food out of the ground it came from', () => {
    const { world, economy, forage } = bench();
    sendGatherers(world, forage, 2);

    const stockBefore = forage.stock[0]!;
    const grainBefore = economy.balance(0, Resource.Grain);
    updateForage(world, forage, economy, 0);

    const gained = economy.balance(0, Resource.Grain) - grainBefore;
    const lost = stockBefore - forage.stock[0]!;
    // Not equal, and deliberately: even a drought regrows a little, so the ground is
    // down by slightly less than the village took. It must never be down by MORE.
    expect(gained).toBeGreaterThan(0);
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThanOrEqual(gained + 1e-9);
  });

  it('gives diminishing returns to a crowd', () => {
    const few = bench();
    sendGatherers(few.world, few.forage, 2);
    const a = few.economy.balance(0, Resource.Grain);
    updateForage(few.world, few.forage, few.economy, 1);
    const withTwo = few.economy.balance(0, Resource.Grain) - a;

    const many = bench();
    sendGatherers(many.world, many.forage, F.maxGatherers * 3);
    const b = many.economy.balance(0, Resource.Grain);
    updateForage(many.world, many.forage, many.economy, 1);
    const withCrowd = many.economy.balance(0, Resource.Grain) - b;

    // More hands bring more food...
    expect(withCrowd).toBeGreaterThan(withTwo);
    // ...but nothing like proportionally. A patch of veld does not yield six times
    // faster because six times as many people are picking it over, and that is what
    // keeps foraging worth less per head than a farm.
    expect(withCrowd).toBeLessThan(withTwo * 3);
  });

  it('runs a patch down to what it can regrow and no further', () => {
    const { world, economy, forage } = bench();
    sendGatherers(world, forage, F.maxGatherers);

    const full = forage.stock[0]!;
    for (let cycle = 0; cycle < 200; cycle++) updateForage(world, forage, economy, 0);

    // Stripped, but not sterile. A worked-out patch settles at whatever it can put back
    // between visits, so standing on it forever pays a trickle rather than nothing —
    // which is the difference between exhausting ground and destroying it.
    expect(forage.stock[0]!).toBeLessThan(full * 0.1);

    const grain = economy.balance(0, Resource.Grain);
    updateForage(world, forage, economy, 0);
    const trickle = economy.balance(0, Resource.Grain) - grain;
    expect(trickle).toBeGreaterThan(0);
    expect(trickle).toBeLessThan(F.perGathererPerUpkeep);
  });
});

describe('regrowth', () => {
  it('brings a stripped patch back if it is left alone', () => {
    const { world, economy, forage } = bench();
    forage.stock[0] = 0;

    for (let cycle = 0; cycle < 100; cycle++) updateForage(world, forage, economy, 1);
    expect(forage.stock[0]!).toBeGreaterThan(0);
  });

  it('recovers more slowly in a drought', () => {
    const wet = bench();
    const dry = bench();
    wet.forage.stock[0] = 0;
    dry.forage.stock[0] = 0;

    for (let cycle = 0; cycle < 20; cycle++) {
      updateForage(wet.world, wet.forage, wet.economy, 1);
      updateForage(dry.world, dry.forage, dry.economy, 0);
    }
    expect(wet.forage.stock[0]!).toBeGreaterThan(dry.forage.stock[0]!);
    // Never to nothing: the veld is the fallback when the fields fail, so a drought
    // must slow it rather than switch it off.
    expect(dry.forage.stock[0]!).toBeGreaterThan(0);
  });

  it('never grows a patch past what that ground holds', () => {
    const { world, economy, forage } = bench();
    for (let cycle = 0; cycle < 500; cycle++) updateForage(world, forage, economy, 1);

    const richest = Math.max(...forage.patches.map((p) => p.richness));
    const cap = tuning.forage.patchStock * (0.4 + 0.6 * richest);
    for (const stock of forage.stock) expect(stock).toBeLessThanOrEqual(cap + 1e-9);
  });
});

describe('what foraging is worth', () => {
  it('pays less per head than a plot, so it is a fallback and not a strategy', () => {
    const { world, economy, forage } = bench();
    sendGatherers(world, forage, F.maxGatherers);

    const before = economy.balance(0, Resource.Grain);
    updateForage(world, forage, economy, 1);
    const foraged = economy.balance(0, Resource.Grain) - before;

    // What the same village's farmland pays in the same cycle, in fair weather.
    const farmed = tuning.economy.plotsPerPlayer * tuning.economy.plotBaseYield;
    expect(foraged).toBeLessThan(farmed);
  });

  it('asks for no land committed in advance', () => {
    // The whole point of the loop: a patch needs no placement, no cost and no work to
    // establish. Standing in it is the entire interface.
    const map = heightmapFrom(
      Array.from({ length: 24 }, () => Array.from({ length: 24 }, () => F.minBand + 1)),
      8,
    );
    const forage = createForage(map, 7);
    expect(forage.patches.length).toBeGreaterThan(0);
    for (const stock of forage.stock) expect(stock).toBeGreaterThan(0);
  });
});
