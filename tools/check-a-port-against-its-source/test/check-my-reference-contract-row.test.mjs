// tools/check-a-port-against-its-source: the row is the shape the engine runs on the person's computer, and the command,
// run the way the engine runs it (the granted folder in argv, the input on standard input, the answer on the last line),
// reads a contract and the files it names relative to a made-up folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const folder = resolve(import.meta.dirname, '..');
const row = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records[0].payload;

function run(granted, input) {
  const ran = spawnSync(process.execPath, [resolve(folder, 'do-work', 'check-my-reference-contract.mjs'), granted], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: ran.status, answer: JSON.parse(ran.stdout.trim().split('\n').at(-1)) };
}

// A made-up source and its exact copy, with a contract that names them by path inside the folder.
function port(t) {
  const root = mkdtempSync(join(tmpdir(), 'check-my-reference-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = Array.from({ length: 20 }, (_, i) => `export const keptMechanism${i} = () => ${i}; // meaningful source line`).join('\n');
  writeFileSync(join(root, 'source.mjs'), source);
  writeFileSync(join(root, 'target.mjs'), source);
  const digest = makeHashCodeHexFromBytes(new TextEncoder().encode(source));
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation',
    id: 'REF-SAMPLE-PORT', status: 'VERIFIED',
    directive: { thread_id: 'sample', message_multihash: `1f:${'a'.repeat(64)}`, quote: 'port the exact same module' },
    mode: 'SOURCE_FIRST_PORT',
    sources: [{ path: 'source.mjs', multihash: digest, ownership: 'user-owned' }],
    targets: [{ path: 'target.mjs' }],
    preserve: ['the module\'s mechanisms'], allowed_deltas: ['labels'], banned_substitutions: ['a rewritten approximation'],
    baseline: { copied_before_adaptation: true, source_multihash: digest, target_multihash_at_baseline: digest, recorded_at: '2026-01-01T00:00:00Z' },
    proof: { minimum_meaningful_line_retention: 0.8, required_mechanisms: ['keptMechanism1'], test_refs: ['test:unit'], render_refs: [], originality_ref: null },
  };
  return { root, contract };
}

test('the row runs on the person\'s computer with only the folder capability, packs the one content identity, and reaches no internet', () => {
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.invoke.capabilities, ['read-a-folder']);
  assert.notEqual(row.invoke.internet, true);
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.result_selector, '$.result');
  assert.deepEqual(row.invoke.argv.at(-1), { fill: { from: 'task', field: 'grants.read-a-folder.folder' } });
  assert.ok(row.invoke.files.package_files.some(item => item.package === 'content-identity'));
});

test('an exact port with its proof is valid, whether the contract is given or read from a file in the folder', t => {
  const { root, contract } = port(t);
  const given = run(root, { contract, stage: 'completion', target: 'target.mjs' });
  assert.equal(given.status, 0, JSON.stringify(given.answer));
  assert.equal(given.answer.result.valid, true);
  assert.equal(given.answer.result.mode, 'SOURCE_FIRST_PORT');
  writeFileSync(join(root, 'contract.json'), JSON.stringify(contract));
  assert.equal(run(root, { contract_file: 'contract.json' }).answer.result.valid, true);
});

test('a source that drifted, and a target the contract does not own, are named in words with a non-zero status', t => {
  const { root, contract } = port(t);
  writeFileSync(join(root, 'source.mjs'), 'export const changed = 1;\n');
  const { status, answer } = run(root, { contract, target: 'elsewhere.mjs' });
  assert.equal(status, 1);
  assert.equal(answer.result.valid, false);
  assert.ok(answer.result.errors.some(error => error.includes('source multihash drift')));
  assert.ok(answer.result.errors.some(error => error.includes('does not own target')));
});

test('it refuses, in words, a contract file outside the folder, no contract, and a folder that is not one', t => {
  const { root, contract } = port(t);
  assert.match(run(root, { contract_file: '../outside.json' }).answer.error, /not a path inside the granted folder/);
  assert.match(run(root, {}).answer.error, /give contract/);
  assert.match(run(join(root, 'absent'), { contract }).answer.error, /granted folder/);
});
