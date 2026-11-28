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
  ['test_phase_sync.py', 'a swing\'s takeback start, furthest back, contact and finish are read within one frame whatever the wrist labels, the reference lands each on the target\'s output frame, and a wrong contact or a speed outside the bounds is refused'],
  ['test_synced_render.py', 'a synced comparison renders each pass to its planned frames with the reference on its synced frames and smooth slow motion'],
  ['test_stroke_variants.py', 'the clip-library variants take their shapes and speeds from comparison-variants.json, the one list'],
  ['test_make_site_clip.py', 'a site clip is cut from its kept stretches, silent unless asked, kept by its identity, and wrong source bytes are refused'],
  ['test_find_strokes.py', 'strokes are found by the physical salience rules, and a lost body or a tracker jump makes no stroke'],
  ['test_files_road.py', 'a file is kept in pieces at offsets, retried, and checked by its identity'],
  ['test_model_location.py', 'every model is found under the one model folder'],
  ['test_make_matched_clips.py', 'a clip key follows its identity, dates come from names, a clip name carries both dates, a failed stage prints one error'],
  ['test_whole_stroke.py', 'a window cut at a clip edge is whole only when the edge is quiet and contact is far enough inside, in both describe_clip copies'],
  ['test_perceive_reuse.py', 'a kept descriptor is reused only when it was made with the same salience rules, a recording measured before is fetched from Files by identity, and one refused before is not tried again'],
  ['test_contact_moment.py', 'contact is the sharp sound of the hit near the wrist peak, else the wrist peak, never outside the window'],
  ['test_whole_movement_check.py', 'a cell whose crop cuts off the body or racket is widened to the smallest crop that holds it, or refused'],
  ['test_reference_length.py', 'prepare leaves out a reference longer than reference_max_seconds and names it'],
  ['test_check_stage.py', 'the check puts contact where the target reaches it in the first pass, also in a whole-swing pass'],
  ['test_render_stage.py', 'render runs contact, phase sync, the edit per format, the framing check and the renderer in order; a refused sync or framing makes no clip'],
  ['test_progression_stage.py', 'a progression takes the reference swing with the most dates, each date\'s closest synced swing spread over time within its length, one held reference crop and one date caption per swing'],
  ['test_whole_movement_still.py', 'a held-frame cell is measured at its frame, never raising'],
  ['test_side_by_side_layout.py', 'the check reads a side-by-side clip left and right, and a stacked reading of it does not match'],
  ['test_stroke_side.py', 'the takeback side is read in image space from the fastest wrist, the forehand side is given or read from the heading and the playing hand, the body\'s turn reads the same from every camera, and a stroke is called only when both readings agree'],
  ['test_measure_stage.py', 'each perceived recording is measured once into rows keyed by its identity (camera angle, stroke reading, contact with its source, people, date), a mark is the contact, a measured recording is read not measured, a refusal is kept, a new mark measures again'],
  ['test_match_side.py', 'a target swing that does not read as the movement is refused, its partner must read as it too, a playing hand alone has swings read, and the forehand side a swing was read with decides the mirror'],
  ['test_labelled_match.py', 'with labelled references a partner must be its class by a margin over every other class, and no contrast class fails closed'],
  ['../do-work/process-scripts/perception/test_window_frames.py', 'describing a long clip reads each window\'s frames in bounded memory and fingerprints the recording in chunks, with the same pictures as a seek-and-read'],
  ['../do-work/process-scripts/match/test_window_frames_use.py', 'the match copy hands the model the same frames in order through the one frame reader'],
]) {
  test(what, { skip: !ready && 'python3 with numpy is needed', timeout: 900000 }, () => {
    const done = spawnSync('python3', ['-B', join(here, file)], { encoding: 'utf8', timeout: 900000 });
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stderr, /\nOK\b/);
  });
}
