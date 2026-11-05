// Runs the Python tests of this tool (test/test_compare_models.py, test/test_voice_ab.py) with made-up inputs, and checks each row names the
// script that exists. render_note_events.py runs for real; the voice and speaker model runs need models these tests do
// not fetch, so their argument checks and pure parts are tested. Needs python3; the parts that need numpy and soundfile
// skip inside the Python tests and say why.
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

test('each row runs on the person\'s computer and names a script that exists', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:say-lines-in-a-candidate-voice-model', 'tool:score-how-alike-lines-sound-to-a-reference-voice', 'tool:render-music-note-events-to-a-test-wav',
    'tool:say-a-narration-line-in-a-kokoro-voice', 'tool:say-a-narration-line-in-a-cloned-voice-model', 'tool:measure-narration-takes',
    'tool:make-and-measure-every-voice-take-of-a-line']);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'on-your-computer');
    const script = row.invoke.run.match(/tools\/compare-voice-and-music-models\/(do-work\/\w+\.(?:py|sh))/)[1];
    assert.ok(existsSync(join(folder, script)), script);
    assert.deepEqual(row.placements, ['placement:your-computer']);
  }
});

test('the Python tests of compare-voice-and-music-models pass', { skip: python.status === 0 ? false : 'needs python3' }, () => {
  const run = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_*.py'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\nOK/);
});
