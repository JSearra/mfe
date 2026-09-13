import { defineConfig } from 'vitest/config';

/**
 * Performance gates, kept out of the default test run.
 *
 * They are slow by nature and they assert timings, which makes them the wrong thing to
 * have firing on every save. CI runs them explicitly.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['perf/**/*.test.ts'],
  },
});
