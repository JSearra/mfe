import { describe, expect, it } from 'vitest';
import { createDepthOrder } from '../src/render/scene/depthOrder.js';

/** Run one frame and return the handles in draw order, back to front. */
function frame(
  order: ReturnType<typeof createDepthOrder>,
  entries: readonly (readonly [handle: number, depth: number])[],
  hysteresis = 0.12,
): number[] {
  const handles = Uint32Array.from(entries.map(([h]) => h));
  const depths = entries.map(([, d]) => d);
  const slots = order.order(entries.length, handles, (slot) => depths[slot]!, hysteresis);
  return slots.map((slot) => handles[slot]!);
}

describe('depth order', () => {
  it('sorts back to front on the first frame', () => {
    const order = createDepthOrder();
    expect(frame(order, [[1, 5], [2, 1], [3, 3]])).toEqual([2, 3, 1]);
  });

  // The whole reason this exists: forty cattle at near-identical depths must not
  // reshuffle every frame on floating-point noise.
  it('holds order through jitter smaller than the threshold', () => {
    const order = createDepthOrder();
    const first = frame(order, [[1, 10.0], [2, 10.01], [3, 10.02]]);

    for (let i = 0; i < 50; i++) {
      // Noise well inside the band, in both directions.
      const jitter = (i % 2 === 0 ? 1 : -1) * 0.03;
      const again = frame(order, [
        [1, 10.0 + jitter],
        [2, 10.01 - jitter],
        [3, 10.02 + jitter],
      ]);
      expect(again, `frame ${i}`).toEqual(first);
    }
    expect(order.swapsLastFrame).toBe(0);
  });

  it('still reorders once the gap is decisive', () => {
    const order = createDepthOrder();
    frame(order, [[1, 10.0], [2, 10.01]]);

    // One walks clearly in front of the other.
    expect(frame(order, [[1, 12.0], [2, 10.01]])).toEqual([2, 1]);
  });

  it('drops the dead without disturbing the rest', () => {
    const order = createDepthOrder();
    frame(order, [[1, 1], [2, 2], [3, 3], [4, 4]]);
    expect(frame(order, [[1, 1], [3, 3], [4, 4]])).toEqual([1, 3, 4]);
  });

  it('places a newcomer by depth rather than at the end', () => {
    const order = createDepthOrder();
    frame(order, [[1, 1], [3, 9]]);
    expect(frame(order, [[1, 1], [3, 9], [2, 5]])).toEqual([1, 2, 3]);
  });

  it('handles an empty frame and recovers', () => {
    const order = createDepthOrder();
    frame(order, [[1, 1], [2, 2]]);
    expect(frame(order, [])).toEqual([]);
    expect(frame(order, [[5, 3], [6, 1]])).toEqual([6, 5]);
  });

  it('does less work than a full sort when nothing much moved', () => {
    const order = createDepthOrder();
    const entries = Array.from({ length: 60 }, (_, i) => [i + 1, i * 0.5] as const);
    frame(order, entries);

    // A herd drifting together: every depth moves, none crosses another.
    frame(order, entries.map(([h, d]) => [h, d + 0.4] as const));
    expect(order.swapsLastFrame).toBe(0);
  });
});
