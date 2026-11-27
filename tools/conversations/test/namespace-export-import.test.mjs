import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import * as importer from '../read-data/chat-import.mjs';
import { heldStore, runKept } from './support/held-store.mjs';
import { runRow } from '../../../test-helpers/run-a-row.mjs';

const row = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url))).records.map(r => r.payload)
  .find(r => r.id === 'tool:import-conversation-exports-from-my-files');
const hash = bytes => makeHashCodeHexFromBytes(bytes);
const page = { conversation_id: 'bakery-1', title: 'Bread', messages: [
  { id: 'one', speaker: 'person', text: 'More rye.' },
  { id: 'two', speaker: 'person', text: 'More rye.' },
  { id: 'three', speaker: 'ai', text: 'Use fresh flour.' },
] };
const NOW = new Date('2026-11-04T12:00:00Z');
const bytes = Buffer.from(JSON.stringify(page));

// The person's account files: the export is a file in their store, held by the test.
const storeWithExport = () => heldStore({ files: { '/exports/bread.json': { base64: bytes.toString('base64') } } });
const importNamespace = (request, store) => runKept(store, (req, context) => importer.importNamespaceExports(req, { ...context, now: () => NOW }), request)
  .then(done => { const { keep: _keep, complete: _complete, ...answer } = done.answer ?? {}; return answer; });

test('namespace exports use immutable bytes and the canonical message owner; repeat imports preserve occurrences', async () => {
  const store = storeWithExport();
  const input = { input: { files: ['/exports/bread.json'] } };
  const one = await importNamespace(input, store);
  assert.equal(one.messages_added, 3);
  const messages = [...store.kept.values()].filter(r => r.type === 'message');
  assert.equal(messages.length, 3);
  assert.equal(messages.filter(r => r.value.text === 'More rye.').length, 2);
  const two = await importNamespace(input, store);
  assert.equal(two.messages_added, 0);
  assert.equal(two.files[0].skipped, true);
  assert.equal(two.messages_already_kept, 3);
  assert.equal([...store.kept.values()].filter(r => r.type === 'message').length, 3);
  assert.equal(hash(store.files.get('/exports/bread.json')), hash(bytes), 'the export is read, never changed');
});

test('a run not given the export asks for it and writes nothing; given, the messages are kept once and a resume adds nothing', async () => {
  const asked = await importer.importNamespaceExports({ input: { files: ['/exports/bread.json'] } }, { now: () => NOW });
  assert.equal(asked.complete, false);
  assert.deepEqual(asked.keep, []);
  assert.ok(asked.needs.files.includes('/exports/bread.json'));
  const store = storeWithExport();
  await importNamespace({ input: { files: ['/exports/bread.json'] } }, store);
  assert.equal([...store.kept.values()].filter(r => r.type === 'message').length, 3);
});

test('the declared row runs its synthetic namespace sample', async () => {
  const sample = row.verify[0];
  const ran = await runRow(row, sample.input, sample);
  assert.equal(ran.cannot, undefined);
  assert.equal(ran.code, 0, JSON.stringify({ stdout: ran.stdout, stderr: ran.stderr, last: ran.last }));
  assert.equal(ran.last.result.done, true);
  assert.equal(ran.last.result.messages_added, 2);
});
