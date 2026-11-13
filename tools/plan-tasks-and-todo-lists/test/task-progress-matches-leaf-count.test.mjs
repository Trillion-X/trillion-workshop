// A task's progress equals a direct count of its settled end rows over all its end rows, for every row of any tree, and a read does
// not grow exponentially with depth. The trees are random (seeded) and the expected values come from counting, not from the owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import data from '../calendar-tasks.json' with { type: 'json' };
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists, handleListsRequest } from '../../keep-lists-of-rows/lists.mjs';
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { changeCalendarTask } from '../calendar-tasks.mjs';

const evaluator = makeRowFilter({ operators, wasm: () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)) });
const ruleKinds = new Map(settings.field_kinds.map(kind => [kind.id, kind.ruleKind]));
const views = { filterRows: input => evaluator.filterRowsByRules(input), ruleKindOf: kind => ruleKinds.get(kind) ?? kind,
  evaluateBinding: async (binding, input) => (await evaluator.evaluateBinding({ binding, input })).value };
const fresh = t => {
  const store = localStore(':memory:');
  t.after(() => store.close?.());
  let n = 0;
  return makeLists({ eeaf: store.eeaf, newId: () => `row-${++n}` });
};
const readAll = async lists => (await (await handleListsRequest(lists, new Request(`https://person/lists/${data.list.id}`), views)).json()).rows;
const seeded = seed => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

test('for every row of random trees the share equals a direct count of settled end rows over all end rows', async t => {
  const rand = seeded(20261113);
  for (let tree = 0; tree < 6; tree++) {
    const lists = fresh(t);
    const parent = new Map(); const ids = [];
    const make = async (key, p) => { const id = (await changeCalendarTask(lists, { action: 'create', request_key: key, title: key, duration_minutes: 15, ...(p ? { parent_id: p } : {}) })).task.id; parent.set(id, p ?? null); ids.push(id); return id; };
    const top = await make(`top${tree}`);
    for (let i = 0; i < 40; i++) await make(`t${tree}-${i}`, ids[Math.floor(rand() * ids.length)]);
    const kids = new Map(); for (const [id, p] of parent) if (p) kids.set(p, [...(kids.get(p) ?? []), id]);
    const endRows = id => (kids.has(id) ? kids.get(id).flatMap(endRows) : [id]);
    const done = new Set(ids.filter(() => rand() < 0.4));
    for (const id of done) await changeCalendarTask(lists, { action: 'complete', task_id: id });
    const rows = Object.fromEntries((await readAll(lists)).map(row => [row.id, row.values]));
    for (const id of ids) {
      const ends = endRows(id);
      const settled = ends.filter(end => done.has(end)).length;
      assert.equal(rows[id].steps_total, ends.length, `end rows under ${id}`);
      assert.equal(rows[id].steps_done, settled, `settled end rows under ${id}`);
      // The engine rounds a half to the even number (5 of 8 is 62), so the check is that the shown percent is within a half of the exact share.
      assert.ok(Math.abs(rows[id].progress - (100 * settled) / ends.length) <= 0.5, `progress of ${id}: ${rows[id].progress} for ${settled} of ${ends.length}`);
    }
  }
});

test('a read does not grow exponentially with depth: a chain 24 deep reads in a small multiple of a chain 8 deep', async t => {
  const chain = async depth => {
    const lists = fresh(t);
    let p = (await changeCalendarTask(lists, { action: 'create', request_key: 'root', title: 'root', duration_minutes: 15 })).task.id;
    for (let i = 0; i < depth; i++) p = (await changeCalendarTask(lists, { action: 'create', request_key: `c${i}`, title: `c${i}`, duration_minutes: 15, parent_id: p })).task.id;
    const start = performance.now();
    await readAll(lists);
    return performance.now() - start;
  };
  const shallow = await chain(8);
  const deep = await chain(24);
  // Doubling per level would make 24 levels about 65,000 times the cost of 8; reading 3 times the rows costs about 3 to 9 times.
  assert.ok(deep < Math.max(shallow, 20) * 50, `24 deep took ${deep} ms against ${shallow} ms for 8 deep`);
});
