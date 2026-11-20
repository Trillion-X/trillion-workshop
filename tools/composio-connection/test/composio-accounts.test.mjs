// tools/composio-connection/test/composio-accounts.test.mjs: the connected-accounts list, read with a stubbed Composio. The key
// is a stand-in; the test checks the one request, the rows it answers, the refusals and that the key appears nowhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeComposioAccounts, accountOf } from '../read-data/composio-accounts.mjs';
import { listConnectedAccounts } from '../do-work/list-connected-accounts.mjs';

const STAND_IN_KEY = 'stand-in-key-not-real';
const reply = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('the list is one GET with the key in the header, and each account names its owning user', async () => {
  const sent = [];
  const send = async (url, init) => { sent.push({ url: url.toString(), init }); return reply(200, { items: [{ id: 'twitter_terma-weedy', user_id: 'owner-1', toolkit: { slug: 'twitter' }, alias: 'x-account', status: 'ACTIVE' }] }); };
  const listAccounts = makeComposioAccounts({ read: () => STAND_IN_KEY, send });
  const accounts = await listAccounts({ toolkit: 'twitter' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://backend.composio.dev/api/v3/connected_accounts?toolkit_slugs=twitter');
  assert.equal(sent[0].init.method, 'GET');
  assert.equal(sent[0].init.redirect, 'manual');
  assert.equal(sent[0].init.headers['x-api-key'], STAND_IN_KEY);
  assert.deepEqual(accounts, [{ id: 'twitter_terma-weedy', user_id: 'owner-1', toolkit: 'twitter', alias: 'x-account', status: 'ACTIVE' }]);
});

test('an answer that is a bare list is read the same way, and a missing user is null, not a guess', () => {
  assert.deepEqual(accountOf({ id: 'a1', toolkit: { slug: 'gmail' }, status: 'ACTIVE' }), { id: 'a1', user_id: null, toolkit: 'gmail', alias: null, status: 'ACTIVE' });
});

test('a refusal is Composio\'s own words; a reply with no JSON or no items is refused, never an empty list', async () => {
  const refused = makeComposioAccounts({ read: () => STAND_IN_KEY, send: async () => reply(401, { error: { message: 'Invalid API key' } }) });
  await assert.rejects(refused({}), /Composio refused the account list \(401\): .*Invalid API key/);
  const notJson = makeComposioAccounts({ read: () => STAND_IN_KEY, send: async () => reply(200, 'not json') });
  await assert.rejects(notJson({}), /no JSON/);
  const noItems = makeComposioAccounts({ read: () => STAND_IN_KEY, send: async () => reply(200, { other: 1 }) });
  await assert.rejects(noItems({}), /without its items/);
});

test('a toolkit that is not a slug is refused before any request leaves, and no key means no request', async () => {
  let called = false;
  const send = async () => { called = true; return reply(200, { items: [] }); };
  await assert.rejects(makeComposioAccounts({ read: () => STAND_IN_KEY, send })({ toolkit: 'Twitter?x=1' }), /lower-case slug/);
  assert.equal(called, false);
  await assert.rejects(makeComposioAccounts({ read: () => '', send })({}), /not held/);
  assert.equal(called, false);
});

test('the tool answers the count and the accounts, and no answer carries the key', async () => {
  const list = async ({ toolkit }) => [{ id: 'x1', user_id: 'owner-1', toolkit: toolkit ?? null, alias: null, status: 'ACTIVE' }];
  const answer = await listConnectedAccounts({ toolkit: 'twitter' }, { list });
  assert.deepEqual(answer, { toolkit: 'twitter', count: 1, accounts: [{ id: 'x1', user_id: 'owner-1', toolkit: 'twitter', alias: null, status: 'ACTIVE' }] });
  assert.equal(JSON.stringify(answer).includes(STAND_IN_KEY), false);
});

test('a person\'s own key is sent as the user key header with the project id, and the project id is never a guess', async () => {
  const sent = [];
  const send = async (url, init) => { sent.push(init); return reply(200, { items: [] }); };
  const listAccounts = makeComposioAccounts({ read: () => 'uak_stand-in-not-real', send });
  await listAccounts({ projectId: 'pr_stand_in_not_real' });
  assert.equal(sent[0].headers['x-user-api-key'], 'uak_stand-in-not-real');
  assert.equal(sent[0].headers['x-project-id'], 'pr_stand_in_not_real');
  assert.equal(sent[0].headers['x-api-key'], undefined);
});

test('a person\'s own key with no project named is sent to their organization\'s own project, which Composio answers from the key', async () => {
  const sent = [];
  const send = async (url, init) => {
    sent.push({ url: url.toString(), init });
    if (url.pathname.endsWith('/auth/session/info')) return reply(200, { project: { org: { id: 'ok_stand_in' } } });
    if (url.pathname.endsWith('/org/consumer/project/resolve')) return reply(200, { project_nano_id: 'pr_stand_in_own', project_type: 'CONSUMER' });
    return reply(200, { items: [] });
  };
  const listAccounts = makeComposioAccounts({ read: () => 'uak_stand-in-not-real', send });
  await listAccounts({});
  await listAccounts({ toolkit: 'twitter' });
  assert.deepEqual(sent.map(s => `${s.init.method} ${new URL(s.url).pathname}`), ['GET /api/v3.1/auth/session/info', 'POST /api/v3.1/org/consumer/project/resolve', 'GET /api/v3/connected_accounts', 'GET /api/v3/connected_accounts']);
  assert.equal(sent[1].init.headers['x-org-id'], 'ok_stand_in');
  for (const list of sent.slice(2)) {
    assert.equal(list.init.headers['x-project-id'], 'pr_stand_in_own');
    assert.equal(list.init.headers['x-org-id'], 'ok_stand_in');
    assert.equal(list.init.redirect, 'manual');
  }
});

test('when Composio names no organization or no own project, the list is refused with the way out, never sent unscoped', async () => {
  const lists = [];
  const answering = session => async (url, init) => {
    if (url.pathname.endsWith('/auth/session/info')) return reply(200, session);
    if (url.pathname.endsWith('/resolve')) return reply(200, { project_type: 'CONSUMER' });
    lists.push(init); return reply(200, { items: [] });
  };
  await assert.rejects(makeComposioAccounts({ read: () => 'uak_stand-in-not-real', send: answering({}) })({}), /organization.*project_id/);
  await assert.rejects(makeComposioAccounts({ read: () => 'uak_stand-in-not-real', send: answering({ project: { org: { id: 'ok_x' } } }) })({}), /own project.*project_id/);
  await assert.rejects(makeComposioAccounts({ read: () => 'uak_stand-in-not-real', send: async () => reply(401, 'bad key') })({}), /Composio refused the key's organization \(401\)/);
  assert.equal(lists.length, 0);
});
