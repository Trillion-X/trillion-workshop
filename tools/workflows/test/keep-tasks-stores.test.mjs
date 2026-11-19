// Proof of workflow:keep-tasks-handed-between-anyone (tools/workflows/recipes): the keep writes of the task rows applied to
// a store, on PGlite and on a folder of JSON files, give the same answers. Made-up people, AIs and tasks only. The recipe's
// prove step runs these same attempts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { giveATask, takeATask, changeATask, finishATask, seeTasks, seeWhoCanTakeWork } from '../../plan-tasks-and-todo-lists/task-moves.mjs';

const T = minutes => ({ now: () => new Date(Date.parse('2026-11-19T08:00:00.000Z') + minutes * 60000) });
const iso = minutes => new Date(Date.parse('2026-11-19T08:00:00.000Z') + minutes * 60000).toISOString();
const LIVE = { seen_at: '2026-11-19T07:59:00.000Z', minutes: 60 };
const SEED = [
  { id: 'person:someone', type: 'person', value: { label: 'Someone' } },
  { id: 'ai:north', type: 'ai', value: { label: 'north', can: ['code'], order: 1, live: LIVE } },
  { id: 'ai:south', type: 'ai', value: { label: 'south', can: ['code'], order: 2, live: LIVE } },
  { id: 'ai:east', type: 'ai', value: { label: 'east', can: ['code'], order: 3, live: LIVE } },
  { id: 'plant-check:garden', type: 'plant-check', value: { watered: true } },
];
const same = (a, b) => makeHashCodeHexFromJson(a ?? null) === makeHashCodeHexFromJson(b ?? null);

// Store A: PGlite, one table, each apply in one transaction. Store B: a folder, one JSON file per record.
function pgStore(db) {
  return {
    name: 'PGlite',
    async setup() { await db.exec('CREATE TABLE IF NOT EXISTS records (id text PRIMARY KEY, type text NOT NULL, value jsonb, version int NOT NULL)'); },
    async all() { return (await db.query('SELECT id, type, value FROM records ORDER BY id')).rows.map(r => ({ id: r.id, type: r.type, value: r.value })); },
    async apply(keep) {
      await db.exec('BEGIN');
      try {
        for (const w of keep) {
          const cur = (await db.query('SELECT type, value, version FROM records WHERE id = $1', [w.id])).rows[0];
          if (w.expected === null ? cur : (!cur || cur.type !== w.expected.type || !same(cur.value, w.expected.value))) throw Object.assign(new Error('conflict'), { conflict: true });
          if (w.value === null) await db.query('DELETE FROM records WHERE id = $1', [w.id]);
          else if (cur) await db.query('UPDATE records SET value = $2, version = version + 1 WHERE id = $1', [w.id, JSON.stringify(w.value)]);
          else await db.query('INSERT INTO records (id, type, value, version) VALUES ($1, $2, $3, 1)', [w.id, w.type, JSON.stringify(w.value)]);
        }
        await db.exec('COMMIT');
        return 'applied';
      } catch (error) {
        await db.exec('ROLLBACK');
        if (error.conflict) return 'conflict';
        throw error;
      }
    },
  };
}
function folderStore(dir) {
  const file = id => join(dir, `${encodeURIComponent(id)}.json`);
  const read = id => { try { return JSON.parse(readFileSync(file(id), 'utf8')); } catch { return null; } };
  return {
    name: 'JSON folder',
    async setup() {},
    async all() {
      return readdirSync(dir).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8'))).sort((a, b) => (a.id < b.id ? -1 : 1));
    },
    async apply(keep) {
      for (const w of keep) {
        const cur = read(w.id);
        if (w.expected === null ? cur : (!cur || cur.type !== w.expected.type || !same(cur.value, w.expected.value))) return 'conflict';
      }
      for (const w of keep) {
        if (w.value === null) renameSync(file(w.id), join(dir, `.removed-${encodeURIComponent(w.id)}`));
        else { const tmp = join(dir, `.tmp-${encodeURIComponent(w.id)}`); writeFileSync(tmp, JSON.stringify({ id: w.id, type: w.type, value: w.value })); renameSync(tmp, file(w.id)); }
      }
      return 'applied';
    },
  };
}

const TARGET = { type: 'plant-check', id: 'plant-check:garden' };
const ACCEPTANCE = { outcome: 'The plants are watered', target: TARGET, rules: [{ id: 'outcome', path: 'watered', required: true }] };
const finishCheck = (task, minutes) => ({ outcome: task.outcome, target: TARGET, checked_at: iso(minutes), evidence: [{ ref: 'photo:plants', observation: 'The plants are wet at the soil line' }], obligations: [] });

async function attempts(store) {
  const got = {};
  await store.setup();
  got.seed = await store.apply(SEED.map(r => ({ id: r.id, type: r.type, value: r.value, expected: null })));
  // Give: one write; the same give again writes nothing; the same key with other words is already-there.
  let read = await store.all();
  const given = await giveATask({ input: { as: 'person:someone', title: 'Water the plants', outcome: 'The plants are watered', assignees: ['ai:north'], key: 't-one', records: read } }, T(1));
  got.give = [given.status, given.keep.length, await store.apply(given.keep)];
  read = await store.all();
  const again = await giveATask({ input: { as: 'person:someone', title: 'Water the plants', outcome: 'The plants are watered', assignees: ['ai:north'], key: 't-one', records: read } }, T(2));
  got.resend = [again.status, (again.keep ?? []).length];
  const other = await giveATask({ input: { as: 'person:someone', title: 'Something else', assignees: ['ai:north'], key: 't-one', records: read } }, T(2));
  got.other = other.status;
  // A person's task handed to an AI, and the AI hands it back to the person: a take, then hand-on to the person.
  const taken = await takeATask({ input: { as: 'ai:north', id: 'record:calendar-task:t-one', records: read } }, T(3));
  got.take = [taken.taken?.status ?? null, await store.apply(taken.keep)];
  read = await store.all();
  const handed = await changeATask({ input: { as: 'ai:north', id: 'record:calendar-task:t-one', action: 'hand-on', taken_at: taken.taken.taken_at, assignees: ['person:someone'], because: 'Needs your sign-off', records: read } }, T(4));
  got.handOn = [handed.moved, await store.apply(handed.keep)];
  read = await store.all();
  const personTook = await takeATask({ input: { as: 'person:someone', id: 'record:calendar-task:t-one', records: read } }, T(5));
  got.personTake = [personTook.taken?.status ?? null, await store.apply(personTook.keep)];
  read = await store.all();
  const planned = await changeATask({ input: { as: 'person:someone', id: 'record:calendar-task:t-one', action: 'plan', taken_at: personTook.taken.taken_at, acceptance: ACCEPTANCE, records: read } }, T(6));
  got.plan = [planned.moved, await store.apply(planned.keep)];
  read = await store.all();
  const done = await finishATask({ input: { as: 'person:someone', id: 'record:calendar-task:t-one', taken_at: personTook.taken.taken_at, result: 'Plants watered', summary: 'Checked the photo', check: finishCheck({ outcome: 'The plants are watered' }, 7), records: read } }, T(7));
  got.finish = [done.moved, done.to, await store.apply(done.keep)];
  // Race: two AIs read the same waiting task with no assignee; the first write applies, the second is refused whole.
  read = await store.all();
  const sent = await giveATask({ input: { as: 'person:someone', title: 'Rename the photos', assignees: [], key: 't-two', records: read } }, T(8));
  await store.apply(sent.keep);
  read = await store.all();
  const north = await takeATask({ input: { as: 'ai:north', id: 'record:calendar-task:t-two', records: read } }, T(9));
  const south = await takeATask({ input: { as: 'ai:south', id: 'record:calendar-task:t-two', records: read } }, T(9));
  got.race = [await store.apply(north.keep), await store.apply(south.keep)];
  // The loser decides again on what is there now: nothing left for it to take.
  read = await store.all();
  got.loserAgain = (await takeATask({ input: { as: 'ai:south', records: read } }, T(9))).taken;
  // A withdraw of a waiting task by its giver applies, and the list of who can take work shows the taker busy.
  const three = await giveATask({ input: { as: 'person:someone', title: 'Sort the mail', assignees: ['ai:east'], key: 't-three', records: read } }, T(9));
  await store.apply(three.keep);
  read = await store.all();
  const withdraw = await changeATask({ input: { as: 'person:someone', id: 'record:calendar-task:t-three', action: 'withdraw', because: 'Found someone else', records: read } }, T(10));
  got.withdraw = [withdraw.moved, await store.apply(withdraw.keep)];
  read = await store.all();
  got.busy = (await seeWhoCanTakeWork({ input: { records: read } }, T(10))).who.find(one => one.id === 'ai:north').busy;
  const final = await store.all();
  got.final = Object.fromEntries(final.filter(r => r.type === 'calendar-task').map(r => [r.id, r.value.status]));
  got.taker = final.find(r => r.id === 'record:calendar-task:t-two')?.value?.taken_by ?? null;
  got.listed = (await seeTasks({ input: { records: final, status: 'In progress' } }, T(10))).tasks.map(t => t.id);
  return got;
}

const expected = {
  seed: 'applied',
  give: ['written', 1, 'applied'],
  resend: ['written', 0],
  other: 'already-there',
  take: ['In progress', 'applied'],
  handOn: [true, 'applied'],
  personTake: ['In progress', 'applied'],
  plan: [true, 'applied'],
  finish: [true, 'Done', 'applied'],
  race: ['applied', 'conflict'],
  withdraw: [true, 'applied'],
  busy: 1,
  final: {
    'record:calendar-task:t-one': 'Done',
    'record:calendar-task:t-two': 'In progress',
    'record:calendar-task:t-three': 'Not needed',
  },
  taker: 'ai:north',
  listed: ['record:calendar-task:t-two'],
};

test('the keep writes of the task rows give the same answers on PGlite and on a folder of JSON files', async () => {
  const pg = new PGlite();
  const dir = mkdtempSync(join(tmpdir(), 'keep-tasks-proof-'));
  const results = { PGlite: await attempts(pgStore(pg)), 'JSON folder': await attempts(folderStore(dir)) };
  await pg.close();
  for (const [name, got] of Object.entries(results)) {
    for (const key of Object.keys(expected)) assert.deepEqual(got[key], expected[key], `${name}: ${key}`);
    assert.equal(got.loserAgain, null, `${name}: the loser finds nothing to take`);
  }
  assert.deepEqual(results.PGlite, results['JSON folder']);
});
