// A malformed nested collection is a refused declaration, including when a caller selects its target.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract, validateReferenceAdaptationEvidence } from '../do-work/validate-reference-adaptation-contract.mjs';

test('malformed targets with a selected target return structured errors from evidence and full admission', t => {
  const home = tempFolder(join(tmpdir(), 'immutable-evidence-shape-review-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'evidence-owner');
  mkdirSync(root);
  const git = (...args) => execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  }).trim();
  git('init', '-q', '-b', 'main');
  const source = 'export const originalEvidenceValue = 42;\n';
  writeFileSync(join(root, 'original.mjs'), source);
  git('add', '-A');
  git('-c', 'user.name=shape-review', '-c', 'user.email=shape@example.test', 'commit', '-qm', 'capture actual source');
  const commit = git('rev-parse', 'HEAD');
  const digest = makeHashCodeHexFromBytes(Buffer.from(source));
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation', id: 'REF-SYNTHETIC-EVIDENCE-SHAPE',
    status: 'BASELINED', mode: 'SOURCE_FIRST_PORT', directive: { quote: 'Port the captured original', message_multihash: digest },
    sources: [{ repository: basename(root), commit, path: 'original.mjs', multihash: digest,
      ownership: 'repository-owned', old_copy: { deleted_by: '2026-01-03T00:00:00Z' } }],
    targets: [{ path: 'current.mjs' }], preserve: ['the original constant'], allowed_deltas: ['future adapter'],
    banned_substitutions: ['unrelated rewrite'],
    baseline: { copied_before_adaptation: true, source_multihash: digest, target_multihash_at_baseline: digest,
      recorded_at: '2026-01-01T00:00:00Z' }, proof: { minimum_meaningful_line_retention: 0.6, test_refs: [] },
  };
  const options = { readers: gitReaders({ root }), repository: basename(root), target: 'current.mjs' };
  const control = validateReferenceAdaptationEvidence(contract, options);
  assert.equal(control.valid, true, JSON.stringify(control));
  assert.deepEqual(control.deferred, []);
  for (const targets of [{ path: 'current.mjs' }, 'current.mjs', 42]) {
    let result;
    assert.doesNotThrow(() => { result = validateReferenceAdaptationEvidence({ ...contract, targets }, options); });
    assert.equal(result.scope, 'immutable-contract-evidence');
    assert.equal(result.admission, false);
    assert.equal(result.valid, false, JSON.stringify(result));
    assert.ok(result.errors.some(error => /targets must be non-empty/.test(error)), JSON.stringify(result));
    let admission;
    assert.doesNotThrow(() => {
      admission = validateReferenceAdaptationContract({ ...contract, targets }, { ...options, stage: 'pre-edit' });
    });
    assert.equal(admission.valid, false, JSON.stringify(admission));
    assert.ok(Array.isArray(admission.errors));
    assert.ok(Array.isArray(admission.deferred));
    assert.ok(admission.errors.some(error => /targets must be non-empty/.test(error)), JSON.stringify(admission));
  }
});
