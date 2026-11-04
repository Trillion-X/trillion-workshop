// Unknown-sender pairing (read-data/sender-pairing.mjs, moved from Trillion-X/trillion test/sender-pairing.test.mjs): an event rule naming paired_senders holds an unknown sender's event and gives
// them a short code; approving the code pairs them; the cap, expiry, repeat and revoke rules hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSenderPairing } from '../read-data/sender-pairing.mjs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const kept = facts => ({
  read: async name => structuredClone(facts.get(name) ?? null),
  list: async prefix => [...facts].filter(([name]) => name.startsWith(prefix)).map(([, value]) => structuredClone(value)),
  write: async (name, value) => { facts.set(name, structuredClone(value)); },
});

test('a code is 8 unambiguous characters, repeats for the same sender, is capped per source, expires, and works once', async () => {
  const clock = { at: Date.parse('2026-10-01T10:00:00Z') };
  const pairing = makeSenderPairing({ facts: kept(new Map()), now: () => new Date(clock.at) });
  const first = await pairing.request({ source_id: 'events:a', sender: 'ana' });
  assert.match(first.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
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
});

// The rows: the same pairing through the person's records door, each fact one `sender-pairing` record.

test('the rows keep the pairing as the person\'s own sender-pairing records: request, repeat, approve, list, revoke', async () => {
  const first = await answerOf(rowOf(rows, 'tool:pair-an-unknown-sender'), { source_id: 'events:a', sender: 'sender-one' });
  assert.equal(first.status, 0);
  assert.match(first.result.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  assert.match(first.result.said, /sender-one is not paired yet/);
  const waiting = first.kept;
  assert.deepEqual(waiting.map(row => [row.type, row.id]), [['sender-pairing', `pairing-waiting:events:a:${first.result.code}`]]);
  const again = await answerOf(rowOf(rows, 'tool:pair-an-unknown-sender'), { source_id: 'events:a', sender: 'sender-one' }, { records: waiting });
  assert.equal(again.result.code, first.result.code, 'asking again makes no second code');
  assert.equal(again.kept.length, 1);
  const approved = await answerOf(rowOf(rows, 'tool:approve-a-pairing-code'), { code: first.result.code.toLowerCase() }, { records: waiting });
  assert.equal(approved.result.sender, 'sender-one');
  const listed = await answerOf(rowOf(rows, 'tool:list-paired-senders'), { source_id: 'events:a', sender: 'sender-one' }, { records: approved.kept });
  assert.deepEqual(listed.result.waiting, []);
  assert.deepEqual(listed.result.paired.map(row => row.sender), ['sender-one']);
  assert.equal(listed.result.is_paired, true);
  const twice = await answerOf(rowOf(rows, 'tool:approve-a-pairing-code'), { code: first.result.code }, { records: approved.kept });
  assert.match(twice.error, /No waiting pairing code/);
  const revoked = await answerOf(rowOf(rows, 'tool:unpair-a-sender'), { source_id: 'events:a', sender: 'sender-one' }, { records: approved.kept });
  assert.match(revoked.result.said, /no longer paired/);
  const after = await answerOf(rowOf(rows, 'tool:list-paired-senders'), { source_id: 'events:a', sender: 'sender-one' }, { records: revoked.kept });
  assert.equal(after.result.is_paired, false);
});
