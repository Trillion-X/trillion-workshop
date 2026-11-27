// tools/keep-the-last-good-answer: the row runs as the container runs it, with no records door (it declares none) and a web
// address on this computer's loopback (the engine's own rule keeping a real run to public sites is not under test here), and
// the function is run with its web handed in for the failures a real address rarely gives. The tool keeps nothing: the
// answer holds the record to keep (`to_keep`) and the last answer comes back in as `last_answer`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { askAndKeep, KIND, retryAfterSeconds } from '../read-data/ask-and-keep.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

const row = rowOf(rows, 'tool:ask-a-web-address-or-give-the-last-answer');

// A made-up source whose next answer the test chooses.
async function source(t) {
  let next = { status: 200, type: 'application/json', body: JSON.stringify({ price: 3 }) };
  const server = createServer((_request, reply) => { reply.writeHead(next.status, { 'content-type': next.type, ...next.headers }); reply.end(next.body); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  return { address: `http://127.0.0.1:${server.address().port}/prices`, answer: (reply) => { next = reply; } };
}

const reply = (type, body, init = {}) => async () => new Response(body, { headers: { 'content-type': type }, ...init });

test('the row asks the public web and is handed no records door: it keeps nothing', () => {
  assert.ok(Array.isArray(row.invoke.may_reach));
  assert.equal(row.invoke.records, undefined);
  assert.equal(KIND, 'kept-answer');
});

test('a live answer is returned with the record that keeps it; the next ask, with the address down, gives the answer handed back and when it was kept', async t => {
  const web = await source(t);
  const first = await answerOf(row, { address: web.address, key: 'daily-prices' });
  assert.equal(first.status, 0, first.error);
  assert.equal(first.result.origin, 'from-the-source');
  assert.deepEqual(first.result.answer, { price: 3 });
  assert.equal(first.kept.length, 0, 'nothing is written to the records');
  assert.equal(first.result.to_keep.id, 'kept-answer:daily-prices');
  assert.equal(first.result.to_keep.type, 'kept-answer');
  assert.deepEqual(first.result.to_keep.value, { address: web.address, answer: { price: 3 }, kept_at: first.result.kept_at });

  web.answer({ status: 503, type: 'text/plain', body: 'down' });
  const second = await answerOf(row, { address: web.address, key: 'daily-prices', last_answer: first.result.to_keep });
  assert.equal(second.result.origin, 'from-what-was-kept');
  assert.deepEqual(second.result.answer, { price: 3 });
  assert.equal(second.result.kept_at, first.result.kept_at);
  assert.equal(second.result.to_keep, null, 'a failed ask has nothing new to keep');
  assert.match(second.result.source_failure, /answered 503/);
  assert.match(second.result.said, /last answer it gave, kept /);
});

test('an address that answers with nothing never replaces the answer handed in, and with none handed in there is nothing to give', async t => {
  const web = await source(t);
  const first = await answerOf(row, { address: web.address, key: 'k' });
  web.answer({ status: 200, type: 'application/json', body: '  ' });
  const empty = await answerOf(row, { address: web.address, key: 'k', last_answer: first.result.to_keep.value });
  assert.equal(empty.result.origin, 'from-what-was-kept');
  assert.deepEqual(empty.result.answer, { price: 3 });
  assert.equal(empty.result.to_keep, null);
  const nothing = await answerOf(row, { address: web.address, key: 'never-kept' });
  assert.equal(nothing.result.origin, 'nothing-to-give');
  assert.equal(nothing.result.answer, null);
  assert.equal(nothing.result.to_keep, null);
});

test('text that is not JSON is an answer too, and zero, false and the empty list are answers', async () => {
  const ask = { address: 'https://example.test/a', key: 'a' };
  const text = await askAndKeep(ask, { fetch: reply('text/plain', 'plain words') });
  assert.equal(text.answer, 'plain words');
  assert.equal(text.to_keep.value.answer, 'plain words');
  assert.equal((await askAndKeep(ask, { fetch: reply('application/json', '0') })).origin, 'from-the-source');
  assert.deepEqual((await askAndKeep(ask, { fetch: reply('application/json', '[]') })).answer, []);
});

test('the time of a live answer is when it was asked, and a last_answer given as the bare value or as the record both read', async () => {
  const now = () => new Date('2026-01-01T00:00:00Z');
  const live = await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { fetch: reply('application/json', '"fine"'), now });
  assert.equal(live.kept_at, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(live.to_keep, { id: 'kept-answer:a', type: 'kept-answer', value: { address: 'https://example.test/a', answer: 'fine', kept_at: '2026-01-01T00:00:00.000Z' } });
  const down = async () => { throw new Error('no route'); };
  const value = { address: 'https://example.test/a', answer: 'old', kept_at: '2025-12-31T00:00:00.000Z' };
  for (const last_answer of [value, { id: 'kept-answer:a', type: 'kept-answer', value }]) {
    const kept = await askAndKeep({ address: 'https://example.test/a', key: 'a', last_answer }, { fetch: down });
    assert.equal(kept.origin, 'from-what-was-kept');
    assert.equal(kept.answer, 'old');
    assert.equal(kept.kept_at, '2025-12-31T00:00:00.000Z');
  }
  const down2 = await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { fetch: down });
  assert.equal(down2.origin, 'nothing-to-give');
  assert.match(down2.source_failure, /no route/);
  await assert.rejects(askAndKeep({ address: 'https://example.test/a', key: 'a', last_answer: 'old' }, { fetch: down }), /last_answer is the record/);
});

test('an answer too large to keep is a failed ask, and a refused request says what to give', async () => {
  const big = reply('text/plain', 'x'.repeat(256 * 1024 + 1));
  assert.match((await askAndKeep({ address: 'https://example.test/a', key: 'a' }, { fetch: big })).source_failure, /larger than the 262144 bytes/);
  await assert.rejects(askAndKeep({ address: 'ftp://example.test/a', key: 'a' }), /starts with http/);
  await assert.rejects(askAndKeep({ address: 'not an address', key: 'a' }), /starts with http/);
  await assert.rejects(askAndKeep({ address: 'https://example.test/a', key: 'Bad Key' }), /Give key/);
  await assert.rejects(askAndKeep({ address: 'https://example.test/a', key: 'a', wait_seconds: 0 }), /wait_seconds/);
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
  const last_answer = { answer: { price: 3 }, kept_at: '2026-11-01T11:00:00.000Z' };
  const reply = (status, headers) => async () => new Response('busy', { status, headers });
  const busy = await askAndKeep({ address: 'https://example.test/a', key: 'a', last_answer }, { fetch: reply(429, { 'retry-after': '30' }) });
  assert.equal(busy.origin, 'from-what-was-kept');
  assert.deepEqual(busy.answer, { price: 3 });
  assert.equal(busy.retry_after_seconds, 30);
  assert.match(busy.said, /asked not to be asked again for 30 seconds/);
  const down = await askAndKeep({ address: 'https://example.test/a', key: 'a', last_answer }, { fetch: reply(503, { 'retry-after': 'Sun, 01 Nov 2026 12:00:01 GMT' }), now: () => new Date('2026-11-01T12:00:00Z') });
  assert.equal(down.retry_after_seconds, 1);
  assert.match(down.said, /for 1 second\./);
  const plain = await askAndKeep({ address: 'https://example.test/a', key: 'a', last_answer }, { fetch: reply(500, { 'retry-after': '30' }) });
  assert.equal(plain.retry_after_seconds, null, 'only 429 and 503 carry a wait');
  assert.doesNotMatch(plain.said, /asked not to be asked/);
  const noHeader = await askAndKeep({ address: 'https://example.test/a', key: 'a', last_answer }, { fetch: reply(429, {}) });
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
