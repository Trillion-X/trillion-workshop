// tools/build-engine-modules-for-web-hosts/test/compiled-modules-current.test.mjs
//
// The crate-built modules committed under built-stored-bytes match their crates' sources (the build reads them
// as they are and needs no Rust), the composition engine's wasm32-wasip1 slot asks its host for its two buffers through
// the `env` import module (so every linker keeps them imports: a wasip1 link refuses an undefined symbol otherwise), and
// build/build-formula-evaluator.mjs rebuilds the Workshop's evaluator glue byte for byte from the engine's crate.
// The fingerprint and the rebuild need the engine's crates beside this checkout (../trillion-rust) and cargo; without
// them those two tests say so and stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_TOOL, BUILT_CRATES_FOLDER, TOOLS, WORKSHOP, committedModulesCurrent } from '../build/compiled-modules.mjs';

const engineCrates = join(WORKSHOP, '../trillion-rust/crates');
const hasCargo = (() => { try { execFileSync('cargo', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('the committed crate modules match their crates\' sources', { skip: !existsSync(engineCrates) && `needs ${engineCrates}` }, async () => {
  assert.equal(await committedModulesCurrent(), true);
});

test('the composition engine slot takes its two host calls from the env import module', () => {
  const module = new WebAssembly.Module(readFileSync(join(BUILT_CRATES_FOLDER, 'composition-engine/composition_engine.wasm')));
  const fromHost = WebAssembly.Module.imports(module).filter(entry => entry.name.startsWith('__')).map(entry => `${entry.module}.${entry.name}`).sort();
  assert.deepEqual(fromHost, ['env.__init_buffers', 'env.__notify_ready']);
});

test('build-formula-evaluator.mjs rebuilds the Workshop evaluator: the same glue, and its wasm answers a compiled rule',
  { skip: (!existsSync(engineCrates) || !hasCargo) && 'needs cargo and ../trillion-rust', timeout: 600_000 }, async () => {
    const into = mkdtempSync(join(tmpdir(), 'formula-evaluator-'));
    try {
      execFileSync(process.execPath, [join(BUILD_TOOL, 'build/build-formula-evaluator.mjs'), '--into', into], { stdio: ['ignore', 'ignore', 'inherit'] });
      const engine = path => join(TOOLS, 'formula-engine', path);
      assert.equal(readFileSync(join(into, 'evaluate-over-rows.js'), 'utf8'), readFileSync(engine('built-stored-bytes/evaluate-over-rows/evaluate-over-rows.js'), 'utf8'));
      // The glue is the same, so the Workshop's loader instantiates the rebuilt bytes.
      const { loadRowEvaluator } = await import('../../formula-engine/rules/evaluate-over-rows.mjs');
      const { compileRules, ruleVocabulary } = await import('../../formula-engine/rules/compile-rules.mjs');
      const operators = JSON.parse(readFileSync(engine('rules/rule-operators.json'), 'utf8'));
      const tree = { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'amount', operator: 'greater_than', params: { value: 5 } }] };
      const { binding } = compileRules(tree, { fields: [{ id: 'amount', label: 'Amount', kind: 'number' }], vocabulary: ruleVocabulary(operators) });
      const evaluator = loadRowEvaluator(new Uint8Array(readFileSync(join(into, 'evaluate-over-rows_bg.wasm'))));
      assert.equal(evaluator.evaluate(binding, { amount: 9 }), true);
      assert.equal(evaluator.evaluate(binding, { amount: 2 }), false);
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
