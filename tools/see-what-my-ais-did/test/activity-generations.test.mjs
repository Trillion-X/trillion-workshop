// The AI activity a person keeps: what a call leaves, how the newest rows are read, how a trace follows links, and when the
// generations roll. An in-memory store stands in for the database; the Postgres store is run by the pinned proof. Every name
// and id here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepRow, listRows, traceItem, checkRow, ActivityError, KEEP } from '../read-data/activity-generations.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function memoryStore() {
  const gens = new Map();
  const visible = () => [...gens.keys()].sort((a, b) => a - b).slice(-2);
  const all = () => visible().flatMap(n => gens.get(n).rows.map(row => ({ n, ...row })));
  const links = () => visible().flatMap(n => gens.get(n).links.map(link => ({ n, ...link })));
  return {
    gens,
    async generations() { return [...gens.keys()].sort((a, b) => a - b); },
    async createGeneration(n) { if (!gens.has(n)) gens.set(n, { rows: [], links: [], counts: new Map() }); },
    async refreshViews() {},
    async roll(previous, next) {
      await this.createGeneration(next);
      for (const n of [...gens.keys()]) if (n < previous) gens.delete(n);
    },
    async count(n) { return gens.get(n).rows.length; },
    async maxSeq() { return all().reduce((top, row) => Math.max(top, row.seq), 0); },
    async insertRow(n, row) { gens.get(n).rows.push(row); },
    async insertLinks(n, seq, list) { for (const link of list) gens.get(n).links.push({ seq, ...link }); },
    async bumpCounts(n, ids) { for (const id of ids) gens.get(n).counts.set(id, (gens.get(n).counts.get(id) ?? 0) + 1); },
    async list({ before, app, failed, forIds, limit }) {
      const forSeqs = new Set(links().filter(link => link.role === 'for' && forIds.includes(link.id)).map(link => link.seq));
      return all()
        .filter(row => before === null || row.seq < before)
        .filter(row => app === null || row.app === app)
        .filter(row => !failed || row.ok === 0)
        .filter(row => !forIds.length || forSeqs.has(row.seq))
        .sort((a, b) => b.seq - a.seq).slice(0, limit)
        .map(row => ({ seq: row.seq, row: row.row }));
    },
    async links({ id, roles, newest, limit }) {
      return links().filter(link => link.id === id && roles.includes(link.role))
        .sort((a, b) => (newest ? b.seq - a.seq : a.seq - b.seq)).slice(0, limit).map(({ seq, role }) => ({ seq, role }));
    },
    async rowsBySeq(seqs) {
      return new Map(all().filter(row => seqs.includes(row.seq)).map(row => [row.seq, row.row]));
    },
  };
}

const call = fields => ({ tool: 'tool:sample-tool', at: '2026-11-20T04:30:00-06:00', app: 'sample-app', ok: true, uses: [], for: [], ...fields });

test('a row keeps its links, and the newest reads back first with its app and its seq', async () => {
  const store = memoryStore();
  await keepRow(store, call({ item: 'file:made-1', label: 'Made a file' }));
  await keepRow(store, call({ item: 'file:made-2', app: 'other-app', label: 'Made another file' }));
  const { items } = await listRows(store, { app: 'sample-app' });
  assert.deepEqual(items.map(item => item.item), ['file:made-1']);
  const all = await listRows(store, {});
  assert.deepEqual(all.items.map(item => item.seq), [2, 1]);
});

test('a for-filter reads only the calls done for that id, and a failed-filter reads only the failed ones', async () => {
  const store = memoryStore();
  await keepRow(store, call({ item: 'draft:a', for: ['goal:one'] }));
  await keepRow(store, call({ item: 'draft:b', for: ['goal:two'], ok: false, reason: 'made-up reason' }));
  assert.deepEqual((await listRows(store, { for: 'goal:one' })).items.map(item => item.item), ['draft:a']);
  const failed = await listRows(store, { failed: 'true' });
  assert.deepEqual(failed.items.map(item => item.item), ['draft:b']);
  assert.equal(failed.items[0].reason, 'made-up reason');
});

test('a trace follows what made the item, then what used it and what it was done for', async () => {
  const store = memoryStore();
  await keepRow(store, call({ item: 'file:source', label: 'Read a note' }));
  await keepRow(store, call({ item: 'file:target', uses: ['file:source'], label: 'Wrote a summary' }));
  await keepRow(store, call({ item: 'mail:reply', uses: ['file:target'], label: 'Sent a reply' }));
  const trace = await traceItem(store, { item: 'file:target', depth: 2 });
  const made = trace.steps.filter(step => step.link === 'made').map(step => [step.about, step.depth]);
  assert.deepEqual(made, [['file:target', 0], ['file:source', 1]]);
  const after = trace.steps.filter(step => step.link === 'used').map(step => step.item);
  assert.deepEqual(after, ['mail:reply']);
});

test('a trace with no item, or an item nothing made, is empty and says so', async () => {
  const store = memoryStore();
  assert.deepEqual(await traceItem(store, { item: '  ' }), { item: null, steps: [] });
  assert.deepEqual((await traceItem(store, { item: 'file:nothing' })).steps, []);
});

test('the newest generation rolls when it holds keep rows; the older one goes whole and paging reads the rest', async () => {
  const store = memoryStore();
  for (let n = 1; n <= 7; n += 1) await keepRow(store, call({ item: `file:${n}` }), 3);
  assert.deepEqual(await store.generations(), [2, 3]);
  const page = await listRows(store, { limit: 2 });
  assert.deepEqual(page.items.map(item => item.seq), [7, 6]);
  const rest = await listRows(store, { limit: 2, before: page.next_before });
  assert.deepEqual(rest.items.map(item => item.seq), [5, 4]);
  assert.equal(rest.next_before, null);
});

test('a row a person sends without a tool or a time is refused; the id lists must be lists', () => {
  assert.throws(() => checkRow({ at: '2026-11-20T04:30:00-06:00' }), ActivityError);
  assert.throws(() => checkRow({ tool: 'tool:x' }), ActivityError);
  assert.throws(() => checkRow({ tool: 'tool:x', at: 'now', uses: 'file:one' }), /must be a list/);
  assert.throws(() => checkRow(null), /Give row/);
});

test('KEEP is the keep count in activity-marks.json, where the shared activity library reads it', () => {
  const marks = resolve(here, '..', '..', 'shared-code', 'src', 'activity-marks.json');
  if (!existsSync(marks)) return;
  assert.equal(KEEP, JSON.parse(readFileSync(marks, 'utf8')).keep);
});
