// The exact selector baseline was committed before any active adaptation.
// The shared reader owns repository/history access; this test passes its scope.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gitReaders } from 'trillion-workshop/tools/check-a-port-against-its-source/do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from 'trillion-workshop/tools/check-a-port-against-its-source/do-work/validate-reference-adaptation-contract.mjs';

for (const name of ['starting-action', 'share-destinations']) {
  test(`${name} has a real committed full-source baseline before active adaptation`, () => {
    const contract = JSON.parse(readFileSync(new URL(`../ports/${name}.json`, import.meta.url)));
    const readers = gitReaders({ root: process.cwd() });
    const result = validateReferenceAdaptationContract(contract, {
      stage: 'pre-edit', target: contract.targets[0].path, readers,
      repository: readers.self,
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.deferred, []);
    assert.equal(result.valid, true);
  });
}
