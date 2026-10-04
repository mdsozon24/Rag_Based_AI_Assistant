import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    // The dashboard runs its own component tests (jsdom): npm run dashboard:test
    exclude: ['**/node_modules/**', 'apps/dashboard/**'],
    environment: 'node',
    testTimeout: 20000,
    // Each API test file starts its own in-memory Postgres (PGlite); with every file in parallel,
    // setup can take well over the 10 s default on a busy machine
    hookTimeout: 60000,
  },
});
