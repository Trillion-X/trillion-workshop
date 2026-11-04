// The hold reads only unsettled asks after a bounded, resumable migration of earlier rows. Completed history
// must neither increase those reads nor hide an old open ask behind a newer legacy read page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { identityOf } from '../src/decision-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { decomposedRecords, RECORD_INDEXES } from '../src/record-engine.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import settings from '../src/waiting-on-you.json' with { type: 'json' };
import listSettings from '../src/lists.json' with { type: 'json' };

const definition = { id: 'waiting-on-you', label: 'Waiting', row_type: 'waiting-on-you', title_field: 'what', fields: [
  { id: 'what', kind: 'text' }, { id: 'status', kind: 'choice', choices: ['Waiting', 'Done'], settles: ['Done'], starts: 'Waiting', open_index: 'open-status' },
] };
const indexes = RECORD_INDEXES.filter(index => index.type === 'record:waiting-on-you');
const openLog = ({ sql, transaction }) => recordLogStore(sql, { transaction, indexes });
const ready = eeaf => {
  let steps = 0;
  while (!eeaf.indexReady('record:waiting-on-you', 'open-status')) {
    eeaf.maintain({ max_pages: 256 });
    assert.ok(++steps < 200, 'the existing idle maintainer must finish the declared index');
  }
};
const fill = async (lists, eeaf) => {
  let steps = 0;
  while (!await lists.fillOpen(definition.id)) assert.ok(++steps < 100, 'a bounded migration must progress');
  if (eeaf.maintain) ready(eeaf);
};

for (const [name, open] of [['record log', openLog], ['earlier decomposed store', host => decomposedRecords(host.sql, { transaction: host.transaction, hash: identityOf })]]) {
  test(`${name}: open ask reads stay flat at four times the completed history, and retain an older open ask`, async t => {
    const measures = [];
    for (const completed of [600, 2400]) {
      const host = sqliteHost(':memory:'); t.after(() => host.db.close());
      let eeaf = open(host), lists = makeLists({ eeaf });
      await lists.save(definition);
      eeaf.write([
        ...Array.from({ length: completed }, (_, n) => ({ id: `record:waiting-on-you:z-${String(n).padStart(5, '0')}`, type: 'record:waiting-on-you', value: { what: `Completed ${n}`, status: 'Done' } })),
        ...Array.from({ length: 20 }, (_, n) => ({ id: `record:waiting-on-you:a-${String(n).padStart(5, '0')}`, type: 'record:waiting-on-you', value: { what: `Still waiting ${n}` } })),
      ]);
      await fill(lists, eeaf);
      eeaf = open(host);
      const bodyReads = [], scans = [];
      lists = makeLists({ eeaf: { ...eeaf,
        ids(type, options) {
          // Reading a definition also reads its separately stored views and filters; those bounded metadata lookups are not row history.
          const metadata=new Map([[listSettings.view_records.type,listSettings.limits.views_per_list],[listSettings.filters.type,listSettings.limits.filters_per_list]]);
          assert.ok(metadata.has(type),'a ready open read must not enumerate completed list history');
          assert.deepEqual(options,{prefix:`${type}:${definition.id}:`,limit:metadata.get(type)+1});
          return eeaf.ids(type,options);
        },
        read(id) { if (id.startsWith('record:waiting-on-you:')) bodyReads.push(id); return eeaf.read(id); },
        readMany(ids) {
          bodyReads.push(...ids.filter(id => id.startsWith('record:waiting-on-you:')));
          return eeaf.readMany(ids);
        },
        scan(type, name, options) { scans.push({ type, name, options }); return eeaf.scan(type, name, options); },
      } });
      const answer = await lists.read(definition.id, { open: true, keep: row => row.status !== 'Done' });
      assert.deepEqual(answer.rows.map(row => row.title), Array.from({ length: 20 }, (_, n) => `Still waiting ${n}`));
      assert.equal(bodyReads.length, 20);
      assert.deepEqual([...bodyReads].sort(), Array.from({ length: 20 }, (_, n) => `record:waiting-on-you:a-${String(n).padStart(5, '0')}`));
      assert.deepEqual(scans, [{ type: 'record:waiting-on-you', name: 'open-status', options: { reverse: true, limit: 2000 } }]);
      measures.push(bodyReads.length);
    }
    assert.deepEqual(measures, [20, 20]);
  });
}

test('migration reads at most one page, resumes after restart, and never runs from a hold read', async t => {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  let eeaf = openLog(host), lists = makeLists({ eeaf });
  await lists.save(definition);
  eeaf.write(Array.from({ length: 250 }, (_, n) => ({ id: `record:waiting-on-you:row-${String(n).padStart(4, '0')}`, type: 'record:waiting-on-you', value: { what: `Ask ${n}` } })));
  let visited = [];
  const before = makeLists({ eeaf: { ...eeaf,
    ids(type, options) { const ids = eeaf.ids(type, options); visited.push(ids); return ids; },
    write() { throw new Error('reading the hold may not migrate history'); },
  } });
  assert.equal(await before.openFillAt(definition.id, 123), 123);
  assert.equal((await before.read(definition.id, { open: true })).rows.length, 250, 'legacy page remains available until migration finishes');
  visited = [];
  const migrating = makeLists({ eeaf: { ...eeaf,
    ids(type, options) { assert.equal(options.limit, 100); const ids = eeaf.ids(type, options); visited.push(ids); return ids; },
  } });
  assert.equal(await migrating.fillOpen(definition.id), false);
  assert.equal(visited[0].length, 100);
  const first = new Set(visited[0]);
  eeaf = openLog(host); lists = makeLists({ eeaf });
  assert.equal(await lists.fillOpen(definition.id), false);
  assert.equal(await lists.fillOpen(definition.id), true);
  assert.equal(await lists.openFillAt(definition.id), null);
  ready(eeaf);
  assert.equal((await lists.read(definition.id, { open: true })).rows.length, 250);
  assert.equal(eeaf.read('record:waiting-on-you:row-0000').status, 'Waiting');
  assert.equal(eeaf.read([...first][0]).status, 'Waiting');
});

test('new and explicitly reopened asks enter the index immediately; settled Done stays done', async t => {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  const eeaf = openLog(host), lists = makeLists({ eeaf });
  await lists.save(definition); await fill(lists, eeaf);
  await lists.putRows(definition.id, { rows: [{ id: 'one', values: { what: 'Connect' } }] });
  assert.equal((await lists.row(definition.id, 'one')).values.status, 'Waiting');
  await lists.putRows(definition.id, { rows: [{ id: 'one', values: { status: 'Done' } }] });
  assert.equal((await lists.read(definition.id, { open: true })).rows.length, 0);
  const retried = await lists.putRows(definition.id, { rows: [{ id: 'one', values: { status: 'Waiting' } }] });
  assert.equal(retried.settled[0].kept, 'Done');
  assert.equal((await lists.read(definition.id, { open: true })).rows.length, 0);
  await lists.putRows(definition.id, { rows: [{ id: 'one', values: { status: null } }] });
  assert.deepEqual((await lists.read(definition.id, { open: true })).rows.map(row => row.id), ['one']);
  await lists.putRows(definition.id, { remove: ['one'] });
  assert.equal((await lists.read(definition.id, { open: true })).rows.length, 0);
});

test('the customer waiting list declares its generic starting state and open index', () => {
  const field = settings.list.fields.find(field => field.id === 'status');
  assert.equal(field.starts, 'Waiting');
  assert.equal(field.open_index, 'open-status');
});


test('a capped open read keeps the newest row IDs just as an ordinary list read does', async t => {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  const eeaf = openLog(host), lists = makeLists({ eeaf });
  await lists.save(definition);
  eeaf.write(Array.from({ length: 2100 }, (_, n) => ({ id: `record:waiting-on-you:row-${String(n).padStart(4, '0')}`, type: 'record:waiting-on-you', value: { what: `Ask ${n}`, status: 'Waiting' } })));
  await fill(lists, eeaf);
  assert.deepEqual((await lists.read(definition.id, { open: true })).rows.map(row => row.id), (await lists.read(definition.id)).rows.map(row => row.id));
});
