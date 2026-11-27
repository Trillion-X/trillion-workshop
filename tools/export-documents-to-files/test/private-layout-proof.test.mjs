// Synthetic controls through the ordinary book-settings caller (the settings row comes in the request).
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
  const descriptor = rows.records.find(row => row.payload.id === TOOL_ID).payload;
  assert.deepEqual(descriptor.input_schema.properties.purpose.enum, ['final_delivery', 'private_layout_proof']);
  assert.equal(descriptor.input_schema.properties.purpose.default, 'final_delivery');
  assert.equal(descriptor.input_schema.properties.job_file.type, 'string');
  assert.ok(descriptor.output_schema.properties.status.enum.includes('private_layout_proof'));
  assert.equal(descriptor.output_schema.properties.delivery_eligible.type, 'boolean');
});

test('the public regular-blob baseline matches its declared pin and retains the active core', t => {
  const contract = JSON.parse(readFileSync(new URL('../ports/private-layout-proof.json', import.meta.url), 'utf8'));
  const rules = JSON.parse(readFileSync(join(repositoryRoot, 'ports', 'feature-files.json'), 'utf8'));
  const readers = gitReaders({ root: repositoryRoot });
  const target = 'tools/export-documents-to-files/do-work/private-layout-proof.py';
  const baseline = readers.targetAtCommit(contract.baseline.commit, target, { followRenames: false });
  assert.ok(Buffer.isBuffer(baseline), 'The public baseline commit must hold the regular source blob.');
  const identity = makeHashCodeHexFromBytes(baseline);
  assert.equal(identity, contract.baseline.target_multihash_at_baseline);
  assert.equal(identity, contract.baseline.source_multihash);
  assert.equal(identity, contract.sources[0].multihash);
  const active = readers.readTarget(target);
  assert.ok(Buffer.isBuffer(active), 'The active consumer must be a regular source file.');
  const meaningful = bytes => bytes.toString('utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 24);
  const originalLines = meaningful(baseline);
  const activeLines = new Set(meaningful(active));
  const retained = originalLines.filter(line => activeLines.has(line)).length;
  const required = Math.max(rules.retention_at_least, contract.proof.minimum_meaningful_line_retention);
  assert.ok(originalLines.length > 0);
  assert.ok(retained / originalLines.length >= required,
    `Public baseline retention ${retained}/${originalLines.length} must reach ${required}.`);
  t.diagnostic(JSON.stringify({ scope: 'public-baseline-to-active-core-only', baseline_commit: contract.baseline.commit,
    baseline_identity: identity, retained_lines: retained, baseline_lines: originalLines.length }));
});

test('an unavailable original is explicitly deferred with no source-retention measurement', () => {
  const contract = JSON.parse(readFileSync(new URL('../ports/private-layout-proof.json', import.meta.url), 'utf8'));
  const rules = JSON.parse(readFileSync(join(repositoryRoot, 'ports', 'feature-files.json'), 'utf8'));
  const publicReaders = gitReaders({ root: repositoryRoot });
  const originalRepository = contract.sources[0].repository;
  const unavailableOriginal = {
    ...publicReaders,
    checkout: name => name === originalRepository ? null : publicReaders.checkout(name),
    readSource: source => source.repository === originalRepository ? null : publicReaders.readSource(source),
    lives: (repository, path) => repository === originalRepository ? null : publicReaders.lives(repository, path),
  };
  const answer = validateReferenceAdaptationContract(contract, {
    stage: 'pre-edit', repository: 'trillion-workshop', readers: unavailableOriginal,
    modes: rules.modes, retentionAtLeast: rules.retention_at_least, oldCopyDaysAtMost: rules.old_copy_days_at_most,
    policySince: rules.since, target: 'tools/export-documents-to-files/do-work/private-layout-proof.py',
  });
  // Pre-edit acceptance with explicit deferred facts is not original-source qualification.
  assert.equal(answer.valid, true, JSON.stringify(answer));
  assert.equal(answer.measurements, null);
  assert.equal(answer.deferred.length, 2);
  assert.ok(answer.deferred.some(message => message.includes('source ') && message.includes('is not readable here')));
  assert.ok(answer.deferred.some(message => message.includes('whether the old copy ') && message.includes('is not readable here')));
  assert.equal(answer.status, contract.status);
});
function fixture(t) {
  const root = realpathSync(tempFolder(join(tmpdir(), 'private-layout-proof-test-')));
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
  const answer = await exportABook({ book_id: 'synthetic-layout', settings_record: row, purpose: 'private_layout_proof', job_file: f.job_file, python });
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
