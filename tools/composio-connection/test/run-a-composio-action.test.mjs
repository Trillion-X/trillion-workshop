// tools/composio-connection/test/run-a-composio-action.test.mjs: one Composio action or one proxied app request, with a stubbed
// Composio. The key is a stand-in; the test checks the one request each sends, the answers and the refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeComposioCall, makeComposioProxy } from '../read-data/composio-call.mjs';
import { runAComposioAction } from '../do-work/run-a-composio-action.mjs';

const STAND_IN_KEY = 'stand-in-key-not-real';
const reply = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const stub = answer => { const sent = []; return { sent, send: async (url, init) => { sent.push({ url: url.toString(), init, body: JSON.parse(init.body) }); return answer; } }; };

test('an action is one execute POST for the account, answered with its data', async () => {
  const s = stub(reply(200, { successful: true, data: { id: 'container-1' } }));
  const answer = await runAComposioAction(
    { action: 'INSTAGRAM_CREATE_CAROUSEL_CONTAINER', account_id: 'ca_1', user_id: 'owner-1', arguments: { caption: 'words' } },
    { execute: makeComposioCall({ read: () => STAND_IN_KEY, send: s.send }), proxy: makeComposioProxy({ read: () => STAND_IN_KEY, send: s.send }) });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].url, 'https://backend.composio.dev/api/v3/tools/execute/INSTAGRAM_CREATE_CAROUSEL_CONTAINER');
  assert.equal(s.sent[0].init.headers['x-api-key'], STAND_IN_KEY);
  assert.deepEqual(s.sent[0].body, { connected_account_id: 'ca_1', user_id: 'owner-1', arguments: { caption: 'words' } });
  assert.deepEqual(answer, { account_id: 'ca_1', action: 'INSTAGRAM_CREATE_CAROUSEL_CONTAINER', data: { id: 'container-1' } });
  assert.ok(!JSON.stringify(answer).includes(STAND_IN_KEY));
});

test('a proxy request carries the app endpoint, method, body and parameters, and answers the app\'s status and data', async () => {
  const s = stub(reply(200, { successful: true, status: 200, data: { id: 'reel-container' } }));
  const answer = await runAComposioAction(
    { account_id: 'ca_1', proxy: { endpoint: '/me/media', method: 'POST', body: { media_type: 'REELS', trial_params: { graduation_strategy: 'MANUAL' } } } },
    { proxy: makeComposioProxy({ read: () => STAND_IN_KEY, send: s.send }) });
  assert.equal(s.sent[0].url, 'https://backend.composio.dev/api/v3/tools/execute/proxy');
  assert.deepEqual(s.sent[0].body, { endpoint: '/me/media', method: 'POST', connected_account_id: 'ca_1', body: { media_type: 'REELS', trial_params: { graduation_strategy: 'MANUAL' } } });
  assert.deepEqual(answer, { account_id: 'ca_1', endpoint: '/me/media', status: 200, data: { id: 'reel-container' } });
});

test('both or neither of action and proxy is refused before anything is sent; so is a bad method or a missing account', async () => {
  const s = stub(reply(200, { successful: true, data: {} }));
  const seams = { execute: makeComposioCall({ read: () => STAND_IN_KEY, send: s.send }), proxy: makeComposioProxy({ read: () => STAND_IN_KEY, send: s.send }) };
  await assert.rejects(runAComposioAction({ account_id: 'ca_1' }, seams), /either action/);
  await assert.rejects(runAComposioAction({ account_id: 'ca_1', action: 'X', proxy: { endpoint: '/a' } }, seams), /either action/);
  await assert.rejects(runAComposioAction({ account_id: 'ca_1', proxy: { endpoint: '/a', method: 'TRACE' } }, seams), /method/);
  await assert.rejects(runAComposioAction({ proxy: { endpoint: '/a' } }, seams), /account id/);
  await assert.rejects(runAComposioAction({ account_id: 'ca_1', action: 'lower_case' }, seams), /upper-case slug/);
  assert.equal(s.sent.length, 0);
});

test('a refusal or an unsuccessful answer is the refuser\'s own words, never an answer', async () => {
  const refused = makeComposioProxy({ read: () => STAND_IN_KEY, send: async () => reply(400, { error: { message: 'Invalid parameter' } }) });
  await assert.rejects(runAComposioAction({ account_id: 'ca_1', proxy: { endpoint: '/me/media', method: 'POST' } }, { proxy: refused }), /Composio refused the POST to \/me\/media \(400\): .*Invalid parameter/);
  const unsuccessful = makeComposioCall({ read: () => STAND_IN_KEY, send: async () => reply(200, { successful: false, error: 'no such account' }) });
  await assert.rejects(runAComposioAction({ account_id: 'ca_1', action: 'GMAIL_SEND_EMAIL' }, { execute: unsuccessful }), /could not run GMAIL_SEND_EMAIL: no such account/);
});

test('a user key goes as x-user-api-key with the project its connections live in, and is refused without one', async () => {
  const USER_KEY = 'uak_stand-in-not-real';
  const s = stub(reply(200, { successful: true, status: 200, data: { username: 'someone' } }));
  const answer = await runAComposioAction(
    { account_id: 'ca_1', user_id: 'consumer-1', project_id: 'pr_Example1', proxy: { endpoint: '/me', method: 'GET' } },
    { proxy: makeComposioProxy({ read: () => USER_KEY, send: s.send }) });
  assert.equal(s.sent[0].init.headers['x-user-api-key'], USER_KEY);
  assert.equal(s.sent[0].init.headers['x-project-id'], 'pr_Example1');
  assert.equal(s.sent[0].init.headers['x-api-key'], undefined);
  assert.equal(s.sent[0].body.user_id, 'consumer-1');
  assert.deepEqual(answer.data, { username: 'someone' });
  await assert.rejects(runAComposioAction({ account_id: 'ca_1', action: 'GMAIL_SEND_EMAIL' }, { execute: makeComposioCall({ read: () => USER_KEY, send: s.send }) }), /project_id/);
  assert.equal(s.sent.length, 1);
});
