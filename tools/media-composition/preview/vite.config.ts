// Standalone browser preview of the media-composition visual editor (EditTimeline + a video
// preview of the AI-edited reel). Reuses the repo test config's alias set so `@/packages/...`
// and `@bitfield/runtime-kit/*` source imports resolve, and the automatic JSX transform so
// shared ui components render without an explicit `import React`.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { aiEditPlugin } from './ai-edit-endpoint.mjs';

const repoRoot = new URL('../../../', import.meta.url); // packages/media-composition/preview -> bitfield-packages
const runtimeKitJsRoot = new URL('../../../../bitfield-runtime-kit/packages/js/', import.meta.url);
const slotProtocolJsRoot = new URL('../../../../bitfield-runtime-kit/packages/slot-protocol-js/', import.meta.url);

export default defineConfig({
  plugins: [aiEditPlugin()],
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { port: 5178, fs: { allow: [fileURLToPath(repoRoot), fileURLToPath(runtimeKitJsRoot), fileURLToPath(slotProtocolJsRoot)] } },
  esbuild: { jsx: 'automatic' },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@bitfield/runtime-kit/internal/owner-surface', replacement: fileURLToPath(new URL('src/internal/owner-surface.ts', runtimeKitJsRoot)) },
      { find: '@bitfield/runtime-kit/protocol', replacement: fileURLToPath(new URL('src/protocol/index.ts', runtimeKitJsRoot)) },
      { find: '@bitfield/runtime-kit/react', replacement: fileURLToPath(new URL('src/react/index.ts', runtimeKitJsRoot)) },
      { find: '@bitfield/runtime-kit', replacement: fileURLToPath(new URL('src/index.ts', runtimeKitJsRoot)) },
      { find: '@bitfield/slot-protocol', replacement: fileURLToPath(new URL('index.js', slotProtocolJsRoot)) },
      { find: '@', replacement: fileURLToPath(repoRoot) },
    ],
  },
});
