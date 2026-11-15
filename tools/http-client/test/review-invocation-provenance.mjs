// Real pinned-Git readback for this adaptation. No replacement bytes/readers or
// synthesized history are accepted. Missing repositories are an explicit failure.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { gitReaders } from '../../check-a-port-against-its-source/do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from '../../check-a-port-against-its-source/do-work/validate-reference-adaptation-contract.mjs';
import { makeHashCodeHexFromBytes as identity } from '../../content-identity/read-data/identity.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const contract = JSON.parse(readFileSync(resolve(root, 'tools/http-client/ports/http-invocation.json')));
const readers = gitReaders({ root });
const captures = ['workshop-invocation-renderer', 'workshop-invocation-encoding', 'workshop-http-json'];
const sources = contract.sources.map((source, index) => {
  const sourceBytes = readers.readSource(source);
  assert.ok(sourceBytes, 'immutable original source must be readable');
  const [first, last] = source.lines;
  const bytes = Buffer.from(sourceBytes.toString('utf8').split('\n').slice(first - 1, last).join('\n') + '\n');
  const path = `tools/http-client/source-baselines/${captures[index]}.mjs.held`;
  assert.equal(identity(bytes), source.multihash);
  assert.deepEqual(readFileSync(resolve(root, path)), bytes);
  assert.deepEqual(readers.targetAtCommit(contract.baseline.commit, path), bytes);
  return { repository: source.repository, commit: source.commit, path: source.path, lines: source.lines, capture: path, identity: identity(bytes), original_and_held_and_baseline_equal: true };
});
const result = validateReferenceAdaptationContract(contract, { readers, repository: readers.self, stage: 'pre-edit', requireRepositorySources: true, retentionAtLeast: 0.6, oldCopyDaysAtMost: 3, activeTargetPaths: contract.targets.map(one => one.path) });
readers.assertScope();
console.log(JSON.stringify({ sources, target_identity: identity(readFileSync(resolve(root, contract.targets[0].path))), ...result }, null, 2));
process.exitCode = result.valid && result.deferred.length === 0 ? 0 : 1;
