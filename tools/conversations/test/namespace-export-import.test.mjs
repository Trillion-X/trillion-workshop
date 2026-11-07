import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { importNamespaceExports } from '../read-data/chat-import.mjs';
import { runRow } from '../../../test-helpers/run-a-row.mjs';

const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url))).records.map(r => r.payload)
  .find(r => r.id === 'tool:import-conversation-exports-from-my-files');
const hash = bytes => makeHashCodeHexFromBytes(bytes);
const page = { conversation_id: 'bakery-1', title: 'Bread', messages: [
  { id: 'one', speaker: 'person', text: 'More rye.' },
  { id: 'two', speaker: 'person', text: 'More rye.' },
  { id: 'three', speaker: 'ai', text: 'Use fresh flour.' },
] };

async function fixture(t, { badBytes = false, fail = false } = {}) {
  const fake = await startFakeDoor({ rights: row.invoke.records.rights });
  t.after(() => fake.close());
  const base = openRecordsDoor({ descriptor: fake.descriptor });
  const bytes = Buffer.from(JSON.stringify(page));
  const identity = hash(bytes);
  assert.match(identity, /^1f:[0-9a-f]{64}$/);
  const fileCalls = [];
  let interrupted = false;
  const door = { ...base,
    files: async (method, input) => {
      fileCalls.push({ method, input });
      if (method === 'find_file') return { identity, byte_length: bytes.length, names: ['/exports/bread.json'] };
      assert.equal(input.name_or_identity, identity);
      const content = badBytes ? 'bad' : bytes.subarray(input.offset, input.offset + input.length).toString();
      return { byte_length: bytes.length, bytes_returned: Buffer.byteLength(content), content, encoding: 'utf-8' };
    },
    write: async (records, options) => {
      if (fail && !interrupted && records.some(r => r.type === 'conversation-import-cursor')) {
        interrupted = true; throw new Error('synthetic cursor interruption');
      }
      return base.write(records, options);
    },
  };
  return { fake, door, fileCalls, bytes };
}

test('namespace exports use immutable bytes and the canonical message owner; repeat imports preserve occurrences', async t => {
  const { fake, door, fileCalls } = await fixture(t);
  const input = { files: ['/exports/bread.json'] };
  const one = await importNamespaceExports({ input }, { door });
  assert.equal(one.messages_added, 3);
  const messages = [...fake.kept.values()].filter(r => r.type === 'message');
  assert.equal(messages.length, 3);
  assert.equal(messages.filter(r => r.value.text === 'More rye.').length, 2);
  const two = await importNamespaceExports({ input }, { door });
  assert.equal(two.messages_added, 0);
  assert.equal(two.files[0].skipped, true);
  assert.equal(two.messages_already_kept, 3);
  assert.equal(fileCalls.filter(c => c.method === 'read_file').length, 2);
});

test('a lost cursor write resumes without duplicate messages', async t => {
  const { fake, door } = await fixture(t, { fail: true });
  const request = { input: { files: ['/exports/bread.json'] } };
  await assert.rejects(importNamespaceExports(request, { door }), /cursor interruption/);
  const resumed = await importNamespaceExports(request, { door });
  assert.equal(resumed.messages_added, 0);
  assert.equal(resumed.messages_already_kept, 3);
  assert.equal([...fake.kept.values()].filter(r => r.type === 'message').length, 3);
});

test('wrong content bytes never create messages or completion cursors', async t => {
  const { fake, door } = await fixture(t, { badBytes: true });
  await assert.rejects(importNamespaceExports({ input: { files: ['/exports/bread.json'] } }, { door }), /identity/);
  assert.equal(fake.kept.size, 0);
});

test('the declared row runs its synthetic namespace sample with exactly its rights', async () => {
  const sample = row.verify[0];
  const ran = await runRow(row, sample.input, sample);
  assert.equal(ran.cannot, undefined);
  assert.equal(ran.code, 0, JSON.stringify({ stdout: ran.stdout, stderr: ran.stderr, last: ran.last }));
  assert.equal(ran.last.result.done, true);
  assert.equal(ran.last.result.messages_added, 2);
});
