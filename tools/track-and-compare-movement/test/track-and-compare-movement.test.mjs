// Runs the four python test files: the phase alignment of two pose tracks on synthetic skeletons, the pose contract and
// cache rule, the side-by-side edit builder, and the selected-object tracker's refusals (plus a real run on a made-up video when the small SAM 2 model
// is cached). Skips, saying why, when python3 or numpy is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const here = import.meta.dirname;
const numpy = spawnSync('python3', ['-I', '-m', 'pip', 'show', 'numpy'], { encoding: 'utf8' });
const ready = numpy.status === 0;

for (const [file, what] of [
  ['test_align_dtw.py', 'two pose tracks of different speed are aligned in order and a bad track is refused'],
  ['test_estimate_pose.py', 'the pose contract makes a keypoint safe, a track is reused only for the same bytes, refusals say what to change'],
  ['test_track_selected_object.py', 'the tracker refuses a bad range, frame rate, point or output folder, and follows a made-up object when its model is cached'],
  ['test_author_comparison_edl.py', 'the side-by-side edit takes labels, layout, mirror and passes from the spec, keeps every crop inside the frame, and refuses a bad spec'],
]) {
  test(what, { skip: !ready && 'python3 with numpy is needed', timeout: 900000 }, () => {
    const done = spawnSync('python3', ['-B', join(here, file)], { encoding: 'utf8', timeout: 900000 });
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stderr, /\nOK\b/);
  });
}
