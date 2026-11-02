// tools/write-public-share-files/test/list-copy.test.mjs (moved from Trillion's test/list-copy.test.mjs)
//
// What of a list leaves through a share link (read-data/list-copy.mjs), decided by the Workshop's formula engine
// (tools/formulas): a row shows only while its own Shown when rule holds at the moment the link is read (a date in the
// future hides it, a number of opens reveals it), an unfinished rule hides its row, the rule field itself never leaves,
// and only files that shown rows name leave, each by its identity. A saved view leaves only through the view projection
// its caller hands in; with none, no view leaves (Trillion's own test of this file runs it with Trillion's projection).
import assert from 'node:assert/strict';
import test from 'node:test';
import { filterRecords } from '../../formulas/do-work/requests.mjs';
import { listCopy } from '../read-data/list-copy.mjs';

const filterRows = ({ tree, fields, rows }) => { const { matches, incomplete } = filterRecords({ tree, fields, records: rows }); return { matches, incomplete }; };
const NOW = Date.parse('2026-10-04T12:00:00Z');
const rule = (field, operator, value) => ({ kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field, operator, params: { value } }] });
const files = new Map([
  ['/Media/a.png', { identity: `1f:${'a'.repeat(64)}`, media_type: 'image/png', names: ['/Media/a.png'] }],
  [`1f:${'b'.repeat(64)}`, { identity: `1f:${'b'.repeat(64)}`, media_type: 'video/mp4', names: ['/Media/b.mp4'] }],
  ['/Media/c.png', { identity: `1f:${'c'.repeat(64)}`, media_type: 'image/png', names: ['/Media/c.png'] }],
]);
const fields = [
  { id: 'name', label: 'Name', kind: 'text' },
  { id: 'picture', label: 'Picture', kind: 'file' },
  { id: 'shown', label: 'Shown when', kind: 'shown-when' },
];
const rows = [
  { id: 'r1', title: 'Always', values: { name: 'Always', picture: '/Media/a.png' } },
  { id: 'r2', title: 'Started', values: { name: 'Started', picture: `1f:${'b'.repeat(64)}`, shown: rule('now', 'after', NOW - 1000) } },
  { id: 'r3', title: 'Not yet', values: { name: 'Not yet', picture: '/Media/c.png', shown: rule('now', 'after', NOW + 60_000) } },
  { id: 'r4', title: 'After three opens', values: { name: 'After three opens', shown: rule('opened', 'greater_than', 2) } },
  { id: 'r5', title: 'Broken rule', values: { name: 'Broken rule', shown: rule('nowhere', 'equals', 1) } },
];
const copyAt = opened => listCopy({ fields, rows, facts: { now: NOW, opened }, filterRows, fileOf: name => files.get(name) ?? null });

test('list-wide sharing rule hides unapproved rows and their media even when row rules are missing or permissive', async () => {
  const stateFields = [...fields, { id: 'state', label: 'State', kind: 'choice', choices: ['Draft', 'Published'] }];
  const asked = [];
  const sharedRows = [
    { id: 'private', title: 'Private', values: { name: 'Private', state: 'Draft', picture: '/Media/c.png' } },
    { id: 'missing', title: 'Missing state', values: { name: 'Missing', picture: '/Media/c.png', shown: rule('now', 'after', NOW - 1) } },
    { id: 'public', title: 'Published', values: { name: 'Public', state: 'Published', picture: '/Media/a.png' } },
  ];
  const copy = await listCopy({ fields: stateFields, rows: sharedRows, facts: { now: NOW }, filterRows,
    share_when: { kind: 'group', combinator: 'and', negate: false, rules: [
      { kind: 'rule', field: 'state', operator: 'is_any_of', params: { values: ['Published'] } },
    ] }, fileOf: name => { asked.push(name); return files.get(name); } });
  assert.deepEqual(copy.rows.map(row => row.id), ['public']);
  assert.deepEqual(asked, ['/Media/a.png']);
  assert.deepEqual(copy.files.map(file => file.identity), [`1f:${'a'.repeat(64)}`]);
  const incomplete = await listCopy({ fields: stateFields, rows: sharedRows, facts: { now: NOW }, filterRows,
    share_when: rule('unknown', 'equals', 'Published'), fileOf: () => { throw new Error('Private files must not be read'); } });
  assert.deepEqual(incomplete.rows, []);
});

test('a list copy shows rows only while their own rule holds, and only the files those rows name', async () => {
  assert.equal((await copyAt(1)).names_clock, true, 'a rule that reads the clock is named, so a static copy is never left to go stale');
  const first = await copyAt(1);
  assert.deepEqual(first.rows.map(row => row.id), ['r1', 'r2']);
  assert.deepEqual(first.fields.map(field => field.id), ['name', 'picture'], 'the rule field never leaves');
  assert.equal(first.fields.find(field => field.id === 'picture').media, true);
  assert.equal(first.rows[0].values.picture, `1f:${'a'.repeat(64)}`, 'a file value leaves as its identity');
  assert.equal(first.rows.some(row => 'shown' in row.values), false);
  assert.deepEqual(first.files.map(file => file.identity).sort(), [`1f:${'a'.repeat(64)}`, `1f:${'b'.repeat(64)}`], 'a hidden row\'s file never leaves');
  assert.equal(first.names_opened, true, 'a rule that reads opens makes the link count them');
  const third = await copyAt(3);
  assert.deepEqual(third.rows.map(row => row.id), ['r1', 'r2', 'r4']);
});

const viewsOf = (extra = {}) => [
  { id: 'v-chart', label: 'Chart of the shown', display: { as: 'chart', settings: { mark: 'bar' } }, sort: [{ field: 'name', direction: 'desc' }] },
  { id: 'v-plain', label: 'Plain', search: 'Always' },
  { id: 'v-hidden-rule', label: 'By the rule field', display: { as: 'chart' }, rules: rule('shown', 'equals', 1) },
  { id: 'v-search', label: 'Only started', display: { as: 'timeline' }, search: 'Started' },
  ...(extra.views ?? []),
];

test('a list copy retains only approved preview identities from the file-sharing owner', async () => {
  const asked = [];
  const preview = `1f:${'d'.repeat(64)}`;
  const poster = `1f:${'e'.repeat(64)}`;
  const copy = await listCopy({ fields, rows, facts: { now: NOW, opened: 1 }, filterRows,
    fileOf: async name => {
      asked.push(name);
      const file = files.get(name);
      return file?.media_type === 'video/mp4'
        ? { ...file, preview_identity: preview, preview_media_type: 'video/mp4',
          poster_identity: poster, poster_media_type: 'image/png', private_detail: 'must stay out' }
        : file;
    } });
  assert.deepEqual(asked, ['/Media/a.png', `1f:${'b'.repeat(64)}`], 'hidden-row files are never asked for');
  assert.deepEqual(copy.files[1], { identity: `1f:${'b'.repeat(64)}`, media_type: 'video/mp4', name: '/Media/b.mp4',
    preview_identity: preview, preview_media_type: 'video/mp4', poster_identity: poster, poster_media_type: 'image/png' });
  assert.doesNotMatch(JSON.stringify(copy), /private_detail|must stay out/);
});

test('a saved view that says how it is drawn leaves only through a view projection; with none, no view leaves', async () => {
  const copy = await listCopy({ fields, rows, views: viewsOf(), facts: { now: NOW, opened: 1 }, filterRows, fileOf: name => files.get(name) ?? null });
  assert.deepEqual(copy.shown_views, [], 'never shown unfiltered');
  const seen = [];
  const projected = await listCopy({ fields, rows, views: viewsOf(), facts: { now: NOW, opened: 1 }, filterRows, fileOf: name => files.get(name) ?? null,
    projectView: async ({ view, fields: shown, rows: kept }) => {
      seen.push({ view: view.id, fields: shown.map(field => field.id), rows: kept.map(row => row.id) });
      if (view.rules) throw new Error('a rule over a field that does not leave');
      return { rows: [...kept].reverse(), rules: 'never leaves' };
    } });
  assert.deepEqual(projected.shown_views.map(view => view.id), ['v-chart', 'v-search'], 'a view with no display is absent, and a view whose rules cannot be checked is left out');
  assert.deepEqual(projected.shown_views[0], { id: 'v-chart', label: 'Chart of the shown', display: { as: 'chart', settings: { mark: 'bar' } }, row_ids: ['r2', 'r1'] });
  for (const view of projected.shown_views) assert.deepEqual(Object.keys(view).sort(), ['display', 'id', 'label', 'row_ids'], 'no rule, search or sort leaves');
  assert.ok(seen.every(call => call.rows.every(id => ['r1', 'r2'].includes(id)) && !call.fields.includes('shown')), 'a view only ever sees the rows and fields that leave');
});

test('a list copy with no saved views, or none drawn another way, carries an empty list of shown views', async () => {
  assert.deepEqual((await copyAt(1)).shown_views, []);
  const plain = await listCopy({ fields, rows, views: [{ id: 'p', label: 'Plain' }], facts: { now: NOW, opened: 1 }, filterRows, fileOf: () => null });
  assert.deepEqual(plain.shown_views, []);
});
