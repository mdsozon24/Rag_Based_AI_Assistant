import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

// In your own app: npm install @octo/web, and drop this alias.
export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: { alias: { '@octo/web': path.resolve(here, '../../packages/sdk/src/index.ts') } },
  server: { port: 5174 },
});
