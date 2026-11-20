import { tempFolder } from '../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { workshopShellImportsPlugin } from 'trillion-workshop/tools/workspace-pieces/scripts/workshop-shell-imports.mjs';

function fixture(t, extra = {}) {
  const base = realpathSync(tempFolder(join(tmpdir(), 'runtime-build-paths-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const put = (file, text) => { mkdirSync(dirname(join(base, file)), { recursive: true }); writeFileSync(join(base, file), text); };
  const files = {
    'web/package.json': '{"imports":{"#workspace-value":"./src/value.mjs"}}',
    'web/scripts/workshop-shell-homes.json': '{"rows":[]}',
    'web/node_modules/trillion-workshop/tools/example/value.mjs': 'export const value = "verified-owner";',
    'web/entry.mjs': 'import { value } from "./src/value"; globalThis.answer = value;',
    ...extra,
  };
  for (const [file, text] of Object.entries(files)) put(file, text);
  return { base, root: join(base, 'web'), put };
}
const bundle = async (root, entry = 'entry.mjs') => (await build({ absWorkingDir: root, entryPoints: [entry], bundle: true,
  write: false, format: 'iife', logLevel: 'silent', plugins: [workshopShellImportsPlugin(root)] })).outputFiles[0].text;

test('a surviving app file retains its current bytes before feature migration', async t => {
  const { root } = fixture(t, { 'web/src/value.ts': 'export const value = "surviving-app";' });
  const output = await bundle(root);
  assert.match(output, /surviving-app/);
  assert.doesNotMatch(output, /verified-owner/);
});

test('an explicit shell adapter remains mandatory and never falls back to stale Workshop bytes', async t => {
  const { root } = fixture(t, {
    'web/scripts/workshop-shell-homes.json': JSON.stringify({ rows: [{ workshop: 'tools/example/value.mjs', shell: 'src/required-adapter.mjs', why: 'Synthetic newer product adapter' }] }),
    'web/node_modules/trillion-workshop/tools/example/part.json': JSON.stringify({ exports: { value: 'value.mjs' } }),
    'web/node_modules/trillion-workshop/tools/example/entry.mjs': 'import {value} from "./value.mjs"; globalThis.answer=value;',
  });
  await assert.rejects(bundle(root, 'node_modules/trillion-workshop/tools/example/entry.mjs'), /required-adapter/);
});
