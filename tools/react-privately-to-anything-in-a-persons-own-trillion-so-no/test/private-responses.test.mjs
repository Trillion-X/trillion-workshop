import test from 'node:test';
import assert from 'node:assert/strict';
import { privateResponses } from '../src/private-responses.mjs';
import { handleWorkResponses } from '../../shared-code/src/work-responses.mjs';

function records() {
  const held = new Map();
  const writes = [];
  return { held, writes, read: id => held.get(id), write: (changes, context) => {
    for (const change of changes) { held.set(change.id, change.value); writes.push({ change, context }); }
  } };
}

test('private reactions use the same anchor for reordered part fields, toggle exactly once, and stay in one person store', () => {
  const one = records();
  const another = records();
  const mine = privateResponses(one);
  const anchor = { record: 'file:private', part: { kind: 'text-range', start: 2, quote: 'word' } };
  assert.deepEqual(mine.read(anchor).anchor, anchor);
  assert.equal(mine.react({ ...anchor, symbol: '❤️', on: true }).reactions[0].yours, true);
  assert.equal(one.writes.length, 1);
  mine.react({ record: anchor.record, part: { quote: 'word', start: 2, kind: 'text-range' }, symbol: '❤️', on: true });
  assert.equal(one.writes.length, 1, 'an idempotent give writes nothing');
  assert.equal(privateResponses(another).read(anchor).reactions, undefined, 'another person cannot see the reaction');
  assert.equal(mine.react({ ...anchor, symbol: '❤️' }).reactions, undefined, 'a second press removes it');
  assert.equal(one.writes.length, 2);
  mine.react({ ...anchor, symbol: '❤️', on: false });
  assert.equal(one.writes.length, 2, 'an idempotent removal writes nothing');
  assert.throws(() => mine.react({ ...anchor, symbol: 'vote' }), /Votes belong/);
  assert.throws(() => mine.react({ record: '', symbol: '❤️' }), /anchor names/);
});

test('signed-in reaction bridge forwards only same-origin writes to the person store', async () => {
  const sent = [];
  const person = { fetch: async request => { sent.push({ method: request.method, url: request.url, body: request.method === 'POST' ? await request.json() : null }); return Response.json({ reactions: [] }); } };
  const origin = 'https://app.gettrillion.ai';
  const denied = await handleWorkResponses(new Request(`${origin}/work/api/responses/react`, { method: 'POST', headers: { origin: 'https://elsewhere.test' }, body: '{}' }), { person, origin });
  assert.equal(denied.status, 403);
  assert.equal(sent.length, 0);
  const input = { record: 'file:private', part: { kind: 'text-range', quote: 'word' }, symbol: '❤️' };
  const accepted = await handleWorkResponses(new Request(`${origin}/work/api/responses/react`, { method: 'POST', headers: { origin }, body: JSON.stringify(input) }), { person, origin });
  assert.equal(accepted.status, 200);
  assert.deepEqual(sent[0], { method: 'POST', url: 'https://person/responses/react', body: input });
  await handleWorkResponses(new Request(`${origin}/work/api/responses?record=file%3Aprivate`), { person, origin });
  assert.equal(sent[1].url, 'https://person/responses?record=file%3Aprivate');
});
