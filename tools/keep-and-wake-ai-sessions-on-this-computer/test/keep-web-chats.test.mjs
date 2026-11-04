// test/keep-web-chats.test.mjs
//
// harness/keep-web-chats.mjs keeps web chat conversations in Trillion through bring_in_chat. The page step reads only
// through the site row's own addresses (no site named in code), lists newest first and reads oldest first so the
// cursor can move past each kept conversation; bringIn says a refusal as the account said it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bringIn, changedMs, pageStep, settings } from '../harness/keep-web-chats.mjs';
import { start } from '../harness/wake-handlers/keep-web-chats.mjs';

const site = settings.sites[0];

test('the page step lists what changed since the cursor and reads it oldest first', async () => {
  const asked = [];
  const pages = {
    [site.session]: { accessToken: 't' },
    [site.list.replace('{offset}', 0).replace('{limit}', 2)]: { items: [{ id: 'b', update_time: '2026-10-06T10:00:00Z' }, { id: 'a', update_time: '2026-10-05T10:00:00Z' }] },
    [site.list.replace('{offset}', 2).replace('{limit}', 2)]: { items: [{ id: 'old', update_time: '2026-09-01T10:00:00Z' }] },
  };
  globalThis.fetch = async (address, options) => {
    asked.push([address, options?.headers?.Authorization ?? null]);
    const body = pages[address] ?? { conversation_id: address.split('/').pop(), mapping: {} };
    return { json: async () => body, text: async () => JSON.stringify(body) };
  };
  pageStep({ step: 'start', site, since: Date.parse('2026-10-01T00:00:00Z'), since_ids: [], most: 10, limit: 2, most_list_pages: settings.most_list_pages });
  let status;
  for (let i = 0; i < 50 && (status = pageStep({ step: 'status' })).state === 'reading'; i++) await new Promise(done => setTimeout(done, 5));
  assert.equal(status.state, 'read');
  assert.deepEqual(status.order.map(item => item.id), ['a', 'b']);
  assert.ok(asked.slice(1).every(([, auth]) => auth === 'Bearer t'), 'every read carries the page\'s own token');
  const { base64 } = pageStep({ step: 'chunk', id: 'a', from: 0, to: 1e6 });
  assert.equal(JSON.parse(Buffer.from(base64, 'base64').toString('utf8')).conversation_id, 'a');
  assert.equal(pageStep({ step: 'clear' }).state, 'cleared');
  assert.equal(pageStep({ step: 'status' }).state, 'none');
});

test('bringIn hands the conversation to bring_in_chat and says a refusal as it was said', async () => {
  let sent;
  const answered = text => async (address, options) => { sent = { address, options }; return { text: async () => text }; };
  const kept = await bringIn({ origin: 'https://example.test', key: 'k', app: 'ChatGPT', conversation: { id: 'a' }, post: answered(JSON.stringify({ result: { content: [{ text: '{"messages":2,"added":2}' }] } })) });
  assert.deepEqual(kept, { messages: 2, added: 2 });
  assert.equal(sent.address, 'https://example.test/mcp');
  assert.equal(sent.options.headers.authorization, 'Bearer k');
  assert.equal(JSON.parse(sent.options.body).params.name, 'bring_in_chat');
  await assert.rejects(bringIn({ origin: 'o', key: 'k', app: 'ChatGPT', conversation: {}, post: answered(JSON.stringify({ result: { isError: true, content: [{ text: 'On the free plan nothing is kept' }] } })) }), /free plan/);
});

test('times read as ISO or seconds', () => {
  assert.equal(changedMs('2026-10-06T00:00:00Z'), Date.parse('2026-10-06T00:00:00Z'));
  assert.equal(changedMs(1790000000), 1790000000000);
});

test('the helper runs one pass at start and one at a time', async () => {
  let passes = 0;
  let release;
  const timer = start({ origin: 'o', key: 'k', pass: () => { passes += 1; return new Promise(done => { release = () => done([]); }); } });
  clearInterval(timer);
  assert.equal(passes, 1);
  release();
});

// One pass of the page step over a fake list (newest first), run to its end; resolves to its status.
async function listPass(list, args) {
  globalThis.fetch = async address => {
    const url = new URL(address, 'https://chat.example');
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    const body = url.pathname === '/backend-api/conversations' ? { items: list.slice(offset, offset + limit) } : { conversation_id: url.pathname.split('/').pop() };
    return { json: async () => body, text: async () => JSON.stringify(body) };
  };
  pageStep({ step: 'start', site, most_list_pages: settings.most_list_pages, limit: 10, ...args });
  let status;
  for (let i = 0; i < 50 && (status = pageStep({ step: 'status' })).state === 'reading'; i++) await new Promise(done => setTimeout(done, 5));
  pageStep({ step: 'clear' });
  return status;
}

test('a pass keeps the oldest conversations changed since its cursor, so a long list is worked through in order', async () => {
  const base = Date.parse('2026-10-02T00:00:00Z');
  const list = Array.from({ length: 41 }, (_, at) => ({ id: `c${at}`, update_time: new Date(base + at * 3600000).toISOString() })).reverse();
  const status = await listPass(list, { since: base - 1000, since_ids: [], most: 40 });
  assert.equal(status.state, 'read');
  assert.deepEqual(status.order.map(item => item.id), Array.from({ length: 40 }, (_, at) => `c${at}`), 'the 40 oldest, oldest first; the newest waits for the next pass');
  const short = await listPass(list, { since: base - 1000, since_ids: [], most: 40, most_list_pages: 2 });
  assert.equal(short.state, 'failed');
  assert.equal(short.error, 'the list has more than 2 pages changed since the last kept conversation');
  assert.equal(short.order, null, 'a partial newest window is not kept');
});

test('a conversation changed at the same time as the cursor, and not yet kept, is still read', async () => {
  const at = Date.parse('2026-10-05T12:00:00Z');
  const same = new Date(at).toISOString();
  const list = [{ id: 'kept', update_time: same }, { id: 'same', update_time: same }, { id: 'older', update_time: new Date(at - 3600000).toISOString() }];
  const status = await listPass(list, { since: at, since_ids: ['kept'], most: 10 });
  assert.deepEqual(status.order.map(item => item.id), ['same']);
});
