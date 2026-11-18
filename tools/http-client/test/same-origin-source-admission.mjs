// Explicit source-admission control: run with the declared original repository
// available. Public capture checks do not replace these zero-deferred checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gitReaders } from 'trillion-workshop/tools/check-a-port-against-its-source/do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from 'trillion-workshop/tools/check-a-port-against-its-source/do-work/validate-reference-adaptation-contract.mjs';

test('both actual original sources, their captures and published retirement are verified without deferral', () => {
  const contract = JSON.parse(readFileSync(new URL('../ports/same-origin.json', import.meta.url), 'utf8'));
  const readers = gitReaders({ root: process.cwd() });
  const rules = JSON.parse(readers.readTarget('ports/feature-files.json').toString('utf8'));
  const hostSource = readers.readSource(contract.sources[0]);
  const hostCapture = readers.targetAtCommit(contract.baseline.commit, contract.targets[0].path);
  assert.deepEqual(hostCapture, hostSource);
  assert.doesNotMatch(hostCapture.toString('utf8'), /export function sharedCookieDomain/);
  const visitorSource = readers.readSource(contract.sources[1]);
  const visitorCapture = readers.targetAtCommit(contract.baseline.commit,
    'tools/show-a-visitor-who-is-not-signed-in-the-same/from-an-older-version/src/visitor-offers.mjs.held');
  assert.ok(visitorSource && visitorCapture, 'both immutable visitor source and earlier held range are readable');
  const [first, last] = contract.sources[1].lines;
  const selected = bytes => Buffer.from(`${bytes.toString('utf8').split('\n').slice(first - 1, last).join('\n')}\n`);
  assert.deepEqual(selected(visitorCapture), selected(visitorSource));
  assert.notDeepEqual(visitorCapture, visitorSource, 'the surrounding held file is not claimed as a full original copy');
  const checked = validateReferenceAdaptationContract(contract, {
    readers, repository: readers.self, stage: 'pre-edit',
    activeTargetPaths: contract.targets.map(target => target.path),
    policySince: rules.since, retentionAtLeast: rules.retention_at_least,
    oldCopyDaysAtMost: rules.old_copy_days_at_most, requireRepositorySources: true,
  });
  readers.assertScope();
  assert.deepEqual(checked.errors, []);
  assert.deepEqual(checked.deferred, []);
  assert.equal(checked.valid, true);
  assert.ok(checked.measurements.meaningfulLineRetention >= 0.6);
});
