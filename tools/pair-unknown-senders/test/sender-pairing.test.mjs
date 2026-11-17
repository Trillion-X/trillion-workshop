// Unknown-sender pairing (read-data/sender-pairing.mjs, moved from Trillion-X/trillion test/sender-pairing.test.mjs): an event rule naming paired_senders holds an unknown sender's event and gives
// them a short code; approving the code pairs them; the cap, expiry, repeat and revoke rules hold. The first test is trillion's own, over facts in a Map;
// the others keep the facts in the table sender_pairing of a real PostgreSQL server and run the shipped rows as the engine runs them.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeSenderPairing } from '../read-data/sender-pairing.mjs';
import { factsOver } from '../read-data/pairing-tools.mjs';
import { applySqlFiles, sqlFiles } from '../../workflows/read-data/sql.mjs';
import { runRowIn, startDatabase } from '../../workflows/test-helpers/rows-in-sql.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const rowOf = id => rows.find(row => row.id === id);
const own = new URL('../sql/', import.meta.url);
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

let db;
before(async () => { db = await startDatabase(); });
after(async () => { await db.stop(); });
beforeEach(async () => { await db.reset(); await applySqlFiles(db.sql, sqlFiles(own)); });

test('the same rules hold over the facts kept in the table sender_pairing', () => theCapAndExpiry(factsOver(db.sql)));

test('a fact is one row per name: a name written again is replaced, a prefix lists only its own names, and a prefix with % or _ is plain text', async () => {
  const facts = factsOver(db.sql);
  await facts.write('pairing-waiting:events:a:AAAAAAAA', { source_id: 'events:a', sender: 'ana', code: 'AAAAAAAA' });
  await facts.write('pairing-waiting:events:a:AAAAAAAA', { source_id: 'events:a', sender: 'ana', code: 'AAAAAAAA', removed: true });
  await facts.write('pairing-waiting:events_a:BBBBBBBB', { source_id: 'events_a', sender: 'bo', code: 'BBBBBBBB' });
  assert.equal((await facts.read('pairing-waiting:events:a:AAAAAAAA')).removed, true);
  assert.equal(await facts.read('pairing-waiting:nothing'), null);
  assert.deepEqual((await facts.list('pairing-waiting:events_a:')).map(value => value.sender), ['bo']);
  assert.deepEqual((await facts.list('pairing-waiting:events%')), []);
  assert.deepEqual((await db.sql('select source_id from sender_pairing order by id')).map(row => row.source_id), ['events:a', 'events_a']);
});

const run = (id, input) => runRowIn(rowOf(id), { input, task: { request_key: `${id}-key` } }, { connection: db.connection });

test('the rows keep the pairing in the person\'s own database: request, repeat, approve, list, revoke', async () => {
  const first = await run('tool:pair-an-unknown-sender', { source_id: 'events:a', sender: 'sender-one' });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.last.result.code, CODE);
  assert.match(first.last.result.said, /sender-one is not paired yet/);
  assert.deepEqual((await db.sql('select id from sender_pairing')).map(row => row.id), [`pairing-waiting:events:a:${first.last.result.code}`]);
  const again = await run('tool:pair-an-unknown-sender', { source_id: 'events:a', sender: 'sender-one' });
  assert.equal(again.last.result.code, first.last.result.code, 'asking again makes no second code');
  assert.equal((await db.sql('select id from sender_pairing')).length, 1);
  const approved = await run('tool:approve-a-pairing-code', { code: first.last.result.code.toLowerCase() });
  assert.equal(approved.last.result.sender, 'sender-one');
  const listed = await run('tool:list-paired-senders', { source_id: 'events:a', sender: 'sender-one' });
  assert.deepEqual(listed.last.result.waiting, []);
  assert.deepEqual(listed.last.result.paired.map(row => row.sender), ['sender-one']);
  assert.equal(listed.last.result.is_paired, true);
  const twice = await run('tool:approve-a-pairing-code', { code: first.last.result.code });
  assert.match(twice.last.error, /No waiting pairing code/);
  const revoked = await run('tool:unpair-a-sender', { source_id: 'events:a', sender: 'sender-one' });
  assert.match(revoked.last.result.said, /no longer paired/);
  const after = await run('tool:list-paired-senders', { source_id: 'events:a', sender: 'sender-one' });
  assert.equal(after.last.result.is_paired, false);
});

test('each row has the one SQL shape: the held connection on descriptor 3, the one local door, no internet, no records right, and the files it imports', () => {
  assert.equal(rows.filter(row => row.kind === 'ai-tool-descriptor').length, 4);
  for (const row of rows) {
    assert.equal(row.invoke.internet, false, row.id);
    assert.deepEqual(row.invoke.local_doors, ['own-rows-postgres'], row.id);
    assert.deepEqual(row.invoke.credential_mounts, [{ secret_name: 'own-rows-postgres-connection', fd: 3 }], row.id);
    assert.equal(row.invoke.records, undefined, row.id);
    assert.equal(row.invoke.files.package_files.some(spec => spec.package === 'records-door'), false, row.id);
    assert.deepEqual(row.verify.map(item => item.kind), ['needs-a-machine'], row.id);
  }
});
