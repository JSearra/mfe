import { describe, expect, it } from 'vitest';
import { FactionId } from '../src/shared/factions/index.js';
import { Season, SEASON_AT, seasonOf, trendOf, yearOf } from '../src/shared/calendar.js';
import { createEconomy } from '../src/sim/economy/ledger.js';
import { tuning } from '../src/sim/tuning.js';

/**
 * The year, said out loud.
 *
 * The economy has been seasonal since Phase 6 and the only thing on screen about it was
 * `Drought 0%` — a percentage, with no sense of where in the year it sat or which way
 * it was going. A village that plants is making a bet on the next few months, and it
 * could not see them.
 *
 * The season is derived from the drought rather than from a calendar of its own, which
 * is deliberate: a second clock beside the one that actually drives the harvest would
 * be two things to keep in step and one of them a fiction. What the player is told is
 * what the simulation is doing.
 */

const SEASON_TICKS = tuning.economy.seasonTicks;

describe('yearOf', () => {
  it('counts whole years off the tick', () => {
    expect(yearOf(0, SEASON_TICKS)).toBe(0);
    expect(yearOf(SEASON_TICKS - 1, SEASON_TICKS)).toBe(0);
    expect(yearOf(SEASON_TICKS, SEASON_TICKS)).toBe(1);
    expect(yearOf(SEASON_TICKS * 3 + 5, SEASON_TICKS)).toBe(3);
  });
});

describe('seasonOf', () => {
  it('names the wet end and the parched end', () => {
    expect(seasonOf(0)).toBe(Season.Rains);
    expect(seasonOf(1)).toBe(Season.GreatDry);
  });

  it('rises through every season without skipping one', () => {
    const seen: Season[] = [];
    for (let drought = 0; drought <= 1.0001; drought += 0.01) {
      const season = seasonOf(Math.min(drought, 1));
      if (seen[seen.length - 1] !== season) seen.push(season);
    }
    expect(seen).toEqual([Season.Rains, Season.Drying, Season.Dry, Season.GreatDry]);
  });

  it('turns great-dry exactly where the harvest is already ruined', () => {
    // droughtThreshold is where the project has always called a drought severe, and the
    // resource bar has flagged it in amber. The worst-named season agrees with it
    // rather than inventing a second opinion.
    expect(seasonOf(tuning.economy.droughtThreshold)).toBe(Season.GreatDry);
    expect(seasonOf(tuning.economy.droughtThreshold - 0.01)).not.toBe(Season.GreatDry);
  });
});

describe('trendOf', () => {
  it('says which way the year is going', () => {
    const economy = createEconomy([FactionId.Zulu, FactionId.Sotho], 1);
    // Find a tick where the drought is climbing, and one where it is easing, from the
    // real curve rather than from an assumption about its shape.
    let climbing = -1;
    let easing = -1;
    for (let tick = 0; tick < SEASON_TICKS * 4; tick += 200) {
      const now = economy.drought(tick);
      const next = economy.drought(tick + 200);
      if (climbing < 0 && next - now > 0.01) climbing = tick;
      if (easing < 0 && now - next > 0.01) easing = tick;
    }
    expect(climbing).toBeGreaterThanOrEqual(0);
    expect(easing).toBeGreaterThanOrEqual(0);

    expect(trendOf(economy.drought(climbing), economy.drought(climbing + 200))).toBe(1);
    expect(trendOf(economy.drought(easing), economy.drought(easing + 200))).toBe(-1);
    expect(trendOf(0.5, 0.5)).toBe(0);
  });
});

describe('the season boundary and the tuning file', () => {
  it('turns great-dry at exactly droughtThreshold', () => {
    // calendar.ts may not import the tuning file — it is shared, and the UI reads it —
    // so the number is written out there and pinned here. One opinion about when a year
    // has gone wrong, not two that can drift apart in silence.
    expect(SEASON_AT[SEASON_AT.length - 1]).toBe(tuning.economy.droughtThreshold);
  });
});
