import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gitReaders } from 'trillion-workshop/tools/check-a-port-against-its-source/do-work/read-from-repositories.mjs';
import { makeHashCodeHexFromBytes } from 'trillion-workshop/tools/content-identity/read-data/identity.mjs';

test('committed host and selected cookie captures bind declared identities before adaptation', () => {
  const contract = JSON.parse(readFileSync(new URL('../ports/same-origin.json', import.meta.url), 'utf8'));
  const readers = gitReaders({ root: process.cwd() });
  // These public snapshot checks are not original-repository admission.
  // The explicit source-admission entry separately requires zero deferrals.
  const hostCapture = readers.targetAtCommit(contract.baseline.commit, contract.targets[0].path);
  assert.equal(makeHashCodeHexFromBytes(hostCapture), contract.sources[0].multihash);
  assert.deepEqual(hostCapture, readers.targetAtCommit('a9ee2580ee189318d68436451760e084e7bc6ebb', contract.targets[0].path));
  assert.doesNotMatch(hostCapture.toString('utf8'), /export function sharedCookieDomain/);
  const visitorCapture = readers.targetAtCommit(contract.baseline.commit,
    'tools/show-a-visitor-who-is-not-signed-in-the-same/from-old-trillion/src/visitor-offers.mjs.held');
  assert.ok(visitorCapture, 'the earlier held cookie range is readable');
  const [first, last] = contract.sources[1].lines;
  const selected = bytes => Buffer.from(`${bytes.toString('utf8').split('\n').slice(first - 1, last).join('\n')}\n`);
  assert.equal(makeHashCodeHexFromBytes(selected(visitorCapture)), contract.sources[1].multihash);
  const history = readers.baselineHistory(contract.baseline.commit, contract.targets.map(target => target.path));
  assert.equal(history.ancestor, true);
  assert.equal(history.allEarlierOrParallelContent, true);
  for (const target of history.targets) {
    assert.deepEqual(target.atBaseline, hostCapture);
    for (const earlier of target.before) assert.deepEqual(earlier, hostCapture);
  }
  readers.assertScope();
});
