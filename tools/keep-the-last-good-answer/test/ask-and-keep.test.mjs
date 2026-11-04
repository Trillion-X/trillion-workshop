// tools/keep-the-last-good-answer: the row runs as the container runs it, against the fake records door with exactly the
// row's rights and a web address on this computer's loopback (the engine's own rule keeping a real run to public sites is
// not under test here), and the function is run with its collaborators handed in for the failures a real address rarely gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { askAndKeep, KIND, retryAfterSeconds } from '../read-data/ask-and-keep.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const row = rowOf(rows, 'tool:ask-a-web-address-or-give-the-last-answer');

// A made-up source whose next answer the test chooses.
async function source(t) {
  let next = { status: 200, type: 'application/json', body: JSON.stringify({ price: 3 }) };
  const server = createServer((_request, reply) => { reply.writeHead(next.status, { 'content-type': next.type, ...next.headers }); reply.end(next.body); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  return { address: `http://127.0.0.1:${server.address().port}/prices`, answer: (reply) => { next = reply; } };
}

test('the row asks the public web, may only read and write its own kept answers, and keeps one write at a time', () => {
  assert.equal(row.invoke.internet, true);
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'kept-answer', operations: ['records:read', 'records:write'] }]);
  assert.equal(row.invoke.records.most_writes, 1);
  assert.equal(KIND, row.invoke.records.rights[0].kind);
});

test('a live answer is returned and kept; the next ask, with the address down, gives the kept answer and when it was kept', async t => {
  const web = await source(t);
  const first = await answerOf(row, { address: web.address, key: 'daily-prices' });
  assert.equal(first.status, 0, first.error);
  assert.equal(first.result.origin, 'from-the-source');
  assert.deepEqual(first.result.answer, { price: 3 });
  assert.equal(first.kept.length, 1);
  assert.equal(first.kept[0].id, 'kept-answer:daily-prices');
  assert.deepEqual(first.kept[0].value.answer, { price: 3 });
  assert.equal(first.kept[0].value.address, web.address);

  web.answer({ status: 503, type: 'text/plain', body: 'down' });
  const second = await answerOf(row, { address: web.address, key: 'daily-prices' }, { records: first.kept });
  assert.equal(second.result.origin, 'from-what-was-kept');
  assert.deepEqual(second.result.answer, { price: 3 });
  assert.equal(second.result.kept_at, first.kept[0].value.kept_at);
  assert.match(second.result.source_failure, /answered 503/);
  assert.match(second.result.said, /last answer it gave, kept /);
  assert.deepEqual(second.kept, first.kept, 'a failed ask changes nothing that was kept');
});

test('an address that answers with nothing never replaces a good kept answer, and with nothing kept there is nothing to give', async t => {
  const web = await source(t);
  const first = await answerOf(row, { address: web.address, key: 'k' });
  web.answer({ status: 200, type: 'application/json', body: '  ' });
  const empty = await answerOf(row, { address: web.address, key: 'k' }, { records: first.kept });
  assert.equal(empty.result.origin, 'from-what-was-kept');
  assert.deepEqual(empty.result.answer, { price: 3 });
  const nothing = await answerOf(row, { address: web.address, key: 'never-kept' });
  assert.equal(nothing.result.origin, 'nothing-to-give');
  assert.equal(nothing.result.answer, null);
  assert.equal(nothing.kept.length, 0);
});

test('text that is not JSON is an answer too, and zero, false and the empty list are answers', async () => {
  const kept = [];
  const door = { read: async () => null, write: async items => { kept.push(...items); } };
  const reply = (type, body) => async () => new Response(body, { headers: { 'content-type': type } });
  assert.equal((await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { door, fetch: reply('text/plain', 'plain words') })).answer, 'plain words');
  assert.equal((await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { door, fetch: reply('application/json', '0') })).origin, 'from-the-source');
  assert.deepEqual((await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { door, fetch: reply('application/json', '[]') })).answer, []);
  assert.equal(kept.length, 3);
});

test('a failure to keep is returned and costs the caller nothing; a failure to read what was kept is the same as nothing kept', async () => {
  const door = { read: async () => { throw new Error('the records cannot be reached'); }, write: async () => { throw new Error('the write was refused'); } };
  const ok = async () => new Response('{"a":1}', { headers: { 'content-type': 'application/json' } });
  const live = await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { door, fetch: ok });
  assert.equal(live.origin, 'from-the-source');
  assert.deepEqual(live.answer, { a: 1 });
  assert.match(live.keep_failure, /write was refused/);
  assert.match(live.said, /could not be kept/);
  const down = await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { door, fetch: async () => { throw new Error('no route'); } });
  assert.equal(down.origin, 'nothing-to-give');
  assert.match(down.source_failure, /no route/);
  assert.match(down.kept_failure, /cannot be reached/);
});

test('an answer too large to keep is a failed ask, and a refused request says what to give', async () => {
  const door = { read: async () => null, write: async () => {} };
  const big = async () => new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'text/plain' } });
  assert.match((await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { door, fetch: big })).source_failure, /larger than the 262144 bytes/);
  await assert.rejects(askAndKeep({ address: 'ftp://example.test/a', key: 'a' }, { door }), /starts with http/);
  await assert.rejects(askAndKeep({ address: 'not an address', key: 'a' }, { door }), /starts with http/);
  await assert.rejects(askAndKeep({ address: 'https://example.test/a', key: 'Bad Key' }, { door }), /Give key/);
  await assert.rejects(askAndKeep({ address: 'https://example.test/a', key: 'a', wait_seconds: 0 }, { door }), /wait_seconds/);
});

test('the keep is one write of one record with a key that names the answer it keeps', async () => {
  const fake = await startFakeDoor({ rights: row.invoke.records.rights, mostWrites: 1 });
  try {
    const door = await openRecordsDoor({ descriptor: fake.descriptor });
    const ok = async () => new Response('"fine"', { headers: { 'content-type': 'application/json' } });
    await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { door, fetch: ok, now: () => new Date('2026-01-01T00:00:00Z') });
    assert.equal(fake.calls.find(call => call.method === 'records:write').key, 'kept-answer:keep:a:2026-01-01T00:00:00.000Z');
    assert.deepEqual([...fake.kept.values()].map(record => record.value.answer), ['fine']);
  } finally { await fake.close(); }
});

test('Retry-After is read as seconds or a date, held to a day, and nothing when it is missing or unreadable', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  assert.equal(retryAfterSeconds('120', now), 120);
  assert.equal(retryAfterSeconds(' 0 ', now), 0);
  assert.equal(retryAfterSeconds('Sun, 01 Nov 2026 12:01:30 GMT', now), 90);
  assert.equal(retryAfterSeconds('Sun, 01 Nov 2026 11:00:00 GMT', now), 0, 'a date already past means ask now');
  assert.equal(retryAfterSeconds('999999999', now), 86400);
  for (const unreadable of [undefined, null, '', '-5', '1.5', 'soon', '2026-11-01T12:00:30Z']) assert.equal(retryAfterSeconds(unreadable, now), null, String(unreadable));
});

test('a source that says "not now" with Retry-After has the wait returned and said; other failures carry none', async () => {
  const door = { read: async () => ({ answer: { price: 3 }, kept_at: '2026-11-01T11:00:00.000Z' }), write: async () => {} };
  const reply = (status, headers) => async () => new Response('busy', { status, headers });
  const busy = await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { door, fetch: reply(429, { 'retry-after': '30' }) });
  assert.equal(busy.origin, 'from-what-was-kept');
  assert.deepEqual(busy.answer, { price: 3 });
  assert.equal(busy.retry_after_seconds, 30);
  assert.match(busy.said, /asked not to be asked again for 30 seconds/);
  const down = await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { door, fetch: reply(503, { 'retry-after': 'Sun, 01 Nov 2026 12:00:01 GMT' }), now: () => new Date('2026-11-01T12:00:00Z') });
  assert.equal(down.retry_after_seconds, 1);
  assert.match(down.said, /for 1 second\./);
  const plain = await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { door, fetch: reply(500, { 'retry-after': '30' }) });
  assert.equal(plain.retry_after_seconds, null, 'only 429 and 503 carry a wait');
  assert.doesNotMatch(plain.said, /asked not to be asked/);
  const noHeader = await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { door, fetch: reply(429, {}) });
  assert.equal(noHeader.retry_after_seconds, null);
});

test('the row carries the wait through the container run', async t => {
  const web = await source(t);
  web.answer({ status: 429, type: 'text/plain', body: 'slow down', headers: { 'retry-after': '45' } });
  const run = await answerOf(row, { address: web.address, key: 'busy' });
  assert.equal(run.status, 0, run.error);
  assert.equal(run.result.origin, 'nothing-to-give');
  assert.equal(run.result.retry_after_seconds, 45);
});
