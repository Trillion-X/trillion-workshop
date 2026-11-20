// A person's release rules saved as their setting, read back with what is kept, what waits and when it leaves, and run to give
// storage back, over a stand-in of the engine's files door (set_aside, list_set_aside, forget_set_aside, files_summary,
// queue_release, release_gone_bytes, list_released) and of their record door. It ports what the old person store's glue did
// (src/person-store.mjs at 1e886c3f68: releaseRules :4636, namespaceSetReleaseRules :4638, releasePlanNow :4646, releaseByRules :4656,
// namespaceStorage :4674) and its tests' outcomes end to end (test/namespace-release-rules.test.mjs, test/namespace-command-refusals.test.mjs):
// a rule by kind/size/days, a storage rule, keep-for as the longest wait, a dry run, rules given for one run only, one item by its id,
// refusals before anything is read or changed, and the storage given back in the same run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteFiles, archiveFiles, listRecentlyDeleted, sweepRecentlyDeleted } from '../../recently-deleted-and-storage/do-work/recently-deleted-actions.mjs';
import { planStorageRelease, readStorage, releaseDeletedFiles } from '../do-work/release-by-rules.mjs';
import { readReleaseRules, setReleaseRules } from '../do-work/release-rules-setting.mjs';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T09:00:00Z');
const GB = 1e9;
const id = digit => `1f:${String(digit).repeat(64)}`;
const rule = (field, operator, params) => ({ kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field, operator, params }] });

// The engine's live names and set-aside names by full name { identity, byte_length, named_at }, the release rows, and the person's records.
function stand({ live = {}, keep } = {}) {
  const aside = {};
  const records = new Map(keep ? [['setting:keep_for', { type: 'setting', value: { value: keep }, identity: 'k0' }]] : []);
  const noted = new Set();
  const waiting = [];
  const released = [];
  const calls = [];
  let serial = 0, at = T0;
  const under = (tree, name) => Object.keys(tree).filter(each => each === name || each.startsWith(`${name}/`));
  const folderOf = name => name.slice(0, name.lastIndexOf('/')) || '/';
  const files = async (operation, input) => {
    calls.push(operation);
    if (operation === 'set_aside') {
      const names = under(live, input.name);
      if (!names.length) throw new Error('not found');
      for (const name of names) { aside[name] = { ...live[name], named_at: new Date(at).toISOString() }; delete live[name]; }
      return { names: names.length, folders: names.length > 1 || names[0] !== input.name ? 1 : 0, next_after: null };
    }
    if (operation === 'forget_set_aside') {
      const names = under(aside, input.name);
      if (!names.length) throw new Error('not found');
      for (const name of names) { noted.add(aside[name].identity); delete aside[name]; }
      return { names: names.length, folders: 0, noted: names.length, next_after: null };
    }
    if (operation === 'list_set_aside') {
      const here = Object.keys(aside).filter(name => folderOf(name) === input.folder).sort().map(name => ({ name, ...aside[name] }));
      const folders = [...new Set(Object.keys(aside).map(folderOf).filter(folder => folder !== '/' && folderOf(folder) === input.folder))].sort();
      return { names: here, folders: input.after ? [] : folders, next_after: null };
    }
    if (operation === 'files_summary') {
      const all = [...Object.values(live), ...Object.values(aside), ...waiting.map(row => ({ byte_length: row.byte_length }))];
      return { files: all.length, bytes: all.reduce((sum, row) => sum + row.byte_length, 0), by_origin: { stand: { files: all.length, bytes: all.reduce((sum, row) => sum + row.byte_length, 0) } } };
    }
    if (operation === 'queue_release') {
      for (const identity of [...noted]) {
        const holders = [...Object.values(live), ...Object.values(aside)].some(row => row.identity === identity);
        if (!holders) waiting.push({ identity, byte_length: everyBytes.get(identity) ?? 0 });
        noted.delete(identity);
      }
      return { more: false };
    }
    if (operation === 'release_gone_bytes') {
      const bytes = waiting.reduce((sum, row) => sum + row.byte_length, 0);
      const count = waiting.length;
      released.push(...waiting.splice(0).map(row => ({ ...row, released_at: at })));
      return { released: count, bytes, more: false };
    }
    if (operation === 'list_released') return { released: released.map(row => ({ ...row })), next_after: null, pending: waiting.length > 0 };
    throw new Error(`no operation ${operation}`);
  };
  const everyBytes = new Map(Object.values(live).map(row => [row.identity, row.byte_length]));
  const door = {
    files,
    async readRecord(type, recordId) { const record = records.get(recordId); return record && record.type === type ? structuredClone(record) : null; },
    async write(batch) {
      for (const row of batch) {
        const held = records.get(row.id);
        if (row.expected ? held?.identity !== row.expected.identity : held) throw new Error('record_conflict');
        records.set(row.id, { type: row.type, value: structuredClone(row.value), identity: `i${serial += 1}` });
      }
    },
    async *list({ type }) { for (const [rowId, record] of [...records].sort()) if (record.type === type) yield { id: rowId, ...structuredClone(record) }; },
  };
  return { door, live, aside, records, calls, released, clock: to => { at = to; }, now: () => at };
}
const clip = (digit, size) => ({ identity: id(digit), byte_length: size });

// A camera folder's clips, a big export and a note, deleted on different days (the old test's Recently Deleted).
async function withDeleted() {
  const s = stand({ live: { '/Camera/a.mov': clip(1, 4 * GB), '/Camera/b.mov': clip(2, 6 * GB), '/Exports/year.zip': clip(3, 50 * GB), '/Notes/plan.md': clip(4, 1000), '/Keep/stays.md': clip(5, 7) } });
  s.clock(T0);
  await deleteFiles({ items: [{ name: '/Camera' }], by: 'me' }, { door: s.door, now: s.now });
  s.clock(T0 + 3 * DAY);
  await deleteFiles({ items: [{ name: '/Exports/year.zip' }], by: 'me' }, { door: s.door, now: s.now });
  s.clock(T0 + 10 * DAY);
  await deleteFiles({ items: [{ name: '/Notes/plan.md' }], by: 'agent' }, { door: s.door, now: s.now });
  return s;
}

test('release rules are saved as the person\'s own setting, checked, and read back; a refused list writes nothing', async () => {
  const s = stand();
  const rows = [{ id: 'old-big', label: 'Big and old', when: rule('size', 'greater_than', { value: 1e9 }), after_days: 7 }];
  const answer = await setReleaseRules({ rules: rows }, { door: s.door });
  assert.deepEqual(answer.rules.map(row => [row.id, row.on, row.after_days, row.storage_above_bytes, row.order]), [['old-big', true, 7, null, 'oldest']]);
  assert.ok(answer.item_facts.some(fact => fact.id === 'days_deleted') && answer.orders.some(order => order.id === 'largest') && answer.choices.after_days.includes(7));
  assert.deepEqual((await readReleaseRules(s.door)).rules, answer.rules);
  for (const bad of [[{ id: 'a', when: null }], [{ when: null, after_days: 1.5 }], [{ id: 'x', when: null, after_days: 1 }, { id: 'x', when: null, after_days: 2 }], [{ when: null, after_days: 1, order: 'sideways' }], 'nope']) {
    await assert.rejects(setReleaseRules({ rules: bad }, { door: s.door }), error => error.refusal === true);
  }
  assert.deepEqual((await readReleaseRules(s.door)).rules, answer.rules);
  assert.deepEqual((await setReleaseRules({}, { door: s.door })).rules, answer.rules, 'rules left out change nothing');
});

test('read storage says what is kept, what waits, when each item leaves and by which rule or keep-for, and what was given back', async () => {
  const s = await withDeleted();
  await setReleaseRules({ rules: [{ id: 'exports', label: 'Exports', when: rule('size', 'greater_than', { value: 10 * GB }), after_days: 5 }] }, { door: s.door });
  s.clock(T0 + 11 * DAY);
  const storage = await readStorage({}, { door: s.door, now: s.now });
  assert.equal(storage.kept.bytes, 4 * GB + 6 * GB + 50 * GB + 1000 + 7);
  assert.deepEqual(storage.waiting, { bytes: 10 * GB + 50 * GB + 1000, items: 3 });
  const by = Object.fromEntries(storage.items.map(item => [item.label, item]));
  assert.equal(by['year.zip'].because, 'exports');
  assert.equal(by['year.zip'].leaves_at, new Date(T0 + 8 * DAY).toISOString());
  assert.equal(by['Camera'].because, 'keep-for');
  assert.equal(by['Camera'].leaves_at, new Date(T0 + 30 * DAY).toISOString());
  assert.equal(by['plan.md'].because, 'keep-for');
  assert.equal(by['Camera'].byte_length, 10 * GB, 'a folder is the sum of its names');
  assert.equal(by['year.zip'].facts.kind.length > 0, true);
  assert.deepEqual(storage.given_back, { bytes: 0, objects: 0, pending: false, partial: false });
  assert.equal(storage.rules.length, 1);
  assert.ok(storage.item_facts.length && storage.orders.length && storage.choices.storage_above_bytes.length);
  assert.equal(storage.leaving.length, 30);
});

test('release now forgets for good only what the rules say leaves now, gives its bytes back in the same run and reads it back as given back', async () => {
  const s = await withDeleted();
  await setReleaseRules({ rules: [{ id: 'exports', when: rule('size', 'greater_than', { value: 10 * GB }), after_days: 5 }, { id: 'camera', when: rule('where', 'is_any_of', { values: ['/'] }), after_days: 30 }] }, { door: s.door });
  s.clock(T0 + 11 * DAY);
  const sample = await releaseDeletedFiles({ dry_run: true }, { door: s.door, now: s.now });
  assert.deepEqual(sample.leaving.map(row => [row.label, row.because]), [['year.zip', 'exports']]);
  assert.equal(sample.bytes, 50 * GB);
  assert.equal(sample.dry_run, true);
  assert.ok(Object.hasOwn(s.aside, '/Exports/year.zip'), 'a dry run changes nothing');
  assert.ok(!s.calls.includes('forget_set_aside'));
  const done = await releaseDeletedFiles({}, { door: s.door, now: s.now });
  assert.deepEqual(done.leaving.map(row => row.label), ['year.zip']);
  assert.deepEqual(done.forgotten.map(row => row.label), ['year.zip']);
  assert.deepEqual(done.released, { objects: 1, bytes: 50 * GB, more: false });
  assert.deepEqual(Object.keys(s.aside).sort(), ['/Camera/a.mov', '/Camera/b.mov', '/Notes/plan.md']);
  const after = await readStorage({}, { door: s.door, now: s.now });
  assert.equal(after.kept.bytes, 10 * GB + 1000 + 7);
  assert.equal(after.given_back.bytes, 50 * GB);
  assert.deepEqual(after.given_back_by_day.map(row => [row.day, row.bytes, row.objects]), [['2026-11-12', 50 * GB, 1]]);
  assert.equal((await listRecentlyDeleted({}, { door: s.door, now: s.now })).items.length, 2);
  const again = await releaseDeletedFiles({}, { door: s.door, now: s.now });
  assert.deepEqual([again.leaving, again.bytes], [[], 0]);
});

test('rules given for one run decide that run and are not saved; a storage rule gives back in its order only while storage stays above its size', async () => {
  const s = await withDeleted();
  s.clock(T0 + 11 * DAY);
  assert.deepEqual((await releaseDeletedFiles({ dry_run: true }, { door: s.door, now: s.now })).leaving, []);
  const rules = [{ id: 'room', when: null, storage_above_bytes: 58 * GB, order: 'largest' }];
  const run = await releaseDeletedFiles({ rules, dry_run: true }, { door: s.door, now: s.now });
  assert.deepEqual(run.leaving.map(row => row.label), ['year.zip']);
  assert.equal(run.leaving[0].because, 'room');
  assert.deepEqual((await readReleaseRules(s.door)).rules, [], 'the rules of one run are not kept');
  const oldest = await releaseDeletedFiles({ rules: [{ id: 'room', when: null, storage_above_bytes: 100, order: 'oldest' }], dry_run: true }, { door: s.door, now: s.now });
  assert.deepEqual(oldest.leaving.map(row => row.label).sort(), ['Camera', 'plan.md', 'year.zip']);
});

test('keep-for stays the longest anything waits: a shorter keep-for leaves first, and one item leaves by its id like any other rule', async () => {
  const s = await withDeleted();
  s.clock(T0 + 11 * DAY);
  await releaseDeletedFiles({ rules: [{ id: 'long', when: null, after_days: 365 }], dry_run: true }, { door: s.door, now: s.now });
  const planned = await planStorageRelease({ items: (await listRecentlyDeleted({}, { door: s.door, now: s.now })).items.map(item => ({ ...item, byte_length: 1 })), kept_bytes: 3, rules: [{ id: 'long', when: null, after_days: 365 }], now: new Date(s.now()).toISOString() }, { door: s.door });
  assert.ok(planned.items.every(item => Date.parse(item.leaves_at) <= T0 + 11 * DAY + 30 * DAY), 'a longer rule never keeps past keep-for');
  const listed = (await listRecentlyDeleted({}, { door: s.door, now: s.now })).items.find(item => item.label === 'Camera');
  const gone = await releaseDeletedFiles({ rules: [{ id: 'one', when: rule('id', 'is_any_of', { values: [listed.id] }), after_days: 0 }] }, { door: s.door, now: s.now });
  assert.deepEqual(gone.leaving.map(row => [row.id, row.because]), [[listed.id, 'one']]);
  assert.deepEqual(Object.keys(s.aside).sort(), ['/Exports/year.zip', '/Notes/plan.md']);
});

test('a rule that names no comparison, or an unfinished one, refuses the whole run and forgets nothing', async () => {
  const s = await withDeleted();
  s.clock(T0 + 11 * DAY);
  const before = Object.keys(s.aside).sort();
  await assert.rejects(releaseDeletedFiles({ rules: [{ id: 'empty', when: { kind: 'group', combinator: 'and', negate: false, rules: [] }, after_days: 0 }] }, { door: s.door, now: s.now }), /no comparison/);
  await assert.rejects(releaseDeletedFiles({ rules: [{ id: 'half', when: rule('size', 'greater_than', {}), after_days: 0 }] }, { door: s.door, now: s.now }), /unfinished condition|no comparison/);
  await assert.rejects(releaseDeletedFiles({ rules: 'all' }, { door: s.door, now: s.now }), error => error.refusal === true);
  assert.deepEqual(Object.keys(s.aside).sort(), before);
  assert.ok(!s.calls.includes('forget_set_aside') && !s.calls.includes('queue_release'));
});

test('Archived leaves only by a rule; an archived item a rule covers is given back, and the sweep never does it', async () => {
  const s = stand({ live: { '/Old/film.mov': clip(6, 20 * GB) } });
  await archiveFiles({ items: [{ name: '/Old/film.mov' }] }, { door: s.door, now: s.now });
  s.clock(T0 + 400 * DAY);
  assert.deepEqual((await sweepRecentlyDeleted({}, { door: s.door, now: s.now })).removed, [], 'Archived moves on to Recently Deleted first, never gone in the same sweep');
  const archived = stand({ live: { '/Old/film.mov': clip(6, 20 * GB) } });
  await archiveFiles({ items: [{ name: '/Old/film.mov' }] }, { door: archived.door, now: archived.now });
  archived.clock(T0 + 2 * DAY);
  const none = await releaseDeletedFiles({ dry_run: true }, { door: archived.door, now: archived.now });
  assert.deepEqual(none.leaving, []);
  const ruled = await releaseDeletedFiles({ rules: [{ id: 'films', when: rule('state', 'is_any_of', { values: ['Archived'] }), after_days: 1 }] }, { door: archived.door, now: archived.now });
  assert.deepEqual(ruled.leaving.map(row => [row.label, row.because]), [['film.mov', 'films']]);
  assert.deepEqual(archived.aside, {});
});

test('the plan runs on items a caller already read: no file door is reached, and bad input is refused with words', async () => {
  const items = [{ id: 'a', label: 'a.mov', state: 'deleted', byte_length: 5 * GB, set_aside_at: new Date(T0).toISOString(), by: 'me', where: '/Camera', name_count: 1, folder: false, names: ['/Camera/a.mov'], due_at: new Date(T0 + 30 * DAY).toISOString() }];
  const door = { async readRecord() { return null; } };
  const plan = await planStorageRelease({ items, kept_bytes: 9 * GB, rules: [{ id: 'now', when: rule('size', 'greater_than', { value: GB }), after_days: 0 }], now: new Date(T0 + DAY).toISOString() }, { door });
  assert.deepEqual(plan.now, ['a']);
  assert.equal(plan.kept_after, 4 * GB);
  assert.equal(plan.item_rows[0].facts.days_deleted, 1);
  await assert.rejects(planStorageRelease({ items: 'x', kept_bytes: 1 }, { door }), /Give the items/);
  await assert.rejects(planStorageRelease({ items, kept_bytes: -1 }, { door }), /kept_bytes/);
  await assert.rejects(planStorageRelease({ items: [{ id: 'z' }], kept_bytes: 1 }, { door }), /Each item needs/);
});
