// packages/content-gate/vitest.config.mjs
//
// Focused vitest config for the content-gate package.
// Mirrors the workspace root config (vitest.config.ts) alias setup so that
// @/ imports resolve correctly when running tests in isolation via:
//   npx vitest run --configLoader runner --config packages/content-gate/vitest.config.mjs packages/content-gate/__tests__
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@',
        replacement: root,
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/content-gate/__tests__/**/*.test.ts'],
  },
});
