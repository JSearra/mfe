import { CommandKind, makeCommand, type Command } from '../src/sim/commands.js';
import { createRng, nextInt, nextSigned } from '../src/sim/math/rng.js';
import { packHandle } from '../src/sim/world.js';

export const GOLDEN_SEED = 0x5eed_beef;
export const GOLDEN_CAPACITY = 512;
export const GOLDEN_TICKS = 10_000;

/**
 * A deterministic command log with real churn: spawns, retargets and destroys.
 *
 * Some commands deliberately name handles that are already dead or whose generation
 * has moved on. Those are dropped by applyCommand, which is the behaviour we want
 * exercised — a command log recorded against a live game is full of them.
 */
export function buildScenario(seed: number, ticks: number): Command[] {
  const rng = createRng(seed);
  const commands: Command[] = [];
  let seq = 0;

  // Two players issuing on the same ticks, so command ordering is under test too.
  for (let tick = 0; tick < ticks; tick += 5) {
    const playerId = nextInt(rng, 2);

    if (tick % 20 === 0) {
      commands.push(
        makeCommand(
          tick,
          playerId,
          seq++,
          CommandKind.Spawn,
          nextSigned(rng) * 64,
          nextSigned(rng) * 64,
          nextInt(rng, 2),
        ),
      );
    }

    if (tick % 35 === 0) {
      commands.push(
        makeCommand(
          tick,
          playerId,
          seq++,
          CommandKind.MoveTo,
          packHandle(nextInt(rng, 64), 1),
          nextSigned(rng) * 64,
          nextSigned(rng) * 64,
        ),
      );
    }

    if (tick % 60 === 0) {
      commands.push(
        makeCommand(tick, playerId, seq++, CommandKind.Destroy, packHandle(nextInt(rng, 64), 1)),
      );
    }
  }

  return commands;
}
