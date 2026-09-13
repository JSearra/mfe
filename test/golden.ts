import path from 'node:path';

export const GOLDEN_PATH = path.resolve('test/fixtures/golden-replay.json');

export interface GoldenFixture {
  seed: number;
  capacity: number;
  ticks: number;
  checkpointInterval: number;
  tuningHash: number;
  checkpoints: number[];
}
