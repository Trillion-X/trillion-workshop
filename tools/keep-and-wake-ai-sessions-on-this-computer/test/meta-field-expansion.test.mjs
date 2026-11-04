import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildInvocation, httpJson } from '../src/workshop.mjs';

const records = JSON.parse(await readFile(new URL('../parts/service-connections/records.json', import.meta.url), 'utf8'));
const payload = suffix => records.things.find(row => row.address.endsWith(suffix)).payload;
const whatsapp = payload('how-to-ask-something-else-to-do-things::whatsapp-business');
const instagram = payload('how-to-ask-something-else-to-do-things::instagram-facebook');

for (const [label, notes, operation, fields] of [
  ['WhatsApp Business accounts', whatsapp, 'list-whatsapp-accounts', 'id,name,owned_whatsapp_business_accounts{id,name}'],
  ['Instagram through Facebook identity', instagram, 'find-my-account', 'id,name,instagram_business_account{id,username,name,media_count,followers_count}'],
]) {
  test(`${label} sends literal Graph fields through the real request renderer`, async () => {
    const request = notes.instrument_requests[operation];
    const invocation = await buildInvocation({ ...notes, ...request }, { input: {}, task: {}, request: true });
    let sends = 0;
    const output = await httpJson({ invocation, send: async request => {
      sends += 1;
      assert.equal(request.method, 'GET');
      assert.equal(new URL(request.url).searchParams.get('fields'), fields);
      assert.equal(request.credential_injections.length, 1);
      return { status_code: 200, body: new TextEncoder().encode(JSON.stringify({ data: [] })) };
    } });
    assert.equal(sends, 1);
    assert.deepEqual(output, { data: [], ...(invocation.reply_cursor_paging ? { paging: { has_next: false, has_previous: false } } : {}) });
  });
}

test('Meta identity and consent selectors retain their exact Graph field expansion', () => {
  const connection = payload('published-record::instagram-facebook');
  assert.equal(new URL(connection.verifyRequest.url).searchParams.get('fields'), 'id,name,instagram_business_account{id,username}');
  assert.equal(new URL(connection.acquire.choose.list.url).searchParams.get('fields'), 'id,name,access_token,instagram_business_account{id,username}');
});

test('dynamic account paths still require the declared input and reject path escape', async () => {
  const invoke = { ...whatsapp, ...whatsapp.instrument_requests['list-phone-numbers'] };
  await assert.rejects(buildInvocation(invoke, { input: {}, task: {}, request: true }), /needs input.waba_id/);
  await assert.rejects(buildInvocation(invoke, { input: { waba_id: '../other' }, task: {}, request: true }), /inside the named resource/);
  const built = await buildInvocation(invoke, { input: { waba_id: '123456' }, task: {}, request: true });
  assert.equal(new URL(built.url).pathname, '/v23.0/123456/phone_numbers');
});
