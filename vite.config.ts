import { defineConfig } from 'vite';

export default defineConfig({
  // One fixed port, so the dev server is always at the same address. strictPort fails
  // loudly if it is taken rather than drifting to the next free one.
  server: {
    port: 5199,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
