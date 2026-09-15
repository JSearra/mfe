import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotWriter } from '../src/shared/snapshot.js';
import { EventType, makeEvent } from '../src/shared/events.js';
import { FactionId } from '../src/shared/factions/index.js';
import { CommandKind } from '../src/sim/commands.js';
import type { PlayerState } from '../src/host/directHost.js';
import type { FromWorker, ToWorker } from '../src/host/worker/protocol.js';

/**
 * The worker host's own logic — coalescing, acknowledgement and fog retention — tested
 * against a stub worker.
 *
 * The real worker is verified in a browser, including against a production build, since
 * Vite's dev and production worker handling differ and that difference is invisible to
 * anything running under Node. What is testable here is everything on the main-thread
 * side of the port, and that is where the subtle bugs live.
 */

const IDLE: PlayerState = {
  cattle: 0,
  grain: 0,
  ammunition: 0,
  wood: 0,
  shortfall: 0,
  drought: 0,
  droughtSevere: false,
  households: 0,
  householdsToSettle: 0,
  holdProgress: 0,
  outcome: 0,
  winner: -1,
  eliminated: false,
};

class StubWorker {
  static last: StubWorker | null = null;
  readonly sent: ToWorker[] = [];
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  terminated = false;

  constructor() {
    StubWorker.last = this;
  }

  postMessage(message: ToWorker): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Simulate the worker delivering a snapshot. */
  deliver(
    tick: number,
    options: { fog?: Uint8Array | null; woodland?: Float32Array | null; events?: number } = {},
  ): void {
    const writer = createSnapshotWriter(1, tick, 0);
    writer.handle[0] = 1;
    const message: FromWorker = {
      type: 'snapshot',
      tick,
      snapshot: writer.buffer,
      woodland: options.woodland ?? null,
      events: Array.from({ length: options.events ?? 0 }, () =>
        makeEvent(tick, EventType.Spawned, 1),
      ),
      droppedEvents: 0,
      player: { ...IDLE, grain: tick },
      fog: options.fog === undefined ? null : options.fog,
    };
    this.onmessage?.({ data: message } as MessageEvent<FromWorker>);
  }
}

vi.stubGlobal('Worker', StubWorker);

// Imported after the global is stubbed, since the host constructs a Worker eagerly.
const { createWorkerSimHost } = await import('../src/host/worker/workerHost.js');

function makeHost() {
  const host = createWorkerSimHost({
    mapSize: 32,
    mapSeed: 1,
    mapScript: null,
    worldSeed: 2,
    capacity: 64,
    factions: [FactionId.Zulu],
  });
  return { host, worker: StubWorker.last! };
}

describe('worker sim host', () => {
  beforeEach(() => {
    StubWorker.last = null;
  });

  it('initialises the worker with a seed rather than a map', () => {
    const { worker } = makeHost();
    const init = worker.sent[0];
    expect(init?.type).toBe('init');
    // Terrain generation is deterministic, so both sides build the same map from the
    // same seed; shipping 16KB of heightmap would only invite them to disagree.
    expect(JSON.stringify(init)).not.toContain('heightmap');
    expect(init).toMatchObject({ mapSeed: 1, worldSeed: 2, mapSize: 32 });
  });

  it('forwards commands', () => {
    const { host, worker } = makeHost();
    host.sendCommand(CommandKind.MoveTo, 7, 3, 4);
    expect(worker.sent.at(-1)).toMatchObject({ type: 'command', kind: CommandKind.MoveTo, a: 7 });
  });

  it('returns null until the worker reports', () => {
    const { host } = makeHost();
    expect(host.receive()).toBeNull();
  });

  // Backpressure again, on the consumer side this time.
  it('coalesces to the newest snapshot when the renderer falls behind', () => {
    const { host, worker } = makeHost();
    for (let tick = 1; tick <= 50; tick++) worker.deliver(tick);

    const message = host.receive();
    expect(message?.player.grain).toBe(50);
    expect(host.receive()).toBeNull();
    expect(host.tick).toBe(50);
  });

  it('keeps every event even while snapshots coalesce', () => {
    const { host, worker } = makeHost();
    worker.deliver(1, { events: 2 });
    worker.deliver(2, { events: 3 });

    // Snapshots are interchangeable; events are not, and dropping them silently loses
    // deaths and hits the renderer needed to animate.
    expect(host.receive()?.events).toHaveLength(5);
  });

  it('acknowledges only on consumption, which is what makes backpressure real', () => {
    const { host, worker } = makeHost();
    worker.deliver(1);
    worker.deliver(2);
    expect(worker.sent.filter((m) => m.type === 'ack')).toHaveLength(0);

    host.receive();
    expect(worker.sent.filter((m) => m.type === 'ack')).toHaveLength(1);
  });

  it('does not let a fog-less snapshot erase fog it has not handed over', () => {
    const { host, worker } = makeHost();
    const fog = new Uint8Array([2, 2, 1, 0]);

    worker.deliver(1, { fog });
    // Fog is only sent when it changes, so later snapshots carry none.
    worker.deliver(2);
    worker.deliver(3);

    expect(Array.from(host.receive()!.fog!)).toEqual([2, 2, 1, 0]);
    // And it is handed over once, not repeatedly.
    worker.deliver(4);
    expect(host.receive()!.fog).toBeNull();
  });

  it('stops and terminates the worker on dispose', () => {
    const { host, worker } = makeHost();
    host.dispose();
    expect(worker.sent.at(-1)).toMatchObject({ type: 'stop' });
    expect(worker.terminated).toBe(true);
  });

  it('ignores pump: the worker keeps its own clock', () => {
    const { host, worker } = makeHost();
    const before = worker.sent.length;
    host.pump(1000);
    expect(worker.sent.length).toBe(before);
  });
});
