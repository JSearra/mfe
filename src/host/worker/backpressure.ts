/**
 * How many snapshots the worker allows in flight before it stops reporting.
 *
 * Real backpressure: a blocked or backgrounded main thread stops acknowledging, and the
 * worker stops reporting rather than filling its outbound queue until the tab dies. The
 * simulation keeps running; only the reporting pauses.
 *
 * The accounting has to settle by TICK, not by counting acknowledgements, because the
 * two do not correspond. The main thread coalesces on arrival — three snapshots
 * delivered while it was busy become one snapshot consumed and therefore one ack — so a
 * counter incremented per send and decremented per ack drifts upward and never comes
 * back down. That does not deadlock, because the send that fills the window always
 * leaves a snapshot pending for the renderer to consume, but it does shrink the window
 * to one after the first hiccup, which is neither what the constant says nor what the
 * comment promised. Acknowledging a tick settles everything sent at or before it, since
 * everything older was coalesced away rather than lost.
 */
export interface FlightWindow {
  /** Snapshots sent and not yet settled. */
  readonly inFlight: number;
  /** True when the renderer is far enough behind that reporting should pause. */
  blocked(): boolean;
  sent(tick: number): void;
  settle(ackedTick: number): void;
}

export function createFlightWindow(max: number): FlightWindow {
  // At most `max` entries, so shift() is bounded and the array never grows.
  const outstanding: number[] = [];

  return {
    get inFlight(): number {
      return outstanding.length;
    },
    blocked(): boolean {
      return outstanding.length >= max;
    },
    sent(tick: number): void {
      outstanding.push(tick);
    },
    settle(ackedTick: number): void {
      while (outstanding.length > 0 && outstanding[0]! <= ackedTick) outstanding.shift();
    },
  };
}
