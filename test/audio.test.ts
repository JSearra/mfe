import { describe, expect, it } from 'vitest';
import { chooseAmbience, type AmbienceView } from '../src/render/audio.js';

/**
 * The ambient mix: what the field sounds like, as opposed to what just happened.
 *
 * Events cannot carry this. A herd grazing and a column marching are STATES — nothing
 * happens at any particular tick — so they are read from the view. The policy is
 * separated from the playing precisely so it can be tested, because an AudioContext does
 * not exist here and the policy is the half worth checking.
 */

const KIND_UNIT = 0;
const KIND_CATTLE = 1;
const IDLE = 0;
const WALK = 1;
const STAMPEDE = 2;

function view(
  entries: readonly { kind: number; anim: number; stress?: number; x?: number; y?: number }[],
): AmbienceView {
  return {
    count: entries.length,
    x: new Float32Array(entries.map((e) => e.x ?? 0)),
    y: new Float32Array(entries.map((e) => e.y ?? 0)),
    kind: new Uint8Array(entries.map((e) => e.kind)),
    animState: new Uint8Array(entries.map((e) => e.anim)),
    stressPct: new Uint8Array(entries.map((e) => e.stress ?? 0)),
  };
}

const herd = (n: number, anim: number, stress = 0) =>
  Array.from({ length: n }, () => ({ kind: KIND_CATTLE, anim, stress }));

describe('ambient mix', () => {
  it('says nothing over empty ground', () => {
    const mix = chooseAmbience(view([]), 0, 0);
    expect(mix.herd).toBe(null);
    expect(mix.march).toBe(0);
  });

  it('lows over a settled herd', () => {
    expect(chooseAmbience(view(herd(20, IDLE)), 0, 0).herd).toBe('lowing');
  });

  it('turns restless when the herd is frightened', () => {
    expect(chooseAmbience(view(herd(20, IDLE, 200)), 0, 0).herd).toBe('restless');
  });

  it('rumbles when it breaks, and stops lowing while it does', () => {
    // The rule worth pinning: one herd makes ONE sound, the most urgent it has. A player
    // who can hear grazing and a stampede at once learns nothing from either.
    const mixed = view([...herd(16, IDLE), ...herd(6, STAMPEDE)]);
    expect(chooseAmbience(mixed, 0, 0).herd).toBe('rumble');
  });

  it('aggregates rather than sounding each animal', () => {
    // Loudness rises with the size of the herd and then stops, so forty cattle are a
    // herd rather than forty voices fighting over the mixer.
    //
    // Spread out, because a herd is. Stacking them on one point made the first version
    // of this test meaningless — every contribution weighted 1, so four animals clipped
    // the channel exactly as hard as forty, which turned out to be true of the mix as
    // well as of the test.
    const spread = (n: number) =>
      herd(n, IDLE).map((e, i) => ({ ...e, x: (i % 7) * 1.5, y: Math.floor(i / 7) * 1.5 }));
    const few = chooseAmbience(view(spread(4)), 0, 0);
    const many = chooseAmbience(view(spread(40)), 0, 0);
    expect(many.herdLoudness).toBeGreaterThan(few.herdLoudness);
    expect(many.herdLoudness).toBeLessThanOrEqual(1);
  });

  it('marches only when troops are actually moving', () => {
    const still = Array.from({ length: 20 }, () => ({ kind: KIND_UNIT, anim: IDLE }));
    const moving = Array.from({ length: 20 }, () => ({ kind: KIND_UNIT, anim: WALK }));
    expect(chooseAmbience(view(still), 0, 0).march).toBe(0);
    expect(chooseAmbience(view(moving), 0, 0).march).toBeGreaterThan(0);
  });

  it('ignores what is out of earshot', () => {
    // Far enough away contributes nothing, or the mix would swell whenever the camera
    // drifted across open ground with a herd somewhere beyond the horizon.
    const far = herd(30, IDLE).map((e) => ({ ...e, x: 500, y: 500 }));
    expect(chooseAmbience(view(far), 0, 0).herd).toBe(null);
  });

  it('pans toward the herd', () => {
    const right = herd(20, IDLE).map((e) => ({ ...e, x: 8 }));
    const left = herd(20, IDLE).map((e) => ({ ...e, x: -8 }));
    expect(chooseAmbience(view(right), 0, 0).herdPan).toBeGreaterThan(0);
    expect(chooseAmbience(view(left), 0, 0).herdPan).toBeLessThan(0);
  });
});
