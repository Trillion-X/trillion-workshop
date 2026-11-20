/**
 * #74 Ripple trim + magnetic close-gaps: two structural fold ops over the timeline.
 *  - close-gaps: repositions every clip in a lane to butt against the previous clip's
 *    end, removing all inter-clip empty space (CapCut/Premiere magnetic timeline).
 *  - ripple-trim: trims a clip edge AND shifts every downstream clip by the duration
 *    delta, so shortening a clip pulls the rest left and lengthening pushes them right,
 *    never opening a gap or overlapping.
 * These are pure timeline structure, so a composeTimeline boundary check is the proof
 * (no render change is involved).
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'ripple-'));
  const ctOut = join(dir, 'ct.mjs');
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ctOut}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ctOut));
});

// Three contiguous 2s clips in one video lane, seeded back-to-back: [0-2][2-4][4-6].
const baseView = (editDecisions) => ({
  lanes: [{
    lane_id: 'video', role: 'video', label: 'Video', items: [
      { item_id: 's1', label: 'A', start: 0, end: 2, source_ref: { artifact_ref: 'a.mp4' } },
      { item_id: 's2', label: 'B', start: 0, end: 2, source_ref: { artifact_ref: 'b.mp4' } },
      { item_id: 's3', label: 'C', start: 0, end: 2, source_ref: { artifact_ref: 'c.mp4' } },
    ],
  }],
  editDecisions,
  markers: [],
});

const clipsOf = (comp) => comp.lanes.find((l) => l.role === 'video').clips;
const gaps = (clips) => {
  const sorted = [...clips].sort((a, b) => a.laneStart - b.laneStart);
  let g = 0;
  for (let i = 1; i < sorted.length; i++) g += Math.max(0, sorted[i].laneStart - sorted[i - 1].laneEnd);
  return g;
};

// Ops target a clip by its source item id via source_ref.item_id (matched as
// sourceId); clip_id in params is a composed handle, not the raw source id.
const dec = (action, id, parameters = {}, extra = {}) => ({
  action, label: action, span: {}, source_ref: id ? { source_id: id } : undefined, created_at: '2026-08-05T00:00:00.000Z', parameters, ...extra,
});

test('a non-ripple trim opens a gap (baseline for the fix)', () => {
  // Shorten s1 to 1s in place; s2 stays at laneStart 2 so a 1s gap opens at 1..2.
  const comp = composeTimeline(baseView([dec('trim', 's1', { new_start: 0, new_end: 1 })]));
  assert.ok(gaps(clipsOf(comp)) > 0.9, 'plain trim leaves a gap');
});

test('close-gaps removes every inter-clip gap, preserving each duration + order', () => {
  const comp = composeTimeline(baseView([
    dec('trim', 's1', { new_start: 0, new_end: 1 }),
    dec('close-gaps', null),
  ]));
  const clips = clipsOf(comp).slice().sort((a, b) => a.laneStart - b.laneStart);
  assert.equal(gaps(clips), 0, 'no gaps remain');
  assert.deepEqual(clips.map((c) => c.sourceId), ['s1', 's2', 's3'], 'order preserved');
  // durations preserved: s1=1 (trimmed), s2=2, s3=2 -> [0-1][1-3][3-5]
  assert.deepEqual(clips.map((c) => [c.laneStart, c.laneEnd]), [[0, 1], [1, 3], [3, 5]]);
});

test('close-gaps honors start_at (leave a lead-in before the first clip)', () => {
  const comp = composeTimeline(baseView([dec('close-gaps', null, { start_at: 5 })]));
  const clips = clipsOf(comp).slice().sort((a, b) => a.laneStart - b.laneStart);
  assert.equal(clips[0].laneStart, 5, 'first clip starts at the lead-in');
  assert.equal(gaps(clips), 0, 'still contiguous after the lead-in');
});

test('ripple-trim SHORTER pulls every downstream clip left (no gap)', () => {
  // s1 2s -> 1s (shift -1): s2 2->1..3, s3 4->3..5.
  const comp = composeTimeline(baseView([dec('ripple-trim', 's1', { new_start: 0, new_end: 1 })]));
  const clips = clipsOf(comp).slice().sort((a, b) => a.laneStart - b.laneStart);
  assert.equal(gaps(clips), 0, 'ripple keeps the timeline contiguous');
  assert.deepEqual(clips.map((c) => [c.laneStart, c.laneEnd]), [[0, 1], [1, 3], [3, 5]]);
});

test('ripple-trim LONGER pushes every downstream clip right (no overlap)', () => {
  // s1 2s -> 3s (shift +1): s2 2->3..5, s3 4->5..7.
  const comp = composeTimeline(baseView([dec('ripple-trim', 's1', { new_start: 0, new_end: 3 })]));
  const clips = clipsOf(comp).slice().sort((a, b) => a.laneStart - b.laneStart);
  assert.equal(gaps(clips), 0, 'no gap opens when growing');
  // no overlap: each start >= previous end
  for (let i = 1; i < clips.length; i++) assert.ok(clips[i].laneStart >= clips[i - 1].laneEnd - 1e-9, 'no overlap');
  assert.deepEqual(clips.map((c) => [c.laneStart, c.laneEnd]), [[0, 3], [3, 5], [5, 7]]);
});

test('delete already ripples (ripple-delete confirmed present)', () => {
  // Remove the middle clip; s3 should slide left to fill the 2s hole -> [0-2][2-4].
  const comp = composeTimeline(baseView([dec('delete', 's2')]));
  const clips = clipsOf(comp).slice().sort((a, b) => a.laneStart - b.laneStart);
  assert.equal(clips.length, 2, 's2 removed');
  assert.equal(gaps(clips), 0, 'ripple-delete closed the hole');
  assert.deepEqual(clips.map((c) => c.sourceId), ['s1', 's3']);
});
