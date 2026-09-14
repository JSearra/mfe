import { describe, expect, it } from 'vitest';
import { createFlightWindow } from '../src/host/worker/backpressure.js';

/**
 * The worker withholds snapshots when the renderer falls behind. Getting the accounting
 * wrong does not deadlock — it quietly shrinks the window until only one snapshot may be
 * in flight, which is not what MAX_UNACKED says and not what the comment claims.
 */
describe('flight window', () => {
  it('blocks once the window is full and opens again when it settles', () => {
    const flight = createFlightWindow(3);
    expect(flight.blocked()).toBe(false);

    flight.sent(10);
    flight.sent(11);
    expect(flight.blocked()).toBe(false);
    flight.sent(12);
    expect(flight.blocked()).toBe(true);

    flight.settle(12);
    expect(flight.blocked()).toBe(false);
    expect(flight.inFlight).toBe(0);
  });

  it('settles every snapshot at or before the acknowledged tick, not one per ack', () => {
    // The defect this guards. The main thread coalesces: three delivered snapshots
    // become one consumed snapshot and therefore one ack. Counting acks rather than
    // settling by tick left the window permanently two short, so after the first
    // hiccup the worker could only ever have one snapshot outstanding.
    const flight = createFlightWindow(3);
    flight.sent(10);
    flight.sent(11);
    flight.sent(12);

    flight.settle(12);

    expect(flight.inFlight).toBe(0);
    expect(flight.blocked()).toBe(false);
  });

  it('keeps snapshots newer than the acknowledged tick outstanding', () => {
    const flight = createFlightWindow(4);
    flight.sent(10);
    flight.sent(11);
    flight.sent(12);

    flight.settle(11);

    expect(flight.inFlight).toBe(1);
  });

  it('ignores a stale or duplicate acknowledgement', () => {
    const flight = createFlightWindow(3);
    flight.sent(10);
    flight.sent(11);

    flight.settle(11);
    flight.settle(11);
    flight.settle(5);

    expect(flight.inFlight).toBe(0);
  });

  it('never lets the record grow past the window', () => {
    const flight = createFlightWindow(3);
    for (let tick = 0; tick < 1000; tick++) {
      if (flight.blocked()) flight.settle(tick - 1);
      flight.sent(tick);
      expect(flight.inFlight).toBeLessThanOrEqual(3);
    }
  });
});
