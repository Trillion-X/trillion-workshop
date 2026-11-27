import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listDomains } from '../do-work/list-email-sending-domains.mjs';

const row = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records[0].payload;
const canary = 'held-key-canary-0123456789';
const answering = (status, body) => async (address, request) => {
  assert.equal(address, 'https://api.resend.com/domains');
  assert.equal(request.headers.Authorization, `Bearer ${canary}`);
  return { status, ok: status >= 200 && status < 300, json: async () => body };
};

test('the row hands the held key on a private pipe and runs on the person\'s computer', () => {
  assert.equal(row.id, 'tool:list-email-sending-domains');
  assert.deepEqual(row.invoke.key, [{ secret_name_from_input: 'key_name', fd: 3 }]);
  assert.ok(Array.isArray(row.invoke.may_reach));
  assert.deepEqual(row.placements, ['placement:your-computer']);
});

test('every Resend row takes the vault name of its key from the input, never a fixed name', () => {
  const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  for (const each of rows) {
    assert.ok(each.input_schema.required.includes('key_name'), `${each.id} requires key_name`);
    assert.ok(!JSON.stringify(each).includes('resend-api-key'), `${each.id} names no fixed key`);
  }
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

// The existing credential contract is independent of the new host metadata. Give its unchanged
// assertions a copy omitting only may_reach; raw rows are checked separately and never modified.
const withoutHostMetadata = ({ invoke: { may_reach, ...invoke }, ...row }) => ({ ...row, invoke });
const assertResendHosts = row => {
  assert.deepEqual(row.invoke.may_reach, ['api.resend.com'], row.id);
  assert.equal(new URL(row.invoke.url).hostname, row.invoke.may_reach[0], row.id);
};

function assertSendingKeyContract(maker) {
  assert.equal(maker.invoke.kind, 'http');
  assert.equal(maker.invoke.url, 'https://api.resend.com/api-keys');
  assert.deepEqual(maker.invoke.body_template.permission, { const: 'sending_access' });
  assert.deepEqual(maker.invoke.credential_injections, [
    { secret_name_from_input: 'key_name', placement: { kind: 'header', name: 'Authorization', prefix: 'Bearer ' } },
  ]);
  assert.deepEqual(maker.invoke.reply_holds_values, [{ from: 'token', secret_name_from_input: 'keep_as' }]);
  assert.deepEqual(maker.input_schema.required, ['key_name', 'name', 'keep_as']);
  assert.ok(new RegExp(maker.input_schema.properties.keep_as.pattern).test('resend-sign-in-proof-key'));
  assert.ok(!new RegExp(maker.input_schema.properties.keep_as.pattern).test('Resend API Key'));
}

function assertDomainRowsContract(add, read, check) {
  const header = [{ secret_name_from_input: 'key_name', placement: { kind: 'header', name: 'Authorization', prefix: 'Bearer ' } }];
  assert.deepEqual([add.invoke.kind, add.invoke.method, add.invoke.url], ['http', 'POST', 'https://api.resend.com/domains']);
  assert.deepEqual(add.invoke.credential_injections, header);
  assert.deepEqual(add.input_schema.required, ['key_name', 'name']);
  assert.deepEqual([read.invoke.method, read.invoke.url], ['GET', 'https://api.resend.com/domains/{domain_id}']);
  assert.deepEqual([check.invoke.method, check.invoke.url], ['POST', 'https://api.resend.com/domains/{domain_id}/verify']);
  for (const row of [read, check]) {
    assert.deepEqual(row.invoke.credential_injections, header);
    const id = new RegExp(row.input_schema.properties.domain_id.pattern);
    assert.ok(id.test('4dd369bc-aa82-4ff3-97de-514ae3000ee0') && !id.test('../api-keys') && !id.test('a/b'), row.id);
  }
  for (const row of [add, read, check]) assert.equal(row.result_selector, '$', row.id);
}

function assertKeyRowsContract(list, remove) {
  const header = [{ secret_name_from_input: 'key_name', placement: { kind: 'header', name: 'Authorization', prefix: 'Bearer ' } }];
  assert.deepEqual([list.invoke.kind, list.invoke.method, list.invoke.url], ['http', 'GET', 'https://api.resend.com/api-keys']);
  assert.deepEqual([remove.invoke.kind, remove.invoke.method, remove.invoke.url], ['http', 'DELETE', 'https://api.resend.com/api-keys/{api_key_id}']);
  assert.deepEqual(remove.input_schema.required, ['key_name', 'api_key_id']);
  const id = new RegExp(remove.input_schema.properties.api_key_id.pattern);
  assert.ok(id.test('0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0') && !id.test('../domains') && !id.test('a/b'));
  for (const row of [list, remove]) {
    assert.deepEqual(row.invoke.credential_injections, header, row.id);
    assert.equal(row.invoke.body_template, undefined, row.id);
    assert.equal(row.result_selector, '$', row.id);
  }
}

test('the sending-key row asks for a sending-only key and keeps the reply\'s token in the vault, never in the answer', () => {
  const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const maker = rows.find(one => one.id === 'tool:make-a-sending-key');
  assertSendingKeyContract(withoutHostMetadata(maker));
  assertResendHosts(maker);
});

test('the domain rows add, read and check a domain with the held key in the header, and change no DNS', () => {
  const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const add = rows.find(one => one.id === 'tool:add-an-email-sending-domain');
  const read = rows.find(one => one.id === 'tool:read-an-email-sending-domain');
  const check = rows.find(one => one.id === 'tool:check-an-email-sending-domain');
  assertDomainRowsContract(...[add, read, check].map(withoutHostMetadata));
  for (const row of [add, read, check]) assertResendHosts(row);
});

test('the sending-key rows list the keys and remove one by its id with the held key in the header, never sending a key', () => {
  const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const list = rows.find(one => one.id === 'tool:list-sending-keys');
  const remove = rows.find(one => one.id === 'tool:remove-a-sending-key');
  assertKeyRowsContract(...[list, remove].map(withoutHostMetadata));
  for (const row of [list, remove]) assertResendHosts(row);
});

test('host and non-host credential constraints reject independent changes without modifying the rows', () => {
  const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const find = id => rows.find(row => row.id === id);
  const maker = find('tool:make-a-sending-key');
  const add = find('tool:add-an-email-sending-domain'), read = find('tool:read-an-email-sending-domain'), check = find('tool:check-an-email-sending-domain');
  const list = find('tool:list-sending-keys'), remove = find('tool:remove-a-sending-key');
  const before = structuredClone(rows);
  for (const row of [maker, add, read, check, list, remove]) {
    const wrongHost = structuredClone(row);
    wrongHost.invoke.may_reach = ['other.example'];
    assert.throws(() => assertResendHosts(wrongHost), assert.AssertionError);
  }
  const wrongPrefix = row => {
    const changed = withoutHostMetadata(structuredClone(row));
    changed.invoke.credential_injections[0].placement.prefix = 'Basic ';
    return changed;
  };
  assert.throws(() => assertSendingKeyContract(wrongPrefix(maker)), assert.AssertionError);
  assert.throws(() => assertDomainRowsContract(wrongPrefix(add), withoutHostMetadata(read), withoutHostMetadata(check)), assert.AssertionError);
  assert.throws(() => assertKeyRowsContract(wrongPrefix(list), withoutHostMetadata(remove)), assert.AssertionError);
  assert.deepEqual(rows, before);
});
