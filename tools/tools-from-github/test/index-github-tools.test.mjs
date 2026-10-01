// The GitHub index (index-github-tools.mjs): every sources row is one row on the person's own computer, each licence is
// one a class in licence-classes.json lists for that place, and a licence is read, never guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexRow, licenceOf } from '../index-github-tools.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const rows = read('../tool-rows.json').records.map(record => record.payload);
const sources = read('../sources.json').rows;
const classes = read('../../../licence-classes.json').records.map(record => record.payload);

test('every sources row became one row on the person\'s own computer, with a licence its class lists there', () => {
  assert.equal(rows.length, sources.length);
  for (const row of rows) {
    assert.deepEqual(row.placements, ['placement:caller-sandbox'], row.id);
    const cls = classes.find(item => item.id === row.licence_class);
    assert.ok(cls?.licences.includes(row.provenance.licence_spdx), `${row.id}: ${row.provenance.licence_spdx} is in ${row.licence_class}`);
    assert.ok(cls.allowed_placements.includes('placement:caller-sandbox'), row.id);
    assert.match(row.provenance.repository, /^https:\/\/github\.com\//);
    assert.ok(row.provenance.licence_read_from && row.provenance.read_on, `${row.id} says where and when its licence was read`);
    const source = sources.find(item => item.repo.toLowerCase() === row.provenance.repository.slice('https://github.com/'.length).toLowerCase());
    assert.ok(source, row.id);
    assert.equal(row.invoke.run, source.run);
  }
});

test('a licence is read, never guessed: GitHub\'s own id, or a licence file that says what its row claims', async () => {
  const github = { license: { spdx_id: 'NOASSERTION' }, default_branch: 'master' };
  const source = { repo: 'a/b', licence_file: 'LICENSE.md', licence_file_spdx: 'LGPL-2.1-or-later', licence_file_says: 'Lesser General Public License version 2.1' };
  const says = async text => licenceOf(source, github, async () => new Response(text));
  assert.deepEqual(await says('... the GNU Lesser General Public License version 2.1 or later ...'), { spdx: 'LGPL-2.1-or-later', read_from: 'https://raw.githubusercontent.com/a/b/master/LICENSE.md' });
  await assert.rejects(says('All rights reserved.'), /does not say/);
  await assert.rejects(licenceOf({ repo: 'a/b' }, github, async () => new Response('')), /names no licence/);
  assert.deepEqual(await licenceOf({ repo: 'a/b' }, { license: { spdx_id: 'MIT' } }, null), { spdx: 'MIT', read_from: 'GitHub\'s licence field for a/b' });
  assert.throws(() => indexRow({ repo: 'a/b', job: 'x', install: [], run: 'x' }, { html_url: 'https://github.com/a/b' }, { classes, licence: { spdx: 'LicenseRef-all-rights-reserved', read_from: 'x' }, read_on: '2026-09-29' }), /no licence class lists LicenseRef-all-rights-reserved/);
});
