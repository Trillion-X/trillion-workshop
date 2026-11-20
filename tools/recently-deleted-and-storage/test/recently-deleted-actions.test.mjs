// The AI tools of Recently Deleted and Archived over the engine's set-aside operations and the person's records
// (do-work/recently-deleted-actions.mjs). The outcomes are the ones the carried store's tests proved
// (test/set-aside-store.test.mjs, the old repository's test/namespace-set-aside.test.mjs): delete or archive by name, folder or
// identity, list newest first with the days left, put back every name (never taking one another file got), change the
// days at once, move Archived on to Recently Deleted and give Recently Deleted up for good, null days keep until put back.
// The door is a stand-in for the engine's files door and record door, with the engine's rules for the set-aside tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveFiles, deleteFiles, listRecentlyDeleted, putBackFiles, setKeepFor, sweepRecentlyDeleted } from '../do-work/recently-deleted-actions.mjs';

const DAY = 86400000;
const T0 = Date.parse('2026-11-01T09:00:00Z');
const A = `1f:${'a'.repeat(64)}`;

// The engine's tree of live names and set-aside names, by full name: { identity, named_at, bytes }.
function stand({ live = {}, aside = {}, keep } = {}) {
  const records = new Map(keep ? [['setting:keep_for', { type: 'setting', value: { value: keep, label: 'keep' }, identity: 'k0' }]] : []);
  const calls = [];
  let serial = 0;
  const under = (tree, name) => Object.keys(tree).filter(each => each === name || each.startsWith(`${name}/`));
  const folderOf = name => name.slice(0, name.lastIndexOf('/')) || '/';
  const files = async (operation, input) => {
    calls.push([operation, input]);
    if (operation === 'set_aside' || operation === 'put_back') {
      const [from, to] = operation === 'set_aside' ? [live, aside] : [aside, live];
      const names = under(from, input.name);
      if (!names.length) throw new Error('not found');
      if (Object.hasOwn(input, 'expected_version') && input.expected_version !== (live[input.name]?.version ?? 0)) throw new Error('namespace_conflict');
      for (const name of names) if (to[name] && to[name].identity !== from[name].identity) throw new Error('a name at the destination already names another file');
      for (const name of names) { to[name] = { ...from[name], ...(operation === 'set_aside' ? { named_at: new Date(T0).toISOString() } : {}) }; delete from[name]; }
      return { from: input.name, to: input.name, names: names.length, folders: names.length > 1 || names[0] !== input.name ? 1 : 0, next_after: null };
    }
    if (operation === 'forget_set_aside') {
      const names = under(aside, input.name);
      if (!names.length) throw new Error('not found');
      for (const name of names) delete aside[name];
      return { name: input.name, names: names.length, folders: 0, noted: names.length, next_after: null };
    }
    if (operation === 'find_file') {
      const names = Object.keys(live).filter(name => live[name].identity === input.name_or_identity).sort();
      if (!names.length) throw new Error('not found');
      return { identity: input.name_or_identity, names };
    }
    if (operation === 'list_set_aside') {
      const here = Object.keys(aside).filter(name => folderOf(name) === input.folder).sort().map(name => ({ name, ...aside[name] }));
      const folders = [...new Set(Object.keys(aside).map(folderOf).filter(folder => folder !== '/' && folderOf(folder) === input.folder))].sort();
      return { collection: input.folder, names: here, folders: input.after ? [] : folders, next_after: null };
    }
    throw new Error(`no operation ${operation}`);
  };
  const door = {
    files,
    async readRecord(type, id) { const record = records.get(id); return record && record.type === type ? structuredClone(record) : null; },
    async write(batch) {
      for (const row of batch) {
        const held = records.get(row.id);
        if (row.expected ? held?.identity !== row.expected.identity : held) throw new Error('record_conflict');
        records.set(row.id, { type: row.type, value: structuredClone(row.value), identity: `i${serial += 1}` });
      }
    },
    async *list({ type }) { for (const [id, record] of [...records].sort()) if (record.type === type) yield { id, ...structuredClone(record) }; },
  };
  return { door, live, aside, records, calls };
}
const file = (identity = A, extra = {}) => ({ identity, bytes: 10, ...extra });
const clock = at => ({ now: () => at });

test('delete by name takes the name out of view and keeps it in Recently Deleted with its days left', async () => {
  const { door, live, aside } = stand({ live: { '/Notes/old.md': file() } });
  const answer = await deleteFiles({ items: [{ name: '/Notes/old.md' }], by: 'me' }, { door, ...clock(T0) });
  assert.deepEqual(answer.refused, []);
  assert.equal(answer.said, 'Moved to Recently Deleted');
  assert.deepEqual(Object.keys(live), []);
  assert.deepEqual(Object.keys(aside), ['/Notes/old.md']);
  const [item] = answer.set_aside;
  assert.equal([item.label, item.state, item.state_label, item.days_left, item.after_days, item.by, item.where].join('|'), 'old.md|deleted|Recently Deleted|30|30|me|/Notes');
  assert.equal(item.due_at, new Date(T0 + 30 * DAY).toISOString());
  const listed = await listRecentlyDeleted({}, { door, ...clock(T0 + 10 * DAY) });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].days_left, 20);
});

test('a recording deleted by its identity sets aside every name it has, labelled as asked', async () => {
  const { door, live, aside } = stand({ live: { '/Recordings/take.mov': file(), '/Copies/take-copy.mov': file(), '/Other/x.md': file(`1f:${'b'.repeat(64)}`) } });
  const { set_aside, refused } = await deleteFiles({ items: [{ identity: A, label: 'Monday call' }] }, { door, ...clock(T0) });
  assert.deepEqual(refused, []);
  assert.equal(set_aside[0].label, 'Monday call');
  assert.equal(set_aside[0].name_count, 2);
  assert.deepEqual(Object.keys(live), ['/Other/x.md']);
  assert.deepEqual(Object.keys(aside).sort(), ['/Copies/take-copy.mov', '/Recordings/take.mov']);
});

test('archive keeps a folder as one item and put back gives every name back', async () => {
  const { door, live, aside } = stand({ live: { '/Photos/a.jpg': file(), '/Photos/b.jpg': file(`1f:${'c'.repeat(64)}`), '/Keep.md': file(`1f:${'d'.repeat(64)}`) } });
  const { set_aside } = await archiveFiles({ items: [{ name: '/Photos' }] }, { door, ...clock(T0) });
  assert.equal(set_aside.length, 1);
  assert.equal([set_aside[0].state, set_aside[0].folder, set_aside[0].name_count].join('|'), 'archived|true|2');
  assert.deepEqual(Object.keys(live), ['/Keep.md']);
  const { results } = await putBackFiles({ ids: [set_aside[0].id] }, { door });
  assert.deepEqual(results, [{ id: set_aside[0].id, label: 'Photos', put_back: true }]);
  assert.deepEqual(Object.keys(live).sort(), ['/Keep.md', '/Photos/a.jpg', '/Photos/b.jpg']);
  assert.deepEqual(aside, {});
  assert.deepEqual((await listRecentlyDeleted({}, { door, ...clock(T0) })).items, []);
  assert.deepEqual((await putBackFiles({ ids: [set_aside[0].id] }, { door })).results[0].error, 'It is not in Recently Deleted or Archived.');
});

test('put back never takes a name another file got: it stays listed and says so, then goes back once the name is free', async () => {
  const { door, live } = stand({ live: { '/Notes/plan.md': file() } });
  const { set_aside } = await deleteFiles({ items: [{ name: '/Notes/plan.md' }] }, { door, ...clock(T0) });
  live['/Notes/plan.md'] = file(`1f:${'e'.repeat(64)}`);
  const refused = await putBackFiles({ ids: [set_aside[0].id] }, { door });
  assert.match(refused.results[0].error, /Another file now has the name \/Notes\/plan\.md/);
  assert.equal(live['/Notes/plan.md'].identity, `1f:${'e'.repeat(64)}`);
  assert.equal((await listRecentlyDeleted({}, { door, ...clock(T0) })).items.length, 1);
  delete live['/Notes/plan.md'];
  assert.equal((await putBackFiles({ ids: [set_aside[0].id] }, { door })).results[0].put_back, true);
  assert.equal(live['/Notes/plan.md'].identity, A);
});

test('a name the engine does not have, a bad name and a stale version are refused with words, and set nothing aside', async () => {
  const { door, live, calls } = stand({ live: { '/a.md': { ...file(), version: 3 } } });
  const { set_aside, refused } = await deleteFiles({ items: [{ name: '/missing.md' }, { name: 'no-slash' }, { identity: 'nonsense' }, { name: '/a.md', expected_version: 2 }] }, { door, ...clock(T0) });
  assert.deepEqual(set_aside, []);
  assert.equal(refused.length, 4);
  assert.match(refused[1].error, /starting with \//);
  assert.match(refused[3].error, /namespace_conflict/);
  assert.deepEqual(Object.keys(live), ['/a.md']);
  assert.deepEqual(calls.find(([operation, input]) => operation === 'set_aside' && input.name === '/a.md')[1], { name: '/a.md', expected_version: 2 });
  await assert.rejects(() => deleteFiles({ items: [] }, { door }), /1 to 500/);
});

test('list answers newest first, filters by state and pages', async () => {
  const { door } = stand({ live: { '/1.md': file(), '/2.md': file(`1f:${'b'.repeat(64)}`), '/3.md': file(`1f:${'c'.repeat(64)}`) } });
  await deleteFiles({ items: [{ name: '/1.md' }] }, { door, ...clock(T0) });
  await archiveFiles({ items: [{ name: '/2.md' }] }, { door, ...clock(T0 + DAY) });
  await deleteFiles({ items: [{ name: '/3.md' }] }, { door, ...clock(T0 + 2 * DAY) });
  const at = clock(T0 + 3 * DAY);
  assert.deepEqual((await listRecentlyDeleted({}, { door, ...at })).items.map(item => item.label), ['3.md', '2.md', '1.md']);
  assert.deepEqual((await listRecentlyDeleted({ state: 'archived' }, { door, ...at })).items.map(item => item.label), ['2.md']);
  const first = await listRecentlyDeleted({ limit: 2 }, { door, ...at });
  assert.deepEqual(first.items.map(item => item.label), ['3.md', '2.md']);
  assert.deepEqual((await listRecentlyDeleted({ limit: 2, after: first.next_after }, { door, ...at })).items.map(item => item.label), ['1.md']);
  assert.equal((await listRecentlyDeleted({ limit: 2, after: first.next_after }, { door, ...at })).next_after, null);
  await assert.rejects(() => listRecentlyDeleted({ state: 'nowhere' }, { door }), /declared archive state/);
});

test('keep-for applies at once, keeps the setting envelope, and null keeps until put back', async () => {
  const { door, records } = stand({ live: { '/a.md': file() }, keep: { archived: 7 } });
  await deleteFiles({ items: [{ name: '/a.md' }] }, { door, ...clock(T0) });
  const answer = await setKeepFor({ after_days: { deleted: 5 } }, { door });
  assert.deepEqual(answer.states.map(state => [state.id, state.after_days, state.default_after_days]), [['deleted', 5, 30], ['archived', 7, 30]]);
  assert.deepEqual(records.get('setting:keep_for').value, { value: { archived: 7, deleted: 5 }, label: 'keep' });
  assert.equal((await listRecentlyDeleted({}, { door, ...clock(T0 + DAY) })).items[0].days_left, 4);
  await setKeepFor({ after_days: { deleted: null } }, { door });
  const kept = (await listRecentlyDeleted({}, { door, ...clock(T0 + 400 * DAY) })).items[0];
  assert.deepEqual([kept.after_days, kept.days_left, kept.due_at], [null, null, null]);
  assert.deepEqual(await sweepRecentlyDeleted({ at: new Date(T0 + 400 * DAY).toISOString() }, { door }), { moved: [], removed: [] });
  assert.deepEqual((await setKeepFor({ after_days: {} }, { door })).states[0].after_days, null);
  for (const bad of [{ deleted: -1 }, { deleted: 1.5 }, { deleted: 36501 }, { nowhere: 3 }, 'x', null]) await assert.rejects(() => setKeepFor({ after_days: bad }, { door }));
});

test('keep-for with no setting yet writes one at version null', async () => {
  const { door, records } = stand();
  await setKeepFor({ after_days: { archived: 90 } }, { door });
  assert.deepEqual(records.get('setting:keep_for').value, { value: { archived: 90 } });
});

test('the sweep moves Archived on to Recently Deleted when its time ends and gives Recently Deleted up for good, never in the same sweep', async () => {
  const { door, live, aside, records } = stand({ live: { '/old.md': file(), '/arch.md': file(`1f:${'b'.repeat(64)}`), '/fresh.md': file(`1f:${'c'.repeat(64)}`) } });
  await deleteFiles({ items: [{ name: '/old.md' }] }, { door, ...clock(T0) });
  await archiveFiles({ items: [{ name: '/arch.md' }] }, { door, ...clock(T0) });
  await deleteFiles({ items: [{ name: '/fresh.md' }] }, { door, ...clock(T0 + 25 * DAY) });
  const at = new Date(T0 + 31 * DAY).toISOString();
  const swept = await sweepRecentlyDeleted({ at }, { door });
  assert.deepEqual(swept.removed.map(item => item.label), ['old.md']);
  assert.deepEqual(swept.moved.map(item => [item.label, item.to]), [['arch.md', 'deleted']]);
  assert.deepEqual(Object.keys(aside).sort(), ['/arch.md', '/fresh.md']);
  assert.deepEqual(Object.keys(live), []);
  const left = (await listRecentlyDeleted({}, { door, ...clock(T0 + 31 * DAY) })).items;
  assert.deepEqual(left.map(item => [item.label, item.state, item.by, item.days_left]), [['arch.md', 'deleted', 'schedule', 30], ['fresh.md', 'deleted', null, 24]]);
  assert.equal([...records.values()].find(record => record.value.label === 'old.md').value.status, 'forgotten');
  assert.deepEqual(await sweepRecentlyDeleted({ at }, { door }), { moved: [], removed: [] });
  const later = await sweepRecentlyDeleted({ at: new Date(T0 + 62 * DAY).toISOString() }, { door });
  assert.deepEqual(later.removed.map(item => item.label).sort(), ['arch.md', 'fresh.md']);
  assert.deepEqual(aside, {});
});

test('a name already gone from the tree does not stop the sweep', async () => {
  const { door, aside } = stand({ live: { '/a.md': file(), '/b.md': file(`1f:${'b'.repeat(64)}`) } });
  await deleteFiles({ items: [{ name: '/a.md' }, { name: '/b.md' }] }, { door, ...clock(T0) });
  delete aside['/a.md'];
  const swept = await sweepRecentlyDeleted({ at: new Date(T0 + 31 * DAY).toISOString() }, { door });
  assert.deepEqual(swept.removed.map(item => item.label).sort(), ['a.md', 'b.md']);
  assert.deepEqual(aside, {});
});

test('a name another door set aside (Finder, a carried delete_file) is adopted as Recently Deleted once, shows its days and is swept', async () => {
  const named = new Date(T0).toISOString();
  const { door, aside, records } = stand({ aside: { '/Trash/x.md': file(A, { named_at: named }), '/Trash/Deep/y.md': file(`1f:${'b'.repeat(64)}`, { named_at: named }) } });
  const first = await listRecentlyDeleted({}, { door, ...clock(T0 + 5 * DAY) });
  assert.deepEqual(first.items.map(item => [item.label, item.state, item.days_left, item.by]).sort(), [['x.md', 'deleted', 25, 'another door'], ['y.md', 'deleted', 25, 'another door']]);
  assert.equal(records.size, 2);
  assert.equal((await listRecentlyDeleted({}, { door, ...clock(T0 + 6 * DAY) })).items.length, 2);
  assert.equal(records.size, 2);
  const swept = await sweepRecentlyDeleted({ at: new Date(T0 + 31 * DAY).toISOString() }, { door });
  assert.equal(swept.removed.length, 2);
  assert.deepEqual(aside, {});
});

test('a name inside a folder this tool set aside is not adopted a second time', async () => {
  const { door, records } = stand({ live: { '/Photos/a.jpg': file(), '/Photos/Trips/b.jpg': file(`1f:${'b'.repeat(64)}`) } });
  await archiveFiles({ items: [{ name: '/Photos' }] }, { door, ...clock(T0) });
  const listed = await listRecentlyDeleted({}, { door, ...clock(T0) });
  assert.equal(listed.items.length, 1);
  assert.equal(records.size, 1);
});
