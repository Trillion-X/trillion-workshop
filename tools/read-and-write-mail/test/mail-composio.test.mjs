// tools/read-and-write-mail/test/mail-composio.test.mjs
// The Composio Gmail provider: one operation reaches the mailbox through one Composio proxy request, with the person's
// connected account and its owning user and project named, and the key sent only to Composio's own host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { perform } from '../read-data/mail.mjs';

const STAND_IN_KEY = 'ak_stand_in_not_real';
const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('find-mail through the Composio Gmail provider is one proxy request to the Gmail address, with the account named', async () => {
  const sent = [];
  const send = async (url, init) => { sent.push({ url: url.toString(), init }); return reply({ successful: true, data: { messages: [{ id: 'm1' }] }, status: 200 }); };
  const answer = await perform('find-mail', {
    provider: 'gmail-via-composio',
    connection: { connection_id: 'ca_stand_in', user_id: 'user_stand_in', project_id: 'pr_stand_in' },
    folder: 'inbox',
  }, { read: () => STAND_IN_KEY, send });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://backend.composio.dev/api/v3/tools/execute/proxy');
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.headers['x-api-key'], STAND_IN_KEY);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.connected_account_id, 'ca_stand_in');
  assert.equal(body.user_id, 'user_stand_in');
  assert.equal(body.method, 'GET');
  assert.ok(body.endpoint.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages'), body.endpoint);
  assert.ok(JSON.stringify(answer).includes('m1'));
});
