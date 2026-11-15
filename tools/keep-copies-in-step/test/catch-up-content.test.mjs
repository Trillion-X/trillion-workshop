import test from 'node:test';
import assert from 'node:assert/strict';
import bootstrap from '../read-data/catch-up.json' with { type: 'json' };
import { resolveCatchUpPresentation, currentCatchUp } from '../read-data/catch-up-content.mjs';
const host = resolveContent => ({ bootstrap, resolveContent });
test('selects only three public sections with publication revision evidence', async () => {
  const pointers = [];
  const answer = await resolveCatchUpPresentation(host(async (source, value) => { pointers.push(source.pointer); return { found: true, from: 'published', revision: 4, value }; }));
  assert.deepEqual(pointers, ['/words', '/title_fields', '/copy_state']); assert.equal(answer.status.available, true); assert.equal(answer.status.sections[0].revision, 4);
  assert.deepEqual(answer.value, { words: bootstrap.words, title_fields: bootstrap.title_fields, copy_state: bootstrap.copy_state });
});
test('withdrawn, invalid and failed optional content stay absent', async () => {
  const answer = await resolveCatchUpPresentation(host(async ({ pointer }) => {
    if (pointer === '/words') return { found: false, from: 'withdrawn' };
    if (pointer === '/title_fields') return { found: true, from: 'published', value: [1] };
    throw new Error('offline');
  }));
  assert.deepEqual(answer.value, { words: {}, title_fields: [], copy_state: '' }); assert.equal(answer.status.available, false);
  assert.equal(answer.status.sections[0].from, 'withdrawn'); assert.equal(answer.status.sections[1].code, 'marketplace_content_source_unavailable');
});
test('stalled public content releases private facts; late data cannot mutate response', async () => {
  let release; const stalled = new Promise(done => { release = done; });
  const answer = await resolveCatchUpPresentation(host(async (_source, value) => { await stalled; return { found: true, from: 'published', value }; }));
  const before = structuredClone(answer); release(); await new Promise(done => setImmediate(done));
  assert.deepEqual(answer, before); assert.equal(answer.status.sections[0].code, 'marketplace_content_source_timeout');
});
test('rights are rechecked after optional read and private snapshot is taken afterward', async () => {
  let state = 1, checks = 0;
  const wrapped = currentCatchUp({ read: async () => ({ private: state }), here: body => body, settle: (_body, _context, options) => options },
    host(async (_source, value) => { state = 2; return { found: true, from: 'published', value }; }), { current: async () => { checks++; } });
  assert.equal((await wrapped.read()).private, 2); assert.equal(checks, 2); assert.deepEqual(await wrapped.settle({}, {}), { rawReceipt: true });
  const denied = currentCatchUp({ read() { throw new Error('private should not be touched'); } }, host(async () => ({ found: false, from: 'withdrawn' })), { current: async () => { throw new Error('rights refused'); } });
  await assert.rejects(denied.read(), /rights refused/);
});

test('revocation during optional presentation refuses the private snapshot', async () => {
  let checks = 0, touched = false;
  const wrapped = currentCatchUp({ read() { touched = true; return {}; } },
    host(async (_source, value) => ({ found: true, from: 'published', value })),
    { current: async () => { if (++checks === 2) throw new Error('revoked'); } });
  await assert.rejects(wrapped.read(), /revoked/); assert.equal(touched, false);
});
