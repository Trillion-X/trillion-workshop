// Synthetic controls through the ordinary book-settings/records-door caller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportABook, TOOL_ID } from '../do-work/export-a-book.mjs';
import { makeRecord } from '../../settings/read-data/settings.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { validateReferenceAdaptationContract } from '../../check-a-port-against-its-source/do-work/validate-reference-adaptation-contract.mjs';
import { gitReaders } from '../../check-a-port-against-its-source/do-work/read-from-repositories.mjs';

const python = process.env.PRIVATE_LAYOUT_TEST_PYTHON ?? 'python3';
const hash = bytes => makeHashCodeHexFromBytes(bytes).split(':')[1];
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('the owned tool descriptor exposes the same purpose, job and non-delivery result as the normal caller', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
  const descriptor = rows.records.find(row => row.payload.id === TOOL_ID).payload;
  assert.deepEqual(descriptor.input_schema.properties.purpose.enum, ['final_delivery', 'private_layout_proof']);
  assert.equal(descriptor.input_schema.properties.purpose.default, 'final_delivery');
  assert.equal(descriptor.input_schema.properties.job_file.type, 'string');
  assert.ok(descriptor.output_schema.properties.status.enum.includes('private_layout_proof'));
  assert.equal(descriptor.output_schema.properties.delivery_eligible.type, 'boolean');
});

test('source-first provenance reads the actual original and honest byte-copy baseline', () => {
  const contract = JSON.parse(readFileSync(new URL('../ports/private-layout-proof.json', import.meta.url), 'utf8'));
  const rules = JSON.parse(readFileSync(join(repositoryRoot, 'ports', 'feature-files.json'), 'utf8'));
  const answer = validateReferenceAdaptationContract(contract, {
    stage: 'pre-edit', repository: 'trillion-workshop', readers: gitReaders({ root: repositoryRoot }),
    modes: rules.modes, retentionAtLeast: rules.retention_at_least, oldCopyDaysAtMost: rules.old_copy_days_at_most,
    policySince: rules.since, target: 'tools/export-documents-to-files/do-work/private-layout-proof.py',
  });
  assert.equal(answer.valid, true, JSON.stringify(answer));
  assert.deepEqual(answer.deferred, []);
  assert.equal(contract.status, 'ADAPTED');
});
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'private-layout-proof-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const save = (name, data) => {
    const path = join(root, name);
    writeFileSync(path, Buffer.isBuffer(data) ? data : JSON.stringify(data), { mode: 0o600 });
    return path;
  };
  const bytes = Buffer.from('# Synthetic\n\nA plain synthetic paragraph.\n');
  const manuscript = save('source.md', bytes);
  const sourceHash = hash(bytes);
  const tree = { props: { text: 'Synthetic' }, children: [{ props: { text: 'A plain synthetic paragraph.' }, children: [] }] };
  const job_file = save('job.json', { title: 'Synthetic', tree,
    source: { candidate_path: manuscript, candidate_content_identity: `1f:${sourceHash}` },
    descriptor: { format_id: 'docx', destination_dir: '/unused', file_stem: 'unused' } });
  const projection = save('projection.json', { schema: 'documents-structured-file-projection-v1', source_identity: `1f:${sourceHash}`, tree });
  const gate = save('gate.json', { gate_id: 'synthetic-layout-v1', passed: true });
  const starter = fileURLToPath(new URL('../read-data/starter-projection-rules.json', import.meta.url));
  const rules = save('rules.json', JSON.parse(readFileSync(starter, 'utf8')));
  const policy = save('policy.json', { schema: 'book-writing-policy-v1', unknown_documents: 'deny',
    documents: { 'source.md': { role: 'current_prose', source_blake3: sourceHash, native_gate_result: gate } },
    export_purposes: { private_layout_proof: { delivery_eligible: false, requires_voice_qualification: false,
      title: 'Private layout proof Unfinished manuscript', output_root: 'internal-layout',
      documents: { 'source.md': { file_stem: 'synthetic-unfinished-proof', projection, projection_blake3: hash(readFileSync(projection)),
        mechanical_gate_id: 'synthetic-layout-v1', mechanical_gate_blake3: hash(readFileSync(gate)), rules, rules_blake3: hash(readFileSync(rules)) } } } } });
  const settings = { role: 'current_prose', source_blake3: sourceHash, manuscript,
    export_purposes: { private_layout_proof: { input_root: root, policy, policy_blake3: hash(readFileSync(policy)) } } };
  return { root, manuscript, job_file, settings };
}

test('ordinary settings-row caller returns an unfinished non-delivery proof without running final checks', async t => {
  const f = fixture(t);
  const row = makeRecord('export-documents-to-files', 'piece', 'synthetic-layout', f.settings,
    { name: 'Synthetic layout', tool: TOOL_ID, source: 'synthetic-test@1' });
  const door = {
    async read(type, id) { return type === row.type && id === row.id ? row.value : null; },
    async *list() { throw new Error('The private scoped purpose must not run final-delivery checks.'); },
  };
  const answer = await exportABook({ book_id: 'synthetic-layout', purpose: 'private_layout_proof', job_file: f.job_file, python }, { door });
  assert.equal(answer.status, 'private_layout_proof', answer.reason);
  assert.equal(answer.delivery_eligible, false);
  assert.equal(answer.gate.purpose, 'private_layout_proof');
  assert.equal(answer.gate.delivery_eligible, false);
  assert.equal(answer.gate.voice_qualification, 'not_established');
  assert.equal(answer.checks, null);
  assert.ok(existsSync(answer.written));
  assert.ok(answer.written.startsWith(join(f.root, 'internal-layout')));
});

test('request-only purpose cannot broaden settings admission or redirect final output', async t => {
  const f = fixture(t);
  for (const input of [
    { settings: { role: 'current_prose' }, purpose: 'private_layout_proof', job_file: f.job_file },
    { settings: f.settings, purpose: 'private_layout_proof', job_file: f.job_file, output: join(f.root, 'final.docx') },
    { settings: f.settings, job_file: f.job_file },
    { settings: f.settings, purpose: 'other' },
  ]) {
    const answer = await exportABook({ manuscript: f.manuscript, ...input });
    assert.equal(answer.status, 'blocked');
  }
  assert.equal(existsSync(join(f.root, 'internal-layout')), false);
});

test('a final or qualified receipt cannot be mistaken for private-purpose success', async t => {
  const f = fixture(t);
  const fake = join(f.root, 'synthetic-receipt-program');
  for (const result of [
    { status: 'exported', delivery_eligible: false, gate: { purpose: 'final_delivery', delivery_eligible: false, voice_qualification: 'not_established' } },
    { status: 'private_layout_proof', delivery_eligible: true, gate: { purpose: 'private_layout_proof', delivery_eligible: true, voice_qualification: 'not_established' } },
    { status: 'private_layout_proof', delivery_eligible: false, gate: { purpose: 'private_layout_proof', delivery_eligible: false, voice_qualification: 'qualified' } },
  ]) {
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(result)}'\n`, { mode: 0o700 });
    const answer = await exportABook({ settings: f.settings, manuscript: f.manuscript,
      purpose: 'private_layout_proof', job_file: f.job_file, python: fake });
    assert.equal(answer.status, 'blocked');
    assert.match(answer.reason, /non-delivery receipt/);
  }
});
