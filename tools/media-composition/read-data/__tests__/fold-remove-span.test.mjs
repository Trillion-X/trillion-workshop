/**
 * file: packages/media-composition/read-data/__tests__/fold-remove-span.test.mjs
 *
 * W6 Unit 2 reducer support: `remove-span` is the atomic transcript-edit fold.
 * Proves the fold APPLIES end-to-end through composeTimeline (so materialize-edl
 * — which reads composeTimeline output — renders the shortened video for free):
 *   - a mid-clip cut shortens total duration by exactly the removed length and
 *     maps the surviving footage's source in/out proportionally,
 *   - a cut inside a later clip ripples earlier/later clips correctly,
 *   - unknown lane_role scopes the cut,
 *   - a zero/negative span is a no-op (never throws).
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
  const out = join(tempFolder(join(tmpdir(), 'rmspan-')), 'c.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm',
    '--alias:@=' + join(here, '..', '..', '..', '..'),
    join(here, '..', 'compose-timeline.ts'), `--outfile=${out}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(out));
});

// One 10s clip on the "video" lane (source 0..10 → timeline 0..10).
function viewWith(decisions, items = [{ item_id: 's1', label: 'Main', start: 0, end: 10 }]) {
  return {
    lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items }],
    editDecisions: decisions,
    markers: [],
  };
}
const dec = (action, parameters, span, at = '2026-07-23T00:00:00.000Z') =>
  ({ action, parameters, span: span ?? {}, source_ref: {}, created_at: at, label: action });

test('mid-clip remove-span shortens duration by the removed length + splits into two clips', () => {
  // remove [4,6] → 2s gone, total 10 → 8s.
  const comp = composeTimeline(viewWith([dec('remove-span', { start: 4, end: 6 })]));
  assert.equal(Math.round(comp.durationSeconds * 1000), 8000);
  const clips = comp.lanes[0].clips;
  assert.equal(clips.length, 2, 'left [0,4] + right shifted to [4,8]');
  const [left, right] = clips.sort((a, b) => a.laneStart - b.laneStart);
  assert.deepEqual([left.laneStart, left.laneEnd], [0, 4]);
  assert.deepEqual([left.inPoint, left.outPoint], [0, 4], 'left source range preserved');
  assert.deepEqual([right.laneStart, right.laneEnd], [4, 8], 'right rippled left by 2s');
  assert.deepEqual([right.inPoint, right.outPoint], [6, 10], 'right source range starts at 6');
});

test('remove-span via span field (no params start/end) also applies', () => {
  const comp = composeTimeline(viewWith([dec('remove-span', {}, { start: 0, end: 3 })]));
  assert.equal(Math.round(comp.durationSeconds * 1000), 7000);
  const clip = comp.lanes[0].clips[0];
  assert.deepEqual([clip.laneStart, clip.laneEnd], [0, 7]);
  assert.deepEqual([clip.inPoint, clip.outPoint], [3, 10]);
});

test('lane_role scopes the cut; other lanes untouched', () => {
  const view = {
    lanes: [
      { lane_id: 'video', role: 'video', label: 'V', items: [{ item_id: 's1', label: 'V', start: 0, end: 10 }] },
      { lane_id: 'audio', role: 'audio', label: 'A', items: [{ item_id: 's2', label: 'A', start: 0, end: 10 }] },
    ],
    editDecisions: [dec('remove-span', { start: 2, end: 4, lane_role: 'video' })],
    markers: [],
  };
  const comp = composeTimeline(view);
  const audioLane = comp.lanes.find((l) => l.role === 'audio');
  assert.equal(audioLane.duration, 10, 'audio lane untouched');
});

test('zero/negative span is a no-op, never throws', () => {
  const comp = composeTimeline(viewWith([dec('remove-span', { start: 5, end: 5 })]));
  assert.equal(comp.durationSeconds, 10);
});
