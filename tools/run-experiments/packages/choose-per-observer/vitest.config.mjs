// packages/choose-per-observer/vitest.config.mjs
//
// Focused vitest config for the choose-per-observer package.
// Mirrors the workspace root config alias setup so that @/ imports resolve
// correctly when running tests in isolation via:
//   npx vitest run --config packages/choose-per-observer/vitest.config.mjs packages/choose-per-observer/__tests__
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
  },
});
