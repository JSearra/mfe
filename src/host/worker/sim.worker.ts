/// <reference lib="webworker" />
import { makeCommand } from '../../sim/commands.js';
import { createCattleSystem } from '../../sim/cattle.js';
import { createCombatSystem } from '../../sim/combat.js';
import { createAi } from '../../sim/ai/opponent.js';
import { createConstructionSystem } from '../../sim/construction.js';
import { createEconomy, Resource, type Economy } from '../../sim/economy/ledger.js';
import { createLoop, enqueueCommand, step, TICK_MS, type SimLoop } from '../../sim/loop.js';
import { createMovementSystem } from '../../sim/movement.js';
import { buildSnapshot } from '../../sim/snapshot.js';
import { createHeightmap } from '../../sim/terrain/generate.js';
import { generateMap } from '../../sim/terrain/maps.js';
import { tuning } from '../../sim/tuning.js';
import { createFog, type FogState } from '../../sim/vision/fog.js';
import { createWorld, type World } from '../../sim/world.js';
import type { SimEvent } from '../../shared/events.js';
import type { PlayerState } from '../directHost.js';
import type { InitMessage, SnapshotMessage, ToWorker } from './protocol.js';

/**
 * The simulation, running off the main thread.
 *
 * It ticks itself on a drift-corrected clock rather than being pumped, which is the one
 * behavioural difference from DirectSimHost — and the reason SimHost's `pump` is a no-op
 * here rather than absent.
 *
 * Snapshots are TRANSFERRED, not copied. ADR-0004 corrected a misconception worth
 * restating: a worker needs no COOP/COEP headers, because those are a SharedArrayBuffer
 * requirement. Transferable ArrayBuffers give zero-copy postMessage with no
 * cross-origin isolation and no tearing risk.
 */

const MAX_PENDING_EVENTS = 4096;
/** Snapshots allowed in flight before the worker stops reporting. Real backpressure. */
const MAX_UNACKED = 3;
const MAX_CATCHUP_TICKS = 5;

let loop: SimLoop | null = null;
let world: World | null = null;
let economy: Economy | null = null;
let fog: FogState | null = null;
let viewerId = 0;
let playerId = 0;
let sequence = 0;

let pendingEvents: SimEvent[] = [];
let droppedEvents = 0;
let unacked = 0;
let sentFogVersion = -1;
let timer: ReturnType<typeof setInterval> | null = null;
let lastTime = 0;
let accumulator = 0;

function start(message: InitMessage): void {
  const map =
    message.mapScript === null
      ? createHeightmap(message.mapSize, message.mapSize, message.mapSeed)
      : generateMap(message.mapScript, message.mapSize, message.mapSize, message.mapSeed);
  world = createWorld(message.capacity, message.worldSeed);
  economy = createEconomy(message.factions, message.worldSeed);
  fog = createFog(Math.max(message.factions.length, message.viewerId + 1), map);
  viewerId = message.viewerId;
  playerId = message.playerId;

  const movement = createMovementSystem(map);
  loop = createLoop(
    world,
    movement,
    createCattleSystem(),
    createCombatSystem(),
    createConstructionSystem(map, movement.pathing),
    economy,
    fog,
    map,
  );
  for (const player of message.aiPlayers) loop.ai.push({ player, controller: createAi(player) });

  lastTime = performance.now();
  timer = setInterval(tick, TICK_MS / 2);
}

function tick(): void {
  if (loop === null || world === null || economy === null || fog === null) return;

  const now = performance.now();
  accumulator += now - lastTime;
  lastTime = now;

  let ticks = 0;
  while (accumulator >= TICK_MS && ticks < MAX_CATCHUP_TICKS) {
    step(loop);
    accumulator -= TICK_MS;
    ticks++;

    for (const event of loop.events) {
      if (pendingEvents.length >= MAX_PENDING_EVENTS) {
        pendingEvents.shift();
        droppedEvents++;
      }
      pendingEvents.push(event);
    }
    loop.events.length = 0;
  }
  if (accumulator > TICK_MS * MAX_CATCHUP_TICKS) accumulator = 0;
  if (ticks === 0) return;

  // Backpressure. A blocked or backgrounded main thread stops acknowledging, and the
  // worker stops reporting rather than filling its outbound queue until the tab dies.
  // The simulation keeps running; only the reporting pauses.
  if (unacked >= MAX_UNACKED) return;

  const droughtNow = economy.drought(world.tick);
  const player: PlayerState = {
    cattle: economy.balance(viewerId, Resource.Cattle),
    grain: economy.balance(viewerId, Resource.Grain),
    ammunition: economy.balance(viewerId, Resource.Ammunition),
    shortfall: economy.shortfall[viewerId] ?? 0,
    drought: droughtNow,
    droughtSevere: droughtNow >= tuning.economy.droughtThreshold,
  };

  let fogSlice: Uint8Array | null = null;
  if (fog.version !== sentFogVersion) {
    const tiles = fog.width * fog.height;
    fogSlice = fog.tiles.slice(viewerId * tiles, (viewerId + 1) * tiles);
    sentFogVersion = fog.version;
  }

  const snapshot = buildSnapshot(world, viewerId, fog);
  const events = pendingEvents;
  const dropped = droppedEvents;
  pendingEvents = [];
  droppedEvents = 0;
  unacked++;

  const message: SnapshotMessage = {
    type: 'snapshot',
    tick: world.tick,
    snapshot,
    events,
    droppedEvents: dropped,
    player,
    fog: fogSlice,
  };

  // Transfer rather than copy. The buffers are freshly built each tick and never read
  // again here, so handing over ownership is free.
  const transfer: Transferable[] = [snapshot];
  if (fogSlice !== null) transfer.push(fogSlice.buffer);
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

self.onmessage = (event: MessageEvent<ToWorker>): void => {
  const message = event.data;

  switch (message.type) {
    case 'init':
      start(message);
      return;

    case 'command':
      if (loop === null || world === null) return;
      enqueueCommand(
        loop,
        makeCommand(
          world.tick,
          playerId,
          sequence++,
          message.kind,
          message.a,
          message.b,
          message.c,
          message.d,
        ),
      );
      return;

    case 'ack':
      unacked = Math.max(0, unacked - 1);
      return;

    case 'stop':
      if (timer !== null) clearInterval(timer);
      timer = null;
      return;
  }
};

export {};
