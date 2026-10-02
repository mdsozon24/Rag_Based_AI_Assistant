import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // eslint-config-next registers jsx-a11y with a few rules; turn on its whole recommended set (WCAG)
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // Option cards wrap their input and text in nested spans
      'jsx-a11y/label-has-associated-control': ['error', { depth: 5 }],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'test-results/**', 'playwright-report/**', 'e2e/.tmp/**']),
]);
