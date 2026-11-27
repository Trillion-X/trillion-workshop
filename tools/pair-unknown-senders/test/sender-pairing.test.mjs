// Unknown-sender pairing (read-data/sender-pairing.mjs, moved from Trillion-X/trillion test/sender-pairing.test.mjs): an event rule naming paired_senders holds an unknown sender's event and gives
// them a short code; approving the code pairs them; the cap, expiry, repeat and revoke rules hold. The first test is trillion's own, over facts in a Map;
// the others hand the facts in as values and keep what each answer says to keep, running the shipped rows as the engine runs them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeSenderPairing } from '../read-data/sender-pairing.mjs';
import { factsFrom } from '../read-data/pairing-tools.mjs';
import { answerOf } from '../../../test-helpers/run-a-row.mjs';

const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const rowOf = id => rows.find(row => row.id === id);
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

const kept = facts => ({
  read: async name => structuredClone(facts.get(name) ?? null),
  list: async prefix => [...facts].filter(([name]) => name.startsWith(prefix)).map(([, value]) => structuredClone(value)),
  write: async (name, value) => { facts.set(name, structuredClone(value)); },
});

async function theCapAndExpiry(facts) {
  const clock = { at: Date.parse('2026-10-01T10:00:00Z') };
  const pairing = makeSenderPairing({ facts, now: () => new Date(clock.at) });
  const first = await pairing.request({ source_id: 'events:a', sender: 'ana' });
  assert.match(first.code, CODE);
  assert.equal(first.expires_at, '2026-10-01T11:00:00.000Z');
  assert.equal((await pairing.request({ source_id: 'events:a', sender: 'ana' })).code, first.code, 'asking again makes no second code');
  await pairing.request({ source_id: 'events:a', sender: 'bo' });
  await pairing.request({ source_id: 'events:a', sender: 'cy' });
  const full = await pairing.request({ source_id: 'events:a', sender: 'di' });
  assert.equal(full.full, true);
  assert.match(full.said, /3 pairing codes are already waiting/);
  assert.ok((await pairing.request({ source_id: 'events:b', sender: 'di' })).code, 'another source has its own cap');
  assert.equal((await pairing.approve({ code: first.code.toLowerCase() })).sender, 'ana');
  await assert.rejects(pairing.approve({ code: first.code }), /No waiting pairing code/);
  assert.equal((await pairing.request({ source_id: 'events:a', sender: 'ana' })).paired, true);
  clock.at += 61 * 60_000;
  assert.equal((await pairing.list({ source_id: 'events:a' })).waiting.length, 0, 'the rest expired');
  await pairing.revoke({ source_id: 'events:a', sender: 'ana' });
  assert.equal(await pairing.isPaired({ source_id: 'events:a', sender: 'ana' }), false);
}

test('a code is 8 unambiguous characters, repeats for the same sender, is capped per source, expires, and works once', () => theCapAndExpiry(kept(new Map())));

test('the same rules hold over given facts, and every write is gathered to keep', () => theCapAndExpiry(factsFrom({})));

test('a fact is one value per name: a name written again is replaced, a prefix lists only its own names, and a prefix with % or _ is plain text', async () => {
  const facts = factsFrom({});
  await facts.write('pairing-waiting:events:a:AAAAAAAA', { source_id: 'events:a', sender: 'ana', code: 'AAAAAAAA' });
  await facts.write('pairing-waiting:events:a:AAAAAAAA', { source_id: 'events:a', sender: 'ana', code: 'AAAAAAAA', removed: true });
  await facts.write('pairing-waiting:events_a:BBBBBBBB', { source_id: 'events_a', sender: 'bo', code: 'BBBBBBBB' });
  assert.equal((await facts.read('pairing-waiting:events:a:AAAAAAAA')).removed, true);
  assert.equal(await facts.read('pairing-waiting:nothing'), null);
  assert.deepEqual((await facts.list('pairing-waiting:events_a:')).map(value => value.sender), ['bo']);
  assert.deepEqual((await facts.list('pairing-waiting:events%')), []);
  assert.deepEqual([...facts.kept.keys()], ['pairing-waiting:events:a:AAAAAAAA', 'pairing-waiting:events_a:BBBBBBBB']);
  assert.throws(() => factsFrom([]), /facts must be an object/);
});

// The person's kept facts across calls: each call is given them and they take what its answer says to keep.
const held = {};
const run = async (id, input) => {
  const answer = await answerOf(rowOf(id), { ...input, facts: structuredClone(held) });
  for (const { name, value } of answer.result?.keep ?? []) held[name] = value;
  return answer;
};

test('the rows keep nothing themselves: request, repeat, approve, list, revoke, with the facts handed in and kept by the caller', async () => {
  const first = await run('tool:pair-an-unknown-sender', { source_id: 'events:a', sender: 'sender-one' });
  assert.equal(first.status, 0, first.error);
  assert.match(first.result.code, CODE);
  assert.match(first.result.said, /sender-one is not paired yet/);
  assert.deepEqual(Object.keys(held), [`pairing-waiting:events:a:${first.result.code}`]);
  const again = await run('tool:pair-an-unknown-sender', { source_id: 'events:a', sender: 'sender-one' });
  assert.equal(again.result.code, first.result.code, 'asking again makes no second code');
  assert.deepEqual(again.result.keep, [], 'and keeps nothing new');
  const approved = await run('tool:approve-a-pairing-code', { code: first.result.code.toLowerCase() });
  assert.equal(approved.result.sender, 'sender-one');
  const listed = await run('tool:list-paired-senders', { source_id: 'events:a', sender: 'sender-one' });
  assert.deepEqual(listed.result.waiting, []);
  assert.deepEqual(listed.result.paired.map(row => row.sender), ['sender-one']);
  assert.equal(listed.result.is_paired, true);
  const twice = await run('tool:approve-a-pairing-code', { code: first.result.code });
  assert.match(twice.error, /No waiting pairing code/);
  const revoked = await run('tool:unpair-a-sender', { source_id: 'events:a', sender: 'sender-one' });
  assert.match(revoked.result.said, /no longer paired/);
  const after = await run('tool:list-paired-senders', { source_id: 'events:a', sender: 'sender-one' });
  assert.equal(after.result.is_paired, false);
});

test('each row reaches nothing: no database door, no held value, no internet, no records right, and only the files it imports', () => {
  assert.equal(rows.filter(row => row.kind === 'ai-tool-descriptor').length, 4);
  for (const row of rows) {
    assert.equal(row.invoke.may_reach, undefined, row.id);
    assert.equal(row.invoke.local_doors, undefined, row.id);
    assert.equal(row.invoke.key, undefined, row.id);
    assert.equal(row.invoke.records, undefined, row.id);
    assert.equal(row.invoke.packages, undefined, row.id);
  }
});
