import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listDomains } from '../do-work/list-email-sending-domains.mjs';

const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records[0].payload;
const canary = 'held-key-canary-0123456789';
const answering = (status, body) => async (address, request) => {
  assert.equal(address, 'https://api.resend.com/domains');
  assert.equal(request.headers.Authorization, `Bearer ${canary}`);
  return { status, ok: status >= 200 && status < 300, json: async () => body };
};

test('the row hands the held key on a private pipe and runs on the person\'s computer', () => {
  assert.equal(row.id, 'tool:list-email-sending-domains');
  assert.deepEqual(row.invoke.credential_mounts, [{ secret_name: 'resend-api-key', fd: 3 }]);
  assert.equal(row.invoke.internet, true);
  assert.deepEqual(row.placements, ['placement:your-computer']);
});

test('answers domain names, states and the count only, never the key or the raw reply', async () => {
  const answer = await listDomains({ key: `${canary}\n`, fetchImpl: answering(200, { data: [
    { id: 'd-1', name: 'example.com', status: 'verified', region: 'us-east-1', records: [{ value: 'v=spf1' }] },
    { id: 'd-2', name: 'example.org', status: 'pending' },
  ] }) });
  assert.deepEqual(answer, { domains: [{ name: 'example.com', status: 'verified' }, { name: 'example.org', status: 'pending' }], count: 2 });
  assert.ok(!JSON.stringify(answer).includes(canary));
});

test('a refused or missing key says what to do, without the key', async () => {
  await assert.rejects(listDomains({ key: canary, fetchImpl: answering(401, {}) }), error => /Connect the account again/.test(error.message) && !error.message.includes(canary));
  await assert.rejects(listDomains({ key: '', fetchImpl: answering(200, {}) }), /Connect the email-sending account first/);
});

test('the sending-key row asks for a sending-only key and keeps the reply\'s token in the vault, never in the answer', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const maker = rows.find(one => one.id === 'tool:make-a-sending-key-with-resend');
  assert.equal(maker.invoke.kind, 'http');
  assert.equal(maker.invoke.url, 'https://api.resend.com/api-keys');
  assert.deepEqual(maker.invoke.body_template.permission, { const: 'sending_access' });
  assert.deepEqual(maker.invoke.credential_injections, [
    { secret_name: 'resend-api-key', hosts: ['api.resend.com'], placement: { kind: 'header', name: 'Authorization', prefix: 'Bearer ' } },
  ]);
  assert.deepEqual(maker.invoke.reply_holds_values, [{ from: 'token', secret_name_from_input: 'keep_as' }]);
  assert.deepEqual(maker.input_schema.required, ['name', 'keep_as']);
  assert.ok(new RegExp(maker.input_schema.properties.keep_as.pattern).test('resend-sign-in-proof-key'));
  assert.ok(!new RegExp(maker.input_schema.properties.keep_as.pattern).test('Resend API Key'));
});

test('the domain rows add, read and check a domain with the held key in the header, and change no DNS', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const header = [{ secret_name: 'resend-api-key', hosts: ['api.resend.com'], placement: { kind: 'header', name: 'Authorization', prefix: 'Bearer ' } }];
  const add = rows.find(one => one.id === 'tool:add-an-email-sending-domain');
  assert.deepEqual([add.invoke.kind, add.invoke.method, add.invoke.url], ['http', 'POST', 'https://api.resend.com/domains']);
  assert.deepEqual(add.invoke.credential_injections, header);
  assert.deepEqual(add.input_schema.required, ['name']);
  const read = rows.find(one => one.id === 'tool:read-an-email-sending-domain');
  assert.deepEqual([read.invoke.method, read.invoke.url], ['GET', 'https://api.resend.com/domains/{domain_id}']);
  const check = rows.find(one => one.id === 'tool:check-an-email-sending-domain');
  assert.deepEqual([check.invoke.method, check.invoke.url], ['POST', 'https://api.resend.com/domains/{domain_id}/verify']);
  for (const row of [read, check]) {
    assert.deepEqual(row.invoke.credential_injections, header);
    const id = new RegExp(row.input_schema.properties.domain_id.pattern);
    assert.ok(id.test('4dd369bc-aa82-4ff3-97de-514ae3000ee0') && !id.test('../api-keys') && !id.test('a/b'), row.id);
  }
  for (const row of [add, read, check]) assert.equal(row.result_selector, '$', row.id);
  for (const row of [add, read, check]) assert.equal(new URL(row.invoke.url).hostname, row.invoke.credential_injections[0].hosts[0], row.id);
});

test('the sending-key rows list the keys and remove one by its id with the held key in the header, never sending a key', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const header = [{ secret_name: 'resend-api-key', hosts: ['api.resend.com'], placement: { kind: 'header', name: 'Authorization', prefix: 'Bearer ' } }];
  const list = rows.find(one => one.id === 'tool:list-sending-keys-with-resend');
  assert.deepEqual([list.invoke.kind, list.invoke.method, list.invoke.url], ['http', 'GET', 'https://api.resend.com/api-keys']);
  const remove = rows.find(one => one.id === 'tool:remove-a-sending-key-with-resend');
  assert.deepEqual([remove.invoke.kind, remove.invoke.method, remove.invoke.url], ['http', 'DELETE', 'https://api.resend.com/api-keys/{api_key_id}']);
  assert.deepEqual(remove.input_schema.required, ['api_key_id']);
  const id = new RegExp(remove.input_schema.properties.api_key_id.pattern);
  assert.ok(id.test('0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0') && !id.test('../domains') && !id.test('a/b'));
  for (const row of [list, remove]) {
    assert.deepEqual(row.invoke.credential_injections, header, row.id);
    assert.equal(new URL(row.invoke.url).hostname, row.invoke.credential_injections[0].hosts[0], row.id);
    assert.equal(row.invoke.body_template, undefined, row.id);
    assert.equal(row.result_selector, '$', row.id);
  }
});
