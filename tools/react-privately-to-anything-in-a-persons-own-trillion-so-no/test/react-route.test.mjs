// The page route POST /work/api/responses/react as a Workshop route tool, against the records door stand-in with
// exactly the row's rights. Old trillion answered it in the person's store (src/person-store.mjs:8446, tag
// old-trillion-before-worker-retire): the reaction given or taken away (200 with the anchor's reactions), a refusal
// 400 { error }, and src/work-responses.mjs answered any other path 404 { error: 'Not found.' }. Made-up rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { answerReactRoute } from '../do-work/react-route.mjs';
import { privateResponses } from '../src/private-responses.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const ROUTE = rowOf(ROWS, 'tool:answer-the-react-privately-route');
const page = (body, method = 'POST', path = '/responses/react') => ({ path, method, query: {}, body, browser: { user_agent: 'Sample browser', origin: 'https://app.example', visitor: 'sample' } });
const anchor = { record: 'note:sample-1', part: { kind: 'text-range', start: 2, quote: 'word' } };

test('a reaction is given, kept in the person\'s private-response record, and answered as the old store answered it', async () => {
  const run = await answerOf(ROUTE, page({ ...anchor, symbol: '❤️', on: true }), { records: [] });
  assert.equal(run.status, 0, run.error);
  assert.equal(run.result.status, 200);
  const kept = run.kept.filter(record => record.type === 'private-response');
  assert.equal(kept.length, 1);
  const held = new Map(kept.map(record => [record.id, record.value]));
  const expected = privateResponses({ read: id => held.get(id), write: () => {} }).read(anchor);
  assert.deepEqual(run.result.body, expected);
  assert.equal(run.result.body.reactions[0].yours, true);
});

test('a second press takes it away; an idempotent give writes nothing', async () => {
  const first = await answerOf(ROUTE, page({ ...anchor, symbol: '❤️', on: true }), { records: [] });
  const again = await answerOf(ROUTE, page({ ...anchor, symbol: '❤️', on: true }), { records: first.kept });
  assert.equal(again.result.status, 200);
  assert.deepEqual(again.kept, first.kept, 'nothing changed');
  const off = await answerOf(ROUTE, page({ ...anchor, symbol: '❤️' }), { records: first.kept });
  assert.equal(off.result.body.reactions, undefined);
  assert.deepEqual(off.kept.find(record => record.type === 'private-response').value.rows, []);
});

test('a vote or a bad anchor answers 400 with the old words; another path or method 404', async () => {
  const vote = await answerOf(ROUTE, page({ ...anchor, symbol: 'vote' }), { records: [] });
  assert.equal(vote.result.status, 400);
  assert.match(vote.result.body.error, /Votes belong/);
  const empty = await answerReactRoute(page({ record: '', symbol: '❤️' }), { door: null });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /anchor names/);
  assert.deepEqual(await answerReactRoute(page({}, 'GET'), { door: null }), { status: 404, body: { error: 'Not found.' } });
  assert.deepEqual(await answerReactRoute(page({}, 'POST', '/responses'), { door: null }), { status: 404, body: { error: 'Not found.' } });
});

test('a reaction another page changed meanwhile is decided again on the record as it is now', async () => {
  let reads = 0;
  const writes = [];
  const id = 'private-response:x';
  const door = {
    readRecord: async (_type, asked) => {
      reads += 1;
      return reads === 1 ? null : { type: 'private-response', value: { anchor: { record: 'note:sample-1' }, rows: [{ symbol: '👍', glyph: '👍', at: '2026-01-01T00:00:00.000Z' }] } };
    },
    write: async records => {
      writes.push(records);
      if (writes.length === 1) throw Object.assign(new Error('changed'), { code: 'original_command_conflict' });
    },
  };
  const reply = await answerReactRoute(page({ record: 'note:sample-1', symbol: '❤️', on: true }), { door });
  assert.equal(reply.status, 200);
  assert.deepEqual(writes[1][0].value.rows.map(row => row.symbol), ['👍', '❤️']);
  assert.ok(writes[1][0].expected, 'the second write stands on the record read again');
  void id;
});
