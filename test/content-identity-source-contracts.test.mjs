// Actual identity contracts use the shared judge with real history; a materialized test tree cannot prove history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../test-helpers/tool-rows.mjs';
import { gitReaders } from '../tools/check-a-port-against-its-source/do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from '../tools/check-a-port-against-its-source/do-work/validate-reference-adaptation-contract.mjs';

const history = existsSync(join(root, '.git'));
const readers = history ? gitReaders({ root, tree: process.env.GIT_INDEX_FILE ? ':' : undefined }) : null;
const rules = JSON.parse(readFileSync(join(root, 'ports/feature-files.json'), 'utf8'));
for (const [name, target] of [
  ['identity-in-place', 'tools/content-identity/read-data/identity.mjs'],
  ['blake3-compressor', 'tools/content-identity/read-data/blake3.mjs'],
]) {
  const path = `tools/content-identity/ports/${name}.json`;
  const contract = JSON.parse((readers ? readers.readTarget(path) : readFileSync(join(root, path))).toString('utf8'));
  assert.ok(contract.targets.some(one => one.path === target), `${path} must claim ${target}`);
  const unavailable = history && contract.sources.find(source => !readers.checkout(source.repository));
  const skip = !history ? 'no repository history in this materialized tree'
    : unavailable ? `source repository ${unavailable.repository} is unavailable here; admission remains unproved` : false;
  test(`${contract.id} admits its actual identity target at the ordinary pre-edit stage`, { skip }, t => {
    const result = validateReferenceAdaptationContract(contract, {
      readers, repository: readers.self, policySince: rules.since, target,
      stage: 'pre-edit', modes: rules.modes, retentionAtLeast: rules.retention_at_least,
      oldCopyDaysAtMost: rules.old_copy_days_at_most, requireRepositorySources: true,
    });
    t.diagnostic(JSON.stringify({ judged: [{ target, contract: path, stage: 'pre-edit', result }] }));
    assert.equal(result.valid, true, result.errors.join('\n'));
    assert.deepEqual(result.deferred, [], 'a deferred source is not admitted');
    assert.ok(result.measurements.meaningfulLineRetention >= rules.retention_at_least);
  });
}
