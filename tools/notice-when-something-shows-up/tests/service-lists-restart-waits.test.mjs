// A watcher the engine starts again keeps the last run's read_at, so it waits out the rest of look_again_seconds before
// reading instead of reading at every restart; a state with no read_at (or one long past) reads at once, and every kept
// state carries the time of its read. A stand-in list service; made-up rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { watchForTransitions } from '../do-work/mechanisms/service-lists.mjs';

const ROW = { where: 'made-up-list', request: { url: 'https://list.example.com/items' }, shape: { items: 'data', place: { value: 'message' }, key: 'id' }, look_again_seconds: 3600 };

async function run(state, ms) {
  const asked = [];
  const kept = [];
  const controller = new AbortController();
  const fetch = async (url) => { asked.push(url); return { ok: true, status: 200, json: async () => ({ data: [{ id: 1 }] }) }; };
  const watching = watchForTransitions(ROW, { credential: 'made-up', fetch, state, signal: controller.signal,
    keepState: async (next) => { kept.push(next); }, onTransition: async () => true });
  await new Promise((resolve) => setTimeout(resolve, ms));
  controller.abort();
  await watching;
  return { asked, kept };
}

test('a restart within look_again waits instead of reading', async () => {
  const { asked } = await run({ seen: { 1: 'x' }, read_at: Date.now() - 60_000 }, 150);
  assert.equal(asked.length, 0);
});

test('a state read long ago, or with no read_at, reads at once and keeps the time of its read', async () => {
  const before = Date.now();
  const old = await run({ seen: { 1: 'x' }, read_at: before - 2 * 3_600_000 }, 150);
  assert.equal(old.asked.length, 1);
  assert.ok(old.kept.at(-1).read_at >= before);
  const none = await run(null, 150);
  assert.equal(none.asked.length, 1);
  assert.ok(Number.isFinite(none.kept.at(-1).read_at));
});
