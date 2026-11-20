// Distinct prior owners retain their exact declared repository and path scope.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { gitReaders } from '../do-work/read-from-repositories.mjs';
import { validateReferenceAdaptationContract } from '../do-work/validate-reference-adaptation-contract.mjs';

const identity = value => makeHashCodeHexFromBytes(Buffer.from(value));
const SOURCE_PATH = 'src/order.mjs', TARGET = 'active/caller.mjs';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(root, ...args) {
  return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function initialize(root, path, bytes) {
  mkdirSync(root); git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'distinct-owner-test'); git(root, 'config', 'user.email', 'distinct@example.invalid');
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'synthetic source');
  const commit = git(root, 'rev-parse', 'HEAD'); git(root, 'update-ref', 'refs/remotes/origin/main', commit);
  return commit;
}
function fixture(t) {
  const home = tempFolder(join(tmpdir(), 'typed-distinct-prior-owners-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'receiving-owner'), old = join(home, 'source owner');
  initialize(root, TARGET, 'export const independentCaller = true;\n');
  const commit = initialize(old, SOURCE_PATH, 'export const orderRows = rows => rows.slice();\n');
  const name = basename(old), reference = { repository_multihash: identity(name) }, job = 'find row order owner';
  const contract = {
    schema: 'reference-adaptation-contract/reference-grounded-adaptation', id: 'REF-TYPED-DISTINCT-OWNER', status: 'ADAPTED',
    directive: { quote: 'Find the independent caller owner', message_multihash: identity('Find the independent caller owner') },
    mode: 'NO_PRIOR_OWNER', job, sources: [], targets: [{ path: TARGET }], preserve: [], allowed_deltas: [], banned_substitutions: [], baseline: {},
    distinct_from: [{ repository: name, path: SOURCE_PATH, why: 'The synthetic prior owner orders rows; this caller does a different job.' }],
    proof: { search: { phrasings: [job], code_patterns: ['order'], capability_rows: [], repositories: [{ repository_multihash: identity(name), commit }] } },
  };
  const options = { readers: gitReaders({ root, repositories: { [name]: old }, tree: 'HEAD' }), repository: basename(root),
    searchRepositories: [name], searchCapabilities: () => [], stage: 'pre-edit' };
  return { contract, options, name, reference };
}
const check = f => validateReferenceAdaptationContract(f.contract, f.options);
function pass(result) { assert.equal(result.valid, true, JSON.stringify(result)); assert.deepEqual(result.deferred, []); }

test('raw and typed distinct repository forms explain the same actual prior source hit', t => {
  const f = fixture(t), raw = check(f); pass(raw);
  f.contract.distinct_from[0].repository = f.reference;
  const result = check(f); pass(result); assert.deepEqual(result, raw);
});
test('a typed repository still requires the explanation for the actual prior source', t => {
  const f = fixture(t); f.contract.distinct_from[0].repository = f.reference;
  delete f.contract.distinct_from[0].why; const result = check(f);
  assert.equal(result.valid, false); assert.match(result.errors.join('\n'), /requires why/);
});
test('unknown, malformed and extra-field distinct locators cannot excuse a source hit', t => {
  const f = fixture(t);
  for (const locator of [{ repository_multihash: identity('outside-owner') }, { ...f.reference, repository: f.name },
    { repository_multihash: '1f:bad' }, Object.assign(Object.create(f.reference), { other: true })]) {
    f.contract.distinct_from[0].repository = locator; const result = check(f);
    assert.equal(result.valid, false); assert.match(result.errors.join('\n'), /finds .*port it/);
  }
});
test('typed prior-owner identity preserves exact and directory path bounds', t => {
  const f = fixture(t); f.contract.distinct_from[0].repository = f.reference;
  for (const path of ['src/', 'src/order.mjs']) { f.contract.distinct_from[0].path = path; pass(check(f)); }
  for (const path of ['src/order', 'other/order.mjs']) {
    f.contract.distinct_from[0].path = path; const result = check(f);
    assert.equal(result.valid, false); assert.match(result.errors.join('\n'), /finds .*port it/);
  }
});
