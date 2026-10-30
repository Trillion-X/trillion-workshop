import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPageTarget } from '../devtools.mjs';

test('DevTools creates and attaches an owned page when the browser has no startup target', async () => {
  const calls = [];
  const attached = await attachPageTarget(async (method, params) => {
    calls.push({ method, params });
    if (method === 'Target.getTargets') return { targetInfos: [] };
    if (method === 'Target.createTarget') return { targetId: 'owned-page' };
    if (method === 'Target.attachToTarget') return { sessionId: 'owned-session' };
    throw new Error(`unexpected DevTools method ${method}`);
  });
  assert.deepEqual(attached, { targetId: 'owned-page', sessionId: 'owned-session' });
  assert.deepEqual(calls, [
    { method: 'Target.getTargets', params: undefined },
    { method: 'Target.createTarget', params: { url: 'about:blank' } },
    { method: 'Target.attachToTarget', params: { targetId: 'owned-page', flatten: true } },
  ]);
});

test('DevTools attaches to an ordinary existing page without creating another', async () => {
  const calls = [];
  const attached = await attachPageTarget(async (method, params) => {
    calls.push({ method, params });
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'existing-page', type: 'page' }] };
    if (method === 'Target.attachToTarget') return { sessionId: 'existing-session' };
    throw new Error(`unexpected DevTools method ${method}`);
  });
  assert.deepEqual(attached, { targetId: 'existing-page', sessionId: 'existing-session' });
  assert.deepEqual(calls, [
    { method: 'Target.getTargets', params: undefined },
    { method: 'Target.attachToTarget', params: { targetId: 'existing-page', flatten: true } },
  ]);
});
