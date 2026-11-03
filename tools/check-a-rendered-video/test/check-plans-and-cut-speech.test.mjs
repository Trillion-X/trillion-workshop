// The plan check and the cut-speech check (do-work/check_plan_cuts.py, do-work/check_cut_speech.py): their rows name scripts in
// this folder and pack the cutter's span lookup they import, and their Python tests pass on made-up recordings whose words are tones
// (test/test_plan_and_cut_speech.py). Those need python3 with numpy and soundfile, and ffmpeg; without them they skip and say why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const tools = join(folder, '..');
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const python = (...argv) => spawnSync('python3', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const probe = python('-c', 'import importlib.util as u, shutil, json; m = [n for n in ("numpy", "soundfile") if u.find_spec(n) is None] + [t for t in ("ffmpeg",) if shutil.which(t) is None]; print(json.dumps(m))');
const missing = probe.status === 0 ? JSON.parse(probe.stdout.trim()) : ['python3'];
const skip = missing.length ? `needs python3 with numpy and soundfile, and ffmpeg (missing ${missing.join(', ')})` : false;

const ours = {
  'tool:check-each-cut-of-my-plans-by-ear': 'do-work/check_plan_cuts.py',
  'tool:check-a-cuts-speech-against-its-plan': 'do-work/check_cut_speech.py',
};

test('each row runs its script from this folder and packs what the script imports', () => {
  for (const [id, script] of Object.entries(ours)) {
    const row = rows.find(r => r.id === id);
    assert.ok(row, `${id} is a row of this folder`);
    assert.equal(row.invoke.kind, 'on-your-computer');
    assert.ok(row.invoke.run.startsWith(`python3 tools/check-a-rendered-video/${script} `), row.invoke.run);
    const packed = row.invoke.files.package_files.flatMap(spec => spec.paths.map(path => join(tools, spec.package, path)));
    for (const file of packed) assert.ok(existsSync(file), `${file} exists`);
    assert.ok(packed.includes(join(folder, script)), `${id} packs ${script}`);
    assert.ok(packed.includes(join(folder, 'do-work', 'speech_reading.py')), `${id} packs speech_reading.py`);
  }
  const plan = rows.find(r => r.id === 'tool:check-each-cut-of-my-plans-by-ear');
  assert.ok(plan.invoke.files.package_files.some(spec => spec.package === 'assemble-a-plan-into-a-cut' && spec.paths.includes('read-data/spans.py')),
    'the plan check packs the cutter\'s span lookup');
});

test('the plan and cut-speech checks keep their promises on made-up recordings', { skip, timeout: 300000 }, () => {
  const run = spawnSync('python3', ['-m', 'unittest', 'test_plan_and_cut_speech'], { cwd: join(folder, 'test'), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.split('\n').slice(-40).join('\n'));
  assert.match(run.stderr, /Ran (\d+) tests/);
  assert.ok(Number(run.stderr.match(/Ran (\d+) tests/)[1]) >= 8);
});
