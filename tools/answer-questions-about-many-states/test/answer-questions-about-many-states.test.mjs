// Runs this tool's Python tests (test/test_*.py: the MLX forward, the lifecycle, the whole command on a made-up model)
// and checks each row is run by the engine through a script that exists, with a pinned Python and pinned wheels. Every input is made up. The parts
// that need mlx, tokenizers or blake3 skip inside the Python tests and say why; agreement with the decider's own
// PyTorch code (agree_with_reference.py) and the 303 x 132 wall time (benchmark.py) are run by hand on a Mac.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const here = join(folder, 'test');
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });

test('each row runs on the person\'s Mac through the one script, one action each, by the engine', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:get-a-classifier-ready-on-this-mac', 'tool:answer-questions-about-many-states',
    'tool:read-a-bulk-answer-run', 'tool:cancel-a-bulk-answer-run']);
  const actions = [];
  for (const row of rows) {
    // The engine runs it (tools:run): no row asks the person to clone, install or start anything.
    assert.equal(row.invoke.kind, 'container');
    assert.equal(row.invoke.get_it, undefined);
    const [program, flag, script, action, ...rest] = row.invoke.argv;
    assert.deepEqual([program, flag, rest], ['python3', '-I', []]);
    assert.match(script, /^\/opt\/answer-questions-about-many-states\/do-work\/\w+\.py$/);
    assert.ok(existsSync(join(folder, script.replace('/opt/answer-questions-about-many-states/', ''))), script);
    assert.deepEqual(row.invoke.stdin, { fill: { from: 'input' } });
    actions.push(action);
    assert.deepEqual(row.placements, ['placement:your-computer']);
    assert.ok(row.invoke.needs[0].startsWith('a Mac with Apple silicon'));
  }
  assert.deepEqual(actions, ['get-ready', 'start', 'read', 'cancel']);
});

const pinned = entry => typeof entry.url === 'string' && entry.url.startsWith('https://') && /^[0-9a-f]{64}$/.test(entry.blake3)
  && entry.checked_against.startsWith('https://');

test('each row names the Python it runs with, pinned by BLAKE3, and the rows that import a library name each wheel, pinned', () => {
  for (const row of rows) {
    const python = row.invoke.programs.python3;
    assert.deepEqual(Object.keys(python.fetch), ['macos-aarch64']);
    const pin = python.fetch['macos-aarch64'];
    assert.ok(pinned(pin));
    assert.equal(pin.version, '3.12.16+20261026');
    assert.equal(pin.executable, 'bin/python3.12');
    const items = row.invoke.files.package_files;
    const wheels = items.find(item => item.packages);
    if (!['tool:get-a-classifier-ready-on-this-mac', 'tool:answer-questions-about-many-states'].includes(row.id)) {
      // read and cancel use the standard library only.
      assert.equal(wheels, undefined);
      assert.equal(row.invoke.packages, undefined);
      continue;
    }
    // Beside the script, so the script and the worker it starts (both `python3 -I` with the script's folder first on
    // the path) import them without any path setting.
    assert.equal(wheels.at, '/opt/answer-questions-about-many-states/do-work');
    assert.deepEqual(wheels.packages, Object.keys(row.invoke.packages));
    for (const name of ['mlx', 'mlx-metal', 'numpy', 'tokenizers', 'blake3', 'huggingface-hub']) assert.ok(wheels.packages.includes(name), name);
    for (const [name, wheel] of Object.entries(row.invoke.packages)) {
      assert.equal(wheel.archive, 'zip', name);
      const [[system, entry], ...more] = Object.entries(wheel.fetch);
      assert.deepEqual(more, [], name);
      assert.ok(['any', 'macos-aarch64'].includes(system), name);
      assert.ok(pinned(entry), name);
      assert.ok(entry.url.startsWith('https://files.pythonhosted.org/packages/'), name);
      assert.ok(entry.url.endsWith(system === 'any' ? '-none-any.whl' : '.whl'), name);
      assert.equal(entry.checked_against, `https://pypi.org/pypi/${entry.url.split('/').pop().split('-')[0]}/${wheel.version}/json`, name);
    }
  }
  // Both rows that import a library name the same wheels at the same pins.
  assert.deepEqual(rows[0].invoke.packages, rows[1].invoke.packages);
});

test('no model, person or example is named in the code', () => {
  for (const name of ['answer_many_states.py', 'questions_first/engine.py', 'questions_first/backbone.py']) {
    const text = readFileSync(join(folder, 'do-work', name), 'utf8');
    assert.doesNotMatch(text, /decider-2b|Mapika/, name);
  }
});

test('the Python tests of answer-questions-about-many-states pass', { skip: python.status === 0 ? false : 'needs python3', timeout: 900000 }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
