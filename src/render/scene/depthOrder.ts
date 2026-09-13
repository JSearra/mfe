/**
 * Stable draw order for overlapping entities.
 *
 * A plain sort by depth is correct and looks broken. Forty cattle moving together sit at
 * near-identical depths, so floating-point noise flips their relative order every frame
 * and the herd shimmers — which is the state the game's headline mechanic is most often
 * seen in. ARCHITECTURE section 4 specified hysteresis for exactly this; this is it.
 *
 * Two ideas, and they reinforce each other:
 *
 * 1. The order PERSISTS across frames, keyed by handle. Entities barely move between
 *    frames, so last frame's order is nearly right and only needs repairing.
 * 2. Repair is an insertion pass that only swaps a pair once one is deeper than the
 *    other by more than a threshold. Inside that band the existing order stands, so
 *    near-ties stop oscillating.
 *
 * Insertion sort is the right algorithm here rather than a concession: on nearly-sorted
 * input it is O(n), where a general sort is O(n log n) and — more importantly — throws
 * away the previous order that the hysteresis depends on.
 *
 * The result depends on history, so two clients watching the same match can draw an
 * overlapping herd in different orders. That is FINE, and worth saying plainly because
 * it would be a defect anywhere under src/sim: draw order is presentation. It changes
 * nothing either player can act on, and no hash depends on it.
 */

export interface DepthOrder {
  /**
   * Returns slot indices into the view, back to front.
   * The array is reused between frames; do not retain it.
   */
  order(
    count: number,
    handles: Uint32Array,
    depth: (slot: number) => number,
    hysteresis: number,
  ): number[];
  /** Entities whose relative order changed this frame. For tests and diagnostics. */
  swapsLastFrame: number;
}

export function createDepthOrder(): DepthOrder {
  /** Last frame's order, as handles — indices are not stable across snapshots. */
  const previous: number[] = [];
  const slots: number[] = [];
  const seen = new Map<number, number>();

  const state: DepthOrder = {
    swapsLastFrame: 0,

    order(count, handles, depth, hysteresis): number[] {
      seen.clear();
      for (let slot = 0; slot < count; slot++) seen.set(handles[slot]!, slot);

      // Carry forward everything that still exists, in the order it had. Anything that
      // died simply drops out, which costs nothing and preserves the rest.
      slots.length = 0;
      for (const handle of previous) {
        const slot = seen.get(handle);
        if (slot === undefined) continue;
        slots.push(slot);
        seen.delete(handle);
      }
      // Whatever is left is new this frame; it has no history to preserve.
      for (const slot of seen.values()) slots.push(slot);

      // Insertion pass with a dead band.
      let swaps = 0;
      for (let i = 1; i < slots.length; i++) {
        const slot = slots[i]!;
        const value = depth(slot);
        let j = i - 1;

        while (j >= 0) {
          // Only reorder when the gap is decisive. Inside the band the existing order
          // stands, which is the entire point: near-ties must stop oscillating.
          if (depth(slots[j]!) - value < hysteresis) break;
          slots[j + 1] = slots[j]!;
          j--;
          swaps++;
        }
        slots[j + 1] = slot;
      }

      state.swapsLastFrame = swaps;

      previous.length = 0;
      for (const slot of slots) previous.push(handles[slot]!);
      return slots;
    },
  };

  return state;
}
