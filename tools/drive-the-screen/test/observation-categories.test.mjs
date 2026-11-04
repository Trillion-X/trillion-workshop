// test/observation-categories.test.mjs
// Domain categories as DATA kept current by cursor-paged diffs with tombstones, feeding the observation rules (F-0141).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCategoryDiff, loadCategoryTable, syncCategories, withCategories } from '../read-data/observation-categories.mjs';
import { observationVerdict } from '../read-data/observation-rules.mjs';

const rules = { default_application: 'observe', default_website: 'observe', applications: [], websites: [] };

test('the shipped table is empty and sets no mode, so nothing is limited', () => {
  const table = loadCategoryTable(undefined, '/nonexistent');
  assert.deepEqual(table.rows, []);
  assert.equal(withCategories(rules, table, []), rules);
});

test('upserts replace by domain, tombstones remove, and a bad page changes nothing', () => {
  let table = applyCategoryDiff({ cursor: null, rows: [] }, { rows: [{ domain: 'Bank.example', category: 'finance' }, { domain: 'pills.example', category: 'health' }], next_cursor: 'c1' });
  table = applyCategoryDiff(table, { rows: [{ domain: 'pills.example', category: 'pharmacy' }], tombstones: ['bank.example'], next_cursor: 'c2' });
  assert.deepEqual(table, { cursor: 'c2', rows: [{ domain: 'pills.example', category: 'pharmacy' }] });
  assert.throws(() => applyCategoryDiff(table, { rows: [{ domain: '', category: 'x' }] }), /domain and a category/);
  assert.throws(() => applyCategoryDiff(table, 'nope'), /diff page/);
});

test('a category mode blocks every domain in it (subdomains too), and block beats allow', () => {
  const table = { cursor: 'c', rows: [{ domain: 'bank.example', category: 'finance' }, { domain: 'news.example', category: 'news' }] };
  const derived = withCategories(rules, table, [{ category: 'finance', mode: 'allow' }, { category: 'finance', mode: 'block' }]);
  assert.equal(observationVerdict(derived, { identities: ['safari'], domain: 'login.bank.example' }).why, 'website');
  assert.equal(observationVerdict(derived, { identities: ['safari'], domain: 'news.example' }).observe, true);
});

test('sync follows the cursor across pages, keeps the table on disk and resumes from it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'categories-'));
  const settings = { table: { cursor: null, rows: [] }, modes: [], sync: { source: 'https://example.invalid/diff', most_pages: 2, most_rows: 100, state_file: 'observation-categories.json' } };
  const pages = { null: { rows: [{ domain: 'a.example', category: 'x' }], next_cursor: 'p2', has_more: true }, p2: { rows: [{ domain: 'b.example', category: 'x' }], tombstones: ['a.example'], next_cursor: 'p3', has_more: true },
    p3: { rows: [{ domain: 'c.example', category: 'y' }], next_cursor: 'p4', has_more: false } };
  const asked = [];
  const fetchPage = async (_source, cursor) => { asked.push(cursor); return pages[cursor]; };
  const first = await syncCategories({ settings, home, fetchPage });
  assert.equal(first.pages, 2); assert.equal(first.more, true);
  const second = await syncCategories({ settings, home, fetchPage });
  assert.deepEqual(asked, [null, 'p2', 'p3']);
  assert.deepEqual(second.table.rows.map(row => row.domain), ['b.example', 'c.example']);
  console.log('readback state file:', await readFile(join(home, '.trillion/computer-sources/observation-categories.json'), 'utf8'));
});
