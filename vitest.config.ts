import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    /**
     * Well above the 5s default, because this suite is not only unit tests.
     *
     * The golden replay runs the simulation for 10,000 ticks and the AI soak plays a
     * match out; those are seconds of real work by design, not slow tests. On a
     * developer machine the replay takes about two of them, which sat comfortably under
     * the default — and on a CI runner, which is several times slower, it crossed 5s and
     * the determinism gate started failing on timing rather than on divergence. It was
     * intermittent first and then constant as the simulation grew: pursuit, order
     * queues and panic contagion each added per-tick work to those same 10,000 ticks.
     *
     * The same lesson as ADR-0016, in a different place. A wall-clock bound calibrated
     * on one machine measures the machine. Here the bound has no business being tight at
     * all — it exists to catch a hung test, and 30s catches one just as well as 5s does
     * while leaving room for work that legitimately takes seconds.
     */
    testTimeout: 30_000,
  },
});
