// Readiness must prove actual packages in the admitted dependency projection; a missing program, empty answer,
// wrong package version, missing import or module from another prefix cannot turn into a ready environment.
import { tempFolder } from '../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configuration, pythonForTests, pythonProfile, pythonRuntime, verifyPythonEnvironment } from '../test-helpers/python-environment.mjs';

test('a module consumer imported from either stdin form does not run setup or inspect a nonexistent caller file', () => {
  const source = `await import(${JSON.stringify(new URL('../test-helpers/python-environment.mjs', import.meta.url).href)}); console.log('imported');`;
  for (const argv of [['--input-type=module', '-'], ['--input-type=module']]) {
    const result = spawnSync(process.execPath, argv, { input: source, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'imported');
  }
});

test('the default runtime and prepared environment have their declared versions', () => {
  assert.deepEqual(pythonRuntime().version.slice(0, 2), configuration.python);
  const python = pythonForTests();
  const checked = verifyPythonEnvironment(python, dirname(dirname(python)));
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.deepEqual(checked.versions, Object.fromEntries(configuration.packages.map(item => [item.name, item.version])));
});

test('a missing interpreter, empty answer or wrong prefix is never ready', () => {
  assert.equal(verifyPythonEnvironment('/workshop-no-such-interpreter', '/workshop-no-such-prefix').ok, false);
  assert.equal(verifyPythonEnvironment('/usr/bin/true', '/workshop-no-such-prefix').ok, false);
  const checked = verifyPythonEnvironment(pythonForTests(), tmpdir());
  assert.equal(checked.ok, false);
  assert.ok(checked.wrong.includes('the interpreter is not in the requested environment'));
});

test('only a declared profile selects dependencies and an isolated runtime', () => {
  for (const name of ['../python-environment', 'constructor', '/tmp/profile.json', 'missing']) {
    assert.throws(() => pythonProfile(name), /Unknown or invalid/);
  }
  const classifier = pythonProfile('classifier');
  assert.deepEqual(pythonRuntime('classifier').version.slice(0, 2), classifier.configuration.python);
  const python = pythonForTests('classifier');
  assert.notEqual(python, pythonForTests(), 'classifier dependencies never replace the existing media environment');
  const checked = verifyPythonEnvironment(python, dirname(dirname(python)), classifier.path);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.deepEqual(checked.versions, Object.fromEntries(classifier.configuration.packages.map(item => [item.name, item.version])));
  const wrongProfile = verifyPythonEnvironment(pythonForTests(), dirname(dirname(pythonForTests())), classifier.path);
  assert.equal(wrongProfile.ok, false, 'the media projection cannot claim the classifier dependency closure');
});

test('wrong versions, absent modules and imports outside the dependency prefix refuse readiness', t => {
  const folder = tempFolder(join(tmpdir(), 'python-readiness-test-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'configuration.json');
  const python = pythonForTests();
  const prefix = dirname(dirname(python));
  const numpy = configuration.packages.find(item => item.name === 'numpy');
  for (const [item, reason] of [
    [{ ...numpy, version: '0' }, /numpy: expected 0/],
    [{ ...numpy, module: 'workshop_module_that_does_not_exist' }, /numpy: ModuleNotFoundError/],
    [{ ...numpy, module: 'json' }, /numpy: imported outside/],
  ]) {
    writeFileSync(path, JSON.stringify({ packages: [item] }));
    const checked = verifyPythonEnvironment(python, prefix, path);
    assert.equal(checked.ok, false);
    assert.match(checked.wrong.join('; '), reason);
  }
});
