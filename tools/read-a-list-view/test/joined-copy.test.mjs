// A joined copy (read-data/joined-copy.mjs): the file is the header and every row of the prefixes in order, written from
// the rows handed in, a second run writes nothing, a copy over its size is still written with a warning, a copy from no
// rows is refused, and the file on disk is changed only through the documents folder function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJoinedCopy } from '../read-data/joined-copy.mjs';
import { recipesFolder } from './support/stored.mjs';

const RULES = [
  ['setting:rule:b', 'setting', { text: 'Second rule.', order: 2 }],
  ['setting:rule:a', 'setting', { text: 'First rule.', order: 1 }],
  ['setting:rule:blank', 'setting', { text: '  ', order: 3 }],
  ['setting:other:x', 'setting', { text: 'Not a rule.', order: 0 }],
];
const stored = () => ({ records: RULES.map(([id, type, value]) => ({ id, type, value })) });

async function bakery(extra = {}) {
  const folder = await recipesFolder({ 'HOUSE.md': 'old text\n' });
  const spec = { root: folder.root, name: '/HOUSE.md', type: 'setting', prefixes: ['setting:rule:'], text_at: 'text', order_at: 'order',
    header: '# House rules', stored: stored(), ...extra };
  return { root: folder.root, spec, file: () => readFile(join(folder.root, 'HOUSE.md'), 'utf8') };
}

test('the file is the header and every row of the prefixes in order, and a second run writes nothing', async () => {
  const b = await bakery();
  const first = await writeJoinedCopy(b.spec);
  assert.equal(first.rows, 2);
  assert.equal(first.written, true);
  assert.equal(await b.file(), '# House rules\n\nFirst rule.\n\nSecond rule.\n');
  assert.equal((await writeJoinedCopy(b.spec)).written, false);
});

test('a copy over its size is still written with a warning; one with no rows is refused and the file is left as it was', async () => {
  const b = await bakery({ most_bytes: 10 });
  const over = await writeJoinedCopy(b.spec);
  assert.equal(over.written, true);
  assert.match(over.warning.words, /over the 10 to warn at/);
  await assert.rejects(writeJoinedCopy({ ...b.spec, prefixes: ['setting:rule:none-'] }), /not written from nothing/);
  assert.equal(await b.file(), '# House rules\n\nFirst rule.\n\nSecond rule.\n');
});

test('a dry run writes nothing, a missing stored list is refused, and a bad spec is refused', async () => {
  const b = await bakery();
  const planned = await writeJoinedCopy({ ...b.spec, dry_run: true });
  assert.equal(planned.written, false);
  assert.equal(await b.file(), 'old text\n');
  await assert.rejects(writeJoinedCopy({ ...b.spec, stored: undefined }), error => error.code === 'bad_input');
  await assert.rejects(writeJoinedCopy({ ...b.spec, name: '../out.md' }), /name is the copy/);
  await assert.rejects(writeJoinedCopy({ ...b.spec, most_bytes: 0 }), /most_bytes/);
});
