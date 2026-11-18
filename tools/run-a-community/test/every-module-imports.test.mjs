import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const folder = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulesIn = dir => readdirSync(join(folder, dir), { recursive: true })
  .filter(name => /\.(mjs|ts)$/.test(name)).map(name => join(dir, name));

test('every module under do-work/ and read-data/ imports, so no module, export or imported name is missing', async () => {
  const failures = [];
  for (const file of [...modulesIn('do-work'), ...modulesIn('read-data')]) {
    try { await import(pathToFileURL(join(folder, file)).href); }
    catch (error) { failures.push(`${file}: ${error.message.split('\n')[0]}`); }
  }
  assert.deepEqual(failures, []);
});
