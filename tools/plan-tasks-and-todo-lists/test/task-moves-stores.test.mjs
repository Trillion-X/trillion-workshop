// Proof that the keep writes of the task rows give the same answers on two stores: PGlite (one table, one transaction per
// apply) and a folder of JSON files (one file per record). Made-up people, AIs and tasks only. The attempts are the send,
// a resend, a same-key send with other words, a race for one task, a loser who decides again, a withdraw and the busy count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { changeATask, giveATask, seeWhoCanTakeWork, takeATask } from '../task-moves.mjs';

const T = minutes => () => new Date(Date.parse('2026-11-19T08:00:00.000Z') + minutes * 60000);
const SEED = [
  { id: 'ai:north', type: 'ai', value: { label: 'north', can: ['code'], order: 1, live: { seen_at: '2026-11-19T07:59:00.000Z', minutes: 60 } } },
  { id: 'ai:south', type: 'ai', value: { label: 'south', can: ['code'], order: 2, live: { seen_at: '2026-11-19T07:59:00.000Z', minutes: 60 } } },
  { id: 'ai:east', type: 'ai', value: { label: 'east', can: ['code'], order: 3, live: { seen_at: '2026-11-19T07:59:00.000Z', minutes: 60 } } },
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

async function attempts(store) {
  const got = {};
  const shown = answer => ({ status: answer.status, moved: answer.moved, taken: answer.taken?.id ?? null });
  await store.setup();
  got.seed = await store.apply(SEED.map(r => ({ id: r.id, type: r.type, value: r.value, expected: null })));
  // Send: one write, then the same send again writes nothing, then the same key with other words is already-there.
  let read = await store.all();
  const sent = await giveATask({ input: { as: 'ai:east', description: 'Water the plants', assignees: ['ai:north'], key: 'p-one', records: read } }, { now: T(1) });
  got.send = [sent.status, sent.keep.length, await store.apply(sent.keep)];
  read = await store.all();
  const again = await giveATask({ input: { as: 'ai:east', description: 'Water the plants', assignees: ['ai:north'], key: 'p-one', records: read } }, { now: T(2) });
  got.resend = [again.status, (again.keep ?? []).length];
  const other = await giveATask({ input: { as: 'ai:east', description: 'Something else', key: 'p-one', records: read } }, { now: T(2) });
  got.other = other.status;
  // Race: two AIs read the same waiting task; the first write applies, the second is refused whole and writes nothing.
  const sentTwo = await giveATask({ input: { as: 'ai:east', description: 'Rename the photos', key: 'p-two', records: read } }, { now: T(3) });
  await store.apply(sentTwo.keep);
  read = await store.all();
  const north = await takeATask({ input: { as: 'ai:north', id: 'record:calendar-task:p-two', records: read } }, { now: T(4) });
  const south = await takeATask({ input: { as: 'ai:south', id: 'record:calendar-task:p-two', records: read } }, { now: T(4) });
  got.race = [await store.apply(north.keep), await store.apply(south.keep)];
  // The loser decides again on what is there now: nothing left for it to take.
  read = await store.all();
  got.loserAgain = shown(await takeATask({ input: { as: 'ai:south', records: read } }, { now: T(5) }));
  // A withdraw of a waiting task by its sender applies, and the list of who can take work shows the taker busy.
  const withdraw = await changeATask({ input: { as: 'ai:east', id: 'record:calendar-task:p-one', action: 'withdraw', because: 'Found some', records: read } }, { now: T(6) });
  got.withdraw = [withdraw.moved, await store.apply(withdraw.keep)];
  read = await store.all();
  got.busy = (await seeWhoCanTakeWork({ input: { records: read } }, { now: T(6) })).who.find(one => one.id === 'ai:north').busy;
  const final = await store.all();
  got.final = Object.fromEntries(final.filter(r => r.type === 'calendar-task').map(r => [r.id, r.value.status]));
  got.taker = final.find(r => r.id === 'record:calendar-task:p-two')?.value?.taken_by ?? null;
  return got;
}

const expected = {
  seed: 'applied',
  send: ['written', 1, 'applied'],
  resend: ['written', 0],
  other: 'already-there',
  race: ['applied', 'conflict'],
  loserAgain: { status: undefined, moved: undefined, taken: null },
  withdraw: [true, 'applied'],
  busy: 1,
  final: { 'record:calendar-task:p-one': 'Not needed', 'record:calendar-task:p-two': 'In progress' },
  taker: 'ai:north',
};

test('the keep writes of the tasks give the same answers on PGlite and on a folder of JSON files', async () => {
  const pg = new PGlite();
  const dir = mkdtempSync(join(tmpdir(), 'task-moves-proof-'));
  const results = { PGlite: await attempts(pgStore(pg)), 'JSON folder': await attempts(folderStore(dir)) };
  await pg.close();
  for (const [name, got] of Object.entries(results)) {
    for (const key of Object.keys(expected)) {
      if (key === 'loserAgain') assert.equal(got[key].taken, null, `${name}: the loser finds nothing to take`);
      else assert.deepEqual(got[key], expected[key], `${name}: ${key}`);
    }
  }
  assert.deepEqual(results.PGlite, results['JSON folder']);
});
