// test/versioned-document.test.mjs: a versioned document keeps its evidence, migrates with a backup, and refuses a newer or damaged file untouched (F-0870). Its one-primary session half lives in tools/media-composition/test/session-pairing.test.mjs.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDocument } from '../versioned-document.mjs';

const folder = () => tempFolder(join(tmpdir(), 'doc-'));

test('a document stores entries with their evidence, migrates with a backup, and refuses a newer or damaged file untouched', () => {
  const file = join(folder(), 'profile.json');
  const v1 = openDocument({ file, version: 1, now: () => Date.parse('2026-10-19T00:00:00Z') });
  assert.throws(() => v1.set('tone', 'plain', ' '), /needs the evidence/);
  v1.set('tone', 'plain', 'message m-12');
  const migrations = { 1: doc => ({ ...doc, entries: Object.fromEntries(Object.entries(doc.entries).map(([k, e]) => [k, { ...e, value: { text: e.value } }])) }) };
  const v2 = openDocument({ file, version: 2, migrations });
  assert.deepEqual(v2.get('tone').value, { text: 'plain' });
  assert.equal(v2.get('tone').evidence, 'message m-12');
  assert.equal(JSON.parse(readFileSync(`${file}.v1.bak`, 'utf8')).version, 1, 'the old file was copied first');
  assert.throws(() => openDocument({ file, version: 1 }).read(), error => error.status === 409 && /newer than this program/.test(error.message));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2, 'a newer file is not rewritten');
  const broken = join(folder(), 'x.json'); writeFileSync(broken, '{nope');
  assert.throws(() => openDocument({ file: broken, version: 1 }).read(), /not readable JSON/);
  assert.equal(readFileSync(broken, 'utf8'), '{nope');
  const stuck = join(folder(), 's.json'); writeFileSync(stuck, JSON.stringify({ version: 1, entries: {} }));
  assert.throws(() => openDocument({ file: stuck, version: 3, migrations: { 1: d => d } }).read(), /No migration from version 2/);
  assert.equal(existsSync(`${stuck}.v1.bak`), true);
});

