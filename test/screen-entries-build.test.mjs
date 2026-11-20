// The screen entries named by the Write, board and media-editor rows must bundle for the browser. The page bundles a
// screen's entry file with esbuild for the browser platform, and resolves the page's own import map: `#workspace*` is
// tools/workspace-screens/web/src/workspace and `trillion-workshop/<path>` is this Workshop. A node-only import (node:url,
// node:fs) or a relative import of a file that moved fails here, so a screen cannot ship with a dangling import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
const pageWorkspace = join(root, 'tools/workspace-screens/web/src/workspace');

const pageImportMap = {
  name: 'page-import-map',
  setup(builder) {
    builder.onResolve({ filter: /^#workspace/ }, (args) => {
      if (args.path === '#workspace-records') return { path: join(pageWorkspace, 'records.ts') };
      if (args.path === '#workspace-list-rules') return { path: join(pageWorkspace, 'list-rules.ts') };
      const match = args.path.match(/^#workspace\/(.*)$/);
      return match ? { path: join(pageWorkspace, match[1]) } : undefined;
    });
    builder.onResolve({ filter: /^trillion-workshop\// }, (args) => ({ path: join(root, args.path.slice('trillion-workshop/'.length)) }));
  },
};

// The entry file each row names: Write (tool:screen-write, its package documents), its copy in edit-a-document-together,
// the board (package organize-the-sidebar, show/board-screen.tsx) and the media editor (show/media-edit-mount.tsx).
const entries = [
  'tools/documents/show/write-screen.tsx',
  'tools/edit-a-document-together/show/write-screen.tsx',
  'tools/organize-the-sidebar/show/board-screen.tsx',
  'tools/show-the-media-library-and-search-what-was/show/media-edit-mount.tsx',
];

for (const entry of entries) {
  test(`${entry} bundles for the browser`, async () => {
    const result = await build({
      entryPoints: [join(root, entry)],
      absWorkingDir: root,
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
      plugins: [pageImportMap],
      loader: { '.ts': 'ts', '.tsx': 'tsx', '.json': 'json', '.css': 'empty', '.wasm': 'empty' },
    });
    assert.equal(result.errors.length, 0);
    assert.ok(result.outputFiles[0].contents.length > 0);
  });
}
