import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Component tests run in jsdom against a mocked fetch: no API, no network.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@octo/web': path.resolve(import.meta.dirname, '../../packages/sdk/src/index.ts'),
      '@engine': path.resolve(import.meta.dirname, '../../packages/engine/src'),
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    testTimeout: 15000,
  },
});
