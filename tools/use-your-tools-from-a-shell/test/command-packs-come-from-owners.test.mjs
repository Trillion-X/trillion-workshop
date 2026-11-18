import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import test from 'node:test';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { packFromOwners } from '../do-work/pack-from-owners.mjs';
import settings from '../do-work/command.json' with { type: 'json' };

const here = new URL('../do-work/', import.meta.url).pathname;
const tools = new URL('../../', import.meta.url).pathname;
const identityOf = path => makeHashCodeHexFromBytes(readFileSync(path));

test('every packed file is its owner\'s bytes, so none is kept by hand', () => {
  for (const row of settings.packs.files) assert.equal(identityOf(join(here, row.packed)), identityOf(join(tools, row.owner)), `${row.packed} differs from ${row.owner}; run do-work/pack-from-owners.mjs`);
});

test('a packed file imports only packed files, and the installed command carries every one', () => {
  const packed = new Set(settings.packs.files.map(row => normalize(row.packed)));
  for (const row of settings.packs.files) {
    assert.ok(settings.install.files.includes(row.packed), `${row.packed} is an install file`);
    const source = readFileSync(join(here, row.packed), 'utf8');
    for (const [, path] of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      assert.ok(packed.has(normalize(join(dirname(row.packed), path))), `${row.packed} imports ${path}, which is not packed`);
    }
  }
});

test('packing again from the owners changes no byte', () => {
  const before = settings.packs.files.map(row => identityOf(join(here, row.packed)));
  packFromOwners();
  assert.deepEqual(settings.packs.files.map(row => identityOf(join(here, row.packed))), before);
});
