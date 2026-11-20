/**
 * #98 Auto-highlight / auto-shorts. Proves the pure core: (1) scoreHighlightWindows finds the
 * high-energy run in a transcript, (2) highlightDecisions emits the complement remove-span gaps
 * authored last-first, and (3) those decisions fold through composeTimeline to leave ONLY the
 * highlight window on the timeline (the long recording trimmed down to the short).
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline, scoreHighlightWindows, highlightDecisions;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'hl-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const hs = join(dir, 'hs.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'highlight-scorer.ts'), `--outfile=${hs}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ scoreHighlightWindows, highlightDecisions } = await import(hs));
});

// 10 one-second segments; the middle run [4,7) is loud, everything else is quiet.
const segments = Array.from({ length: 10 }, (_, i) => ({
  start: i, end: i + 1, text: `sentence ${i}`, energy: i >= 4 && i < 7 ? 0.95 : 0.15,
}));

test('scoreHighlightWindows finds the loud run as the top window', () => {
  const windows = scoreHighlightWindows(segments, { count: 1 });
  assert.equal(windows.length, 1, 'one highlight');
  assert.equal(windows[0].start, 4);
  assert.equal(windows[0].end, 7);
});

test('highlightDecisions emits the complement gaps, last-gap-first', () => {
  const decisions = highlightDecisions([{ start: 4, end: 7, score: 1 }], {
    totalDuration: 10, sourceRef: { source_id: 's1' }, createdAt: '2026-08-05T00:00:00.000Z',
  });
  assert.equal(decisions.length, 2, 'a head gap and a tail gap');
  assert.equal(decisions[0].action, 'remove-span');
  // last gap first: [7,10] before [0,4] so ripple-left keeps the head coords valid.
  assert.deepEqual(decisions[0].parameters, { start: 7, end: 10 });
  assert.deepEqual(decisions[1].parameters, { start: 0, end: 4 });
});

test('folding the highlight decisions trims the timeline to just the window', () => {
  const windows = scoreHighlightWindows(segments, { count: 1 });
  const decisions = highlightDecisions(windows, {
    totalDuration: 10, sourceRef: { source_id: 's1' }, createdAt: '2026-08-05T00:00:00.000Z',
  });
  const view = {
    lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
      { item_id: 's1', label: 'Talk', start: 0, end: 10, source_ref: { artifact_ref: 'talk.mp4', source_id: 's1' } },
    ] }],
    editDecisions: decisions,
    markers: [],
  };
  const comp = composeTimeline(view);
  const videoLane = comp.lanes.find((l) => l.role === 'video');
  const total = videoLane.clips.reduce((n, c) => n + (c.laneEnd - c.laneStart), 0);
  assert.ok(Math.abs(total - 3) < 1e-6, `only the 3s highlight remains, got ${total}`);
  const first = videoLane.clips[0];
  assert.ok(Math.abs(first.laneStart - 0) < 1e-6, 'the highlight is rippled to start at 0');
});

test('an empty transcript yields no windows and no decisions', () => {
  assert.deepEqual(scoreHighlightWindows([], { count: 3 }), []);
  assert.deepEqual(highlightDecisions([], { totalDuration: 10, sourceRef: {}, createdAt: 'x' }), []);
});
