/**
 * Entry point. Phase 0 has no renderer — see docs/ROADMAP.md.
 * Phase 1 replaces this with the Pixi bootstrap and the isometric camera.
 */
import { createLoop, runTicks } from './sim/loop.js';
import { CommandKind, makeCommand } from './sim/commands.js';
import { createWorld } from './sim/world.js';
import { tuning, tuningHash } from './sim/tuning.js';
import { formatHash } from './shared/hash.js';

const world = createWorld(tuning.world.defaultCapacity, 0x5eed);
const loop = createLoop(world, [makeCommand(0, 0, 0, CommandKind.Spawn, 8, 8, 1, 0)]);
runTicks(loop, 20);

const app = document.getElementById('app');
if (app) {
  app.textContent = `Phase 0 — simulation core. tick=${world.tick} live=${world.liveCount} tuning=${formatHash(tuningHash())}`;
}
