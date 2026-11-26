// Runs the python test files: the phase alignment of two pose tracks on synthetic skeletons, the phase sync and its real render, the pose contract and
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
  ['test_phase_sync.py', 'the reference is retimed in a few bounded speed pieces that reach every phase of the target within one output frame, contact pinned'],
  ['test_synced_render.py', 'a synced comparison renders each pass to its planned frames with the reference on its synced frames and smooth slow motion'],
  ['test_stroke_variants.py', 'the clip-library variants take their shapes and speeds from comparison-variants.json, the one list'],
  ['test_make_site_clip.py', 'a site clip is cut from its kept stretches, silent unless asked, kept by its identity, and wrong source bytes are refused'],
  ['test_find_strokes.py', 'strokes are found by the physical salience rules, and a lost body or a tracker jump makes no stroke'],
  ['test_files_road.py', 'a file is kept in pieces at offsets, retried, and checked by its identity'],
  ['test_model_location.py', 'every model is found under the one model folder'],
  ['test_make_matched_clips.py', 'a clip key follows its identity, dates come from names, a clip name carries both dates, a failed stage prints one error'],
  ['test_whole_stroke.py', 'a window cut at a clip edge is whole only when the edge is quiet and contact is far enough inside, in both describe_clip copies'],
  ['test_perceive_reuse.py', 'a kept descriptor is reused only when it was made with the same salience rules'],
  ['test_contact_moment.py', 'contact is the sharp sound of the hit near the wrist peak, else the wrist peak, never outside the window'],
  ['test_whole_movement_check.py', 'a cell whose crop cuts off the body or racket is widened to the smallest crop that holds it, or refused'],
  ['test_reference_length.py', 'prepare leaves out a reference longer than reference_max_seconds and names it'],
  ['test_labelled_match.py', 'with labelled references a partner must be its class by a margin over every other class, and no contrast class fails closed'],
]) {
  test(what, { skip: !ready && 'python3 with numpy is needed', timeout: 900000 }, () => {
    const done = spawnSync('python3', ['-B', join(here, file)], { encoding: 'utf8', timeout: 900000 });
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stderr, /\nOK\b/);
  });
}
