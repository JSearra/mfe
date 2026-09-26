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

  /*
   * Game on the veld (ADR-0022), so the determinism gate covers the wild as well as the
   * people and the herds: grazing, flight from the spawned people as they wander past,
   * and — over 10,000 ticks — at least three breeding seasons. From a stream of its own,
   * so the commands above are drawn exactly as they always were.
   */
  const wild = createRng(seed ^ 0x3a11d);
  const bands: readonly (readonly [species: number, size: number])[] = [
    [2, 10], // impala
    [1, 4], // kudu
    [5, 7], // zebra
    [7, 8], // buffalo
    [9, 4], // lion
    [12, 8], // guinea fowl
  ];
  bands.forEach(([species, size], band) => {
    const x = 10 + nextInt(wild, 44);
    const y = 10 + nextInt(wild, 44);
    for (let n = 0; n < size; n++) {
      commands.push(
        makeCommand(0, 0, seq++, CommandKind.SpawnWild, x + nextSigned(wild) * 2, y + nextSigned(wild) * 2, species, band + 1),
      );
    }
  });

  /*
   * And people sent after them, so the hash covers the hunt: the stalk, the strike, the
   * yield and the bolt. The game holds the lowest slots (it spawns at tick zero, before
   * anybody); the people above it are whoever the stream above made. An order naming
   * somebody who is not a person, or not player 0's, is refused — that path is under
   * test too.
   */
  let game = 0;
  for (const [, size] of bands) game += size;
  for (let n = 0; n < 12; n++) {
    commands.push(
      makeCommand(400 + n * 150, 0, seq++, CommandKind.Hunt, packHandle(game + nextInt(wild, 24), 1), packHandle(nextInt(wild, game), 1)),
    );
  }

  return commands;
}
