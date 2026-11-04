// test/own-writes.test.mjs
// A file Trillion's own work writes into a read folder is not read back as new (F-0317).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'own-writes-home-'));
process.env.HOME = home;
const { noteOwnWrite, isOwnWrite } = await import('../computer/own-writes.mjs');
const { READERS } = await import('../computer/read-new-items.mjs');

test('a noted path is suppressed until its time ends, then read as new again', () => {
  const settings = { file: 'own-writes.json', ttl_seconds: 10, most_paths: 2 };
  noteOwnWrite('/tmp/a', { now: 1000, settings, home });
  assert.equal(isOwnWrite('/tmp/a', { now: 5000, settings, home }), true);
  assert.equal(isOwnWrite('/tmp/a', { now: 11001, settings, home }), false);
  noteOwnWrite('/tmp/b', { now: 2000, settings, home });
  noteOwnWrite('/tmp/c', { now: 3000, settings, home });
  assert.equal(isOwnWrite('/tmp/a', { now: 3500, settings, home }), false, 'oldest note dropped past most_paths');
});

test('the folder read passes over what Trillion wrote and still sends what the person added', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'own-writes-folder-'));
  await writeFile(join(folder, 'person.txt'), 'by the person');
  await writeFile(join(folder, 'ai.txt'), 'by an AI');
  noteOwnWrite(join(folder, 'ai.txt'), { home });
  const items = READERS.folder({ store: folder, text: '{name}' }, new Date(0));
  assert.deepEqual(items.map(item => item.title), ['person.txt']);
  console.log('readback items:', JSON.stringify(items.map(item => item.title)), 'notes file:', await readFile(join(home, '.trillion/computer-sources/own-writes.json'), 'utf8'));
});
