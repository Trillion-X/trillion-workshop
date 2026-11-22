// A kept state names the print rule its fingerprints were made under. A state made under another rule (or an older state
// that names none, made from the whole thing) is read again once without telling anything, so naming shape.print never
// tells every thing as changed; after that, a change in a printed field is told and a change outside print is not.
// A stand-in list service; made-up rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { watchForTransitions } from '../do-work/mechanisms/service-lists.mjs';

const whole = (item) => createHash('sha256').update(JSON.stringify(item)).digest('base64url').slice(0, 16);
const ROW = { where: 'made-up-list', request: { url: 'https://list.example.com/items' }, look_again_seconds: 3600,
  shape: { items: 'data', place: { value: 'booking' }, key: 'id', print: ['id', 'starts_at'] } };

async function run(state, data, ms = 150) {
  const told = [];
  const kept = [];
  const controller = new AbortController();
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ data }) });
  const watching = watchForTransitions(ROW, { credential: 'made-up', fetch, state, signal: controller.signal,
    keepState: async (next) => { kept.push(next); }, onTransition: async (one) => { told.push(one); return true; } });
  await new Promise((resolve) => setTimeout(resolve, ms));
  controller.abort();
  await watching;
  return { told, kept };
}

test('a state kept under the whole-thing rule is read again silently once print is named', async () => {
  const before = [{ id: 1, starts_at: 'a', type: { updated_at: 'old' } }, { id: 2, starts_at: 'b', type: { updated_at: 'old' } }];
  const now = before.map((one) => ({ ...one, type: { updated_at: 'new' } }));
  const { told, kept } = await run({ seen: { 1: whole(before[0]), 2: whole(before[1]) } }, now);
  assert.equal(told.length, 0);
  assert.ok(kept.at(-1).print_rule, 'the kept state names its print rule');
  const again = await run({ ...kept.at(-1), read_at: undefined }, now.map((one) => ({ ...one, type: { updated_at: 'newer' } })));
  assert.equal(again.told.length, 0, 'a field outside print does not tell');
  const moved = await run({ ...kept.at(-1), read_at: undefined }, [{ ...now[0], starts_at: 'c' }, now[1]]);
  assert.deepEqual(moved.told.map((one) => one.detail.key), ['1'], 'a printed field tells');
});
