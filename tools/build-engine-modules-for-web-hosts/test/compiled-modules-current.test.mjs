// tools/build-engine-modules-for-web-hosts/test/compiled-modules-current.test.mjs
//
// The crate-built modules committed under built-stored-bytes match their crates' sources (the build reads them
// as they are and needs no Rust), the composition engine's wasm32-wasip1 slot asks its host for its two buffers through
// the `env` import module (so every linker keeps them imports: a wasip1 link refuses an undefined symbol otherwise), and
// build/build-formula-evaluator.mjs rebuilds the Workshop's formula engine glue byte for byte from its crate.
// The fingerprint and the rebuild need the engine's crates beside this checkout (../trillion-rust) and cargo; without
// them those two tests say so and stop.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_TOOL, BUILT_CRATES_FOLDER, TOOLS, WORKSHOP, committedModulesCurrent, missingCrateInput } from '../build/compiled-modules.mjs';

const engineCrates = join(WORKSHOP, '../trillion-rust/crates');
const hasCargo = (() => { try { execFileSync('cargo', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const declaredCrateDirs = () => JSON.parse(readFileSync(join(BUILT_CRATES_FOLDER, 'fingerprint.json'), 'utf8')).crate_dirs;
const missingSkip = () => {
  const missing = missingCrateInput(declaredCrateDirs());
  return missing && `fingerprint.json crate_dirs ${missing.dir} is missing ${missing.file} (sibling checkout partial?)`;
};

test('the committed crate modules match their crates\' sources', { skip: !existsSync(engineCrates) && `needs ${engineCrates}` }, async () => {
  const missing = missingCrateInput(declaredCrateDirs());
  assert.equal(missing, null, missing && `fingerprint.json crate_dirs ${missing.dir} is missing ${missing.file} (sibling checkout partial?)`);
  assert.equal(await committedModulesCurrent(), true);
});

test('a partial sibling checkout names the crate input it lacks', () => {
  const root = tempFolder(join(tmpdir(), 'partial-sibling-'));
  try {
    const base = join(root, 'workshop', 'tools');
    const dir = '../../trillion-rust/crates/content-crypto';
    const crates = join(root, 'trillion-rust', 'crates');
    mkdirSync(base, { recursive: true });
    assert.deepEqual(missingCrateInput([dir], base), { dir, file: `${dir}/Cargo.toml` });
    mkdirSync(join(crates, 'content-crypto'), { recursive: true });
    writeFileSync(join(crates, 'content-crypto', 'Cargo.toml'), '[package]\nname = "content-crypto"\n');
    assert.deepEqual(missingCrateInput([dir], base), { dir, file: '../../trillion-rust/crates/Cargo.toml' });
    writeFileSync(join(crates, 'Cargo.toml'), '[workspace]\nmembers = ["content-crypto"]\n');
    assert.deepEqual(missingCrateInput([dir], base), { dir, file: '../../trillion-rust/crates/Cargo.lock' });
    writeFileSync(join(crates, 'Cargo.lock'), 'version = 4\n');
    assert.equal(missingCrateInput([dir], base), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the composition engine slot takes its two host calls from the env import module', () => {
  const module = new WebAssembly.Module(readFileSync(join(BUILT_CRATES_FOLDER, 'composition-engine/composition_engine.wasm')));
  const fromHost = WebAssembly.Module.imports(module).filter(entry => entry.name.startsWith('__')).map(entry => `${entry.module}.${entry.name}`).sort();
  assert.deepEqual(fromHost, ['env.__init_buffers', 'env.__notify_ready']);
});

test('build-formula-evaluator.mjs rebuilds the Workshop formula engine: the same glue, its module answers a rule it compiles, and its component answers the same request',
  { skip: (!existsSync(engineCrates) || !hasCargo) ? 'needs cargo and ../trillion-rust' : missingSkip(), timeout: 900_000 }, async () => {
    const into = tempFolder(join(tmpdir(), 'formula-engine-'));
    try {
      execFileSync(process.execPath, [join(BUILD_TOOL, 'build/build-formula-evaluator.mjs'), '--into', into], { stdio: ['ignore', 'ignore', 'inherit'] });
      const engine = path => join(TOOLS, 'formula-engine', path);
      assert.equal(readFileSync(join(into, 'formula_engine.js'), 'utf8'), readFileSync(engine('built-stored-bytes/formula-engine/formula_engine.js'), 'utf8'));
      // The glue is the same, so it instantiates the rebuilt bytes; the engine compiles the rule itself.
      const glue = await import(join(into, 'formula_engine.js'));
      glue.initSync({ module: readFileSync(join(into, 'formula_engine_bg.wasm')) });
      const request = { records: [{ amount: 9 }, { amount: 2 }], fields: [{ id: 'amount', kind: 'number' }],
        tree: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'amount', operator: 'greater_than', params: { value: 5 } }] } };
      assert.deepEqual(glue.filterRecords(request).matches, [0]);
      const host = (() => { try { execFileSync('wasmtime', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
      if (host) {
        const answer = JSON.parse(execFileSync('wasmtime', ['run', join(into, 'formula-engine.wasm'), 'filterRecords'], { input: JSON.stringify(request), encoding: 'utf8' }).trim().split('\n').pop());
        assert.deepEqual(answer.result.matches, [0]);
      }
    } finally { rmSync(into, { recursive: true, force: true }); }
  });

// The workspace manifests and locks count by what a build of the modules' crates reads from them, so a crate added
// beside them (or the engine binary's own dependencies) leaves the committed modules current.
const LOCK = `# generated
version = 4

[[package]]
name = "a"
version = "0.1.0"
dependencies = [
 "b",
 "serde 1.0.0",
]

[[package]]
name = "b"
version = "0.1.0"

[[package]]
name = "other"
version = "0.1.0"
dependencies = [
 "serde 2.0.0",
]

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "11"

[[package]]
name = "serde"
version = "2.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "22"
`;

test('a lock counts only the entries the modules\' crates reach', async () => {
  const { lockClosureMeasure } = await import('../build/compiled-modules.mjs');
  const measure = lockClosureMeasure(LOCK, ['a']);
  assert.match(measure, /name = "a"/);
  assert.match(measure, /name = "b"/);
  assert.match(measure, /checksum = "11"/);
  assert.doesNotMatch(measure, /name = "other"|checksum = "22"/);
  // A crate added beside them, and what only it uses, leave the measure unchanged.
  const added = LOCK + '\n[[package]]\nname = "new-member"\nversion = "0.1.0"\ndependencies = [\n "serde 2.0.0",\n]\n';
  assert.equal(lockClosureMeasure(added, ['a']), measure);
  // A changed checksum, version or dependency of anything they reach changes it.
  assert.notEqual(lockClosureMeasure(LOCK.replace('checksum = "11"', 'checksum = "33"'), ['a']), measure);
  assert.notEqual(lockClosureMeasure(LOCK.replace(' "b",\n', ' "b",\n "other",\n'), ['a']), measure);
  // A dependency name that does not resolve to one entry keeps the whole lock.
  assert.equal(lockClosureMeasure(LOCK.replace(' "serde 1.0.0",', ' "serde",'), ['a']), LOCK.replace(' "serde 1.0.0",', ' "serde",'));
});

test('a workspace manifest counts everything but its member lists', async () => {
  const { workspaceManifestMeasure, packageNameOf } = await import('../build/compiled-modules.mjs');
  const manifest = '[workspace]\nresolver = "2"\nmembers = ["a", "b"]\nexclude = [\n  "c",\n]\n\n[workspace.dependencies]\nserde = "1"\n\n[profile.release]\nopt-level = "z"\n';
  const measure = workspaceManifestMeasure(manifest);
  assert.equal(workspaceManifestMeasure(manifest.replace('["a", "b"]', '["a", "b", "new-member"]')), measure);
  assert.notEqual(workspaceManifestMeasure(manifest.replace('serde = "1"', 'serde = "2"')), measure);
  assert.notEqual(workspaceManifestMeasure(manifest.replace('"z"', '3')), measure);
  assert.notEqual(workspaceManifestMeasure(manifest.replace('resolver = "2"', 'resolver = "3"')), measure);
  // A manifest with no [workspace] table is the package's own and counts whole.
  assert.equal(workspaceManifestMeasure('[package]\nname = "a"\n'), '[package]\nname = "a"\n');
  assert.equal(packageNameOf('[package]\nname = "formula-engine-evaluate-over-rows"\nversion.workspace = true\n\n[dependencies]\nname = "x"\n'), 'formula-engine-evaluate-over-rows');
});
