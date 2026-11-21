// tools/composio-connection/test/wait-for-a-composio-container.test.mjs: the status loop with a stubbed app. The key is a
// stand-in; sleep is recorded, not waited, so the test runs at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeComposioProxy, Refused } from '../read-data/composio-call.mjs';
import { waitForAComposioContainer } from '../do-work/wait-for-a-composio-container.mjs';

const STAND_IN_KEY = 'stand-in-key-not-real';
const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const statuses = list => {
  const sent = [];
  const proxy = makeComposioProxy({
    read: () => STAND_IN_KEY,
    send: async (url, init) => {
      sent.push({ url: url.toString(), body: JSON.parse(init.body) });
      const code = list[Math.min(sent.length - 1, list.length - 1)];
      return reply(200, { successful: true, status: 200, data: { id: '18079563326737976', status_code: code, status: code } });
    },
  });
  const slept = [];
  return { sent, slept, proxy, sleep: async ms => { slept.push(ms); } };
};
const request = { account_id: 'ca_1', user_id: 'owner-1', container_id: '18079563326737976', every_seconds: 5 };

test('it asks the app for the container status until it is FINISHED, then answers the number of tries', async () => {
  const s = statuses(['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED']);
  const answer = await waitForAComposioContainer(request, { proxy: s.proxy, sleep: s.sleep });
  assert.deepEqual(answer, { account_id: 'ca_1', container_id: '18079563326737976', status_code: 'FINISHED', tries: 3 });
  assert.equal(s.sent.length, 3);
  assert.equal(s.sent[0].url, 'https://backend.composio.dev/api/v3/tools/execute/proxy');
  assert.deepEqual(s.slept, [5000, 5000]);
});

test('an ERROR or EXPIRED container is refused with its own status, never waited on', async () => {
  for (const bad of ['ERROR', 'EXPIRED']) {
    const s = statuses(['IN_PROGRESS', bad]);
    await assert.rejects(waitForAComposioContainer(request, { proxy: s.proxy, sleep: s.sleep }), err => err instanceof Refused && err.message.includes(bad));
    assert.equal(s.sent.length, 2);
  }
});

test('after max_tries still unfinished it is refused with the last status', async () => {
  const s = statuses(['IN_PROGRESS']);
  await assert.rejects(waitForAComposioContainer({ ...request, max_tries: 4 }, { proxy: s.proxy, sleep: s.sleep }), err => err instanceof Refused && /IN_PROGRESS after 4 tries/.test(err.message));
  assert.equal(s.sent.length, 4);
  assert.equal(s.slept.length, 3);
});

test('a non-200 answer from the app is refused, not read as a status', async () => {
  const proxy = makeComposioProxy({ read: () => STAND_IN_KEY, send: async () => reply(200, { successful: true, status: 400, data: { error: { message: 'nope' } } }) });
  await assert.rejects(waitForAComposioContainer(request, { proxy, sleep: async () => {} }), err => err instanceof Refused && err.message.includes('400'));
});

test('bad input is refused before any request leaves', async () => {
  const s = statuses(['FINISHED']);
  await assert.rejects(waitForAComposioContainer({ ...request, container_id: 'not-a-number' }, { proxy: s.proxy, sleep: s.sleep }), Refused);
  await assert.rejects(waitForAComposioContainer({ ...request, max_tries: 500 }, { proxy: s.proxy, sleep: s.sleep }), Refused);
  assert.equal(s.sent.length, 0);
});
