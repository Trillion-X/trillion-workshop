// A kept state names the print rule its fingerprints were made under and keeps the rule itself. When the row's rule
// changes, the things are compared under the old rule first: a change not yet told (one the door refused) is told once,
// a refused tell keeps the old rule and fingerprints, and only then is everything kept under the new rule. A state that
// names a rule it cannot read back is adopted silently and the count is said. A stand-in list service; made-up rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { watchForTransitions } from '../do-work/mechanisms/service-lists.mjs';

const whole = (item) => createHash('sha256').update(JSON.stringify(item)).digest('base64url').slice(0, 16);
const PRINT = ['id', 'starts_at'];
const row = (print) => ({ where: 'made-up-list', request: { url: 'https://list.example.com/items' }, look_again_seconds: 3600,
  shape: { items: 'data', place: { value: 'booking' }, key: 'id', ...(print ? { print } : {}) } });

async function run(settings, state, data, { refuse = () => false } = {}) {
  const told = [];
  const kept = [];
  const said = [];
  const controller = new AbortController();
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ data }) });
  const error = console.error;
  console.error = (...words) => { said.push(words.join(' ')); };
  try {
    const watching = watchForTransitions(settings, { credential: 'made-up', fetch, state: state && { ...state, read_at: undefined },
      signal: controller.signal, keepState: async (next) => { kept.push(next); },
      onTransition: async (one) => { if (refuse(one)) return false; told.push(one); return true; } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    await watching;
  } finally {
    console.error = error;
  }
  return { told, kept, said, state: kept.at(-1) };
}

const before = [{ id: 1, starts_at: 'a', type: { updated_at: 'old' } }, { id: 2, starts_at: 'b', type: { updated_at: 'old' } }];
const typeEdited = before.map((one) => ({ ...one, type: { updated_at: 'new' } }));

test('a rule change with nothing pending tells nothing and keeps the new rule', async () => {
  const first = await run(row(null), null, before);
  assert.equal(first.told.length, 0);
  const named = await run(row(PRINT), first.state, before);
  assert.equal(named.told.length, 0);
  assert.deepEqual(named.state.print, PRINT);
  const edited = await run(row(PRINT), named.state, typeEdited);
  assert.equal(edited.told.length, 0, 'a field outside print does not tell');
  const moved = await run(row(PRINT), named.state, [{ ...before[0], starts_at: 'c' }, before[1]]);
  assert.deepEqual(moved.told.map((one) => one.detail.key), ['1'], 'a printed field tells');
});

test('a change the door refused, then a rule change: the change is told once', async () => {
  const first = await run(row(null), null, before);
  const cancelled = [{ ...before[0], starts_at: 'cancelled' }, before[1]];
  const refused = await run(row(null), first.state, cancelled, { refuse: () => true });
  assert.equal(refused.told.length, 0);
  const named = await run(row(PRINT), refused.state, cancelled);
  assert.deepEqual(named.told.map((one) => `${one.detail.key}:${one.detail.change}`), ['1:changed']);
  assert.deepEqual(named.state.print, PRINT);
  const again = await run(row(PRINT), named.state, cancelled);
  assert.equal(again.told.length, 0, 'told once, not again');
});

test('a refusal during the rule-change pass keeps the old rule and its fingerprints', async () => {
  const first = await run(row(null), null, before);
  const cancelled = [{ ...before[0], starts_at: 'cancelled' }, before[1]];
  const refused = await run(row(PRINT), first.state, cancelled, { refuse: () => true });
  assert.equal(refused.told.length, 0);
  assert.equal(refused.state.print, null, 'the rule is not advanced');
  assert.deepEqual(refused.state.seen, first.state.seen, 'the old fingerprints are kept');
});

test('a state from before rules were kept is read under the whole-thing rule', async () => {
  const old = { seen: { 1: whole(before[0]), 2: whole(before[1]) } };
  const named = await run(row(PRINT), old, typeEdited);
  assert.deepEqual(named.told.map((one) => one.detail.key).sort(), ['1', '2'], 'the type edit is a real whole-thing change, told before the rule moves');
});

test('a state naming a rule it cannot read back is adopted silently and the count is said', async () => {
  const kept = { seen: { 1: 'made-up', 2: 'made-up' }, print_rule: 'made-up-rule' };
  const named = await run(row(PRINT), kept, typeEdited);
  assert.equal(named.told.length, 0);
  assert.ok(named.said.some((words) => words.includes('2 things were adopted')), 'the count is said');
  assert.deepEqual(named.state.print, PRINT);
});
