// Runs the ported process scripts' tests: the keyframe sampler and the preview sheet (test_embed_video_frames_clip.py, test_build_preview_sheet.py) and the records builder (test_make_media_analysis_records.py). The sampler's tests use pytest fixtures, so they run under a Python that has pytest; the other two run as scripts. Skips, saying why, when no such Python is found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const here = import.meta.dirname;
const pythons = ['python3', '/opt/homebrew/anaconda3/bin/python3'];
const python = pythons.find(name => spawnSync(name, ['-I', '-m', 'pytest', '--version'], { encoding: 'utf8' }).status === 0);

for (const file of ['test_embed_video_frames_clip.py']) {
  test(`${file} passes`, { skip: !python && 'a Python with pytest is needed', timeout: 300000 }, () => {
    const done = spawnSync(python, ['-I', '-m', 'pytest', '-q', join(here, file)], { encoding: 'utf8', timeout: 300000 });
    assert.equal(done.status, 0, done.stdout + done.stderr);
  });
}

for (const file of ['test_build_preview_sheet.py', 'test_make_media_analysis_records.py']) {
  test(`${file} passes`, { skip: !python && 'a Python is needed', timeout: 300000 }, () => {
    const done = spawnSync(python, ['-I', join(here, file)], { encoding: 'utf8', timeout: 300000 });
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stdout, /ALL PASS/);
  });
}
