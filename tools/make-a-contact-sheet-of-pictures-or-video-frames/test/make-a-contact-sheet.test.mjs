// Runs this tool's Python tests (made-up pictures, and a made-up ffmpeg test video for the two video kinds), and checks that the
// row's command is a file in this folder. They need python3 with Pillow (and ffmpeg for the video tests); without Pillow they skip and say why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const pillow = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' });
const skip = pillow.status === 0 ? false : 'needs python3 with Pillow; run the row\'s get_it commands';

test('the row runs a script that is in this folder', () => {
  const script = row.invoke.run.match(/tools\/make-a-contact-sheet-of-pictures-or-video-frames\/(\S+\.py)/)?.[1];
  assert.ok(script, 'the run command names a script');
  assert.ok(existsSync(join(folder, script)), `${script} exists`);
});

test('the Python tests pass', { skip }, () => {
  const run = spawnSync('python3', [join(folder, 'test', 'test_make_contact_sheet.py')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr.split('\n').slice(-40).join('\n'));
});
