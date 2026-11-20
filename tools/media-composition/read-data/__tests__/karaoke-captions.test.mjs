/**
 * #80 Karaoke word-highlight captions. The #77 caption fold gains a `reveal` DATA knob:
 *  - 'line' (default) = the whole line shows at once (existing behavior, unchanged).
 *  - 'word' = one word at a time, each gated to its own [start,end] in `active_color`.
 * Same timed text-overlay render (drawtext + enable=between), just different DATA windows (L090).
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline, groupWordsIntoCaptionLines;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'karaoke-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const cl = join(dir, 'cl.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'caption-lines.ts'), `--outfile=${cl}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ groupWordsIntoCaptionLines } = await import(cl));
});

const WORDS = [
  { text: 'hit', start: 0.0, end: 0.4 },
  { text: 'the', start: 0.4, end: 0.7 },
  { text: 'ball', start: 0.7, end: 1.2 },
];
const clip = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: decisions, markers: [],
});
const addCaptions = (style) => {
  const lines = groupWordsIntoCaptionLines(WORDS);
  return { action: 'add-captions', label: 'Captions', span: {}, source_ref: {}, created_at: '2026-08-05T00:00:00.000Z', parameters: { lines, style } };
};

test('groupWordsIntoCaptionLines carries per-word timing on each line', () => {
  const lines = groupWordsIntoCaptionLines(WORDS);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].words.length, 3);
  assert.deepEqual(lines[0].words.map((w) => w.text), ['hit', 'the', 'ball']);
});

test("reveal 'line' (default) emits ONE overlay for the whole line", () => {
  const comp = composeTimeline(clip([addCaptions({})]));
  const texts = comp.overlays.filter((o) => o.overlay_kind === 'text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, 'hit the ball');
  assert.equal(texts[0].start, 0.0);
  assert.equal(texts[0].end, 1.2);
});

test("reveal 'word' emits one accent overlay PER WORD, each gated to its own window", () => {
  const comp = composeTimeline(clip([addCaptions({ reveal: 'word' })]));
  const texts = comp.overlays.filter((o) => o.overlay_kind === 'text');
  assert.equal(texts.length, 3, 'one overlay per spoken word');
  assert.deepEqual(texts.map((o) => o.text), ['hit', 'the', 'ball']);
  // each word is timed to itself, so at any instant only one is on screen
  assert.deepEqual(texts.map((o) => [o.start, o.end]), [[0.0, 0.4], [0.4, 0.7], [0.7, 1.2]]);
  for (const o of texts) assert.equal(o.color, 'yellow', 'active word uses the accent color');
});

test('active_color overrides the karaoke highlight color', () => {
  const comp = composeTimeline(clip([addCaptions({ reveal: 'word', active_color: '#00e5ff' })]));
  const texts = comp.overlays.filter((o) => o.overlay_kind === 'text');
  for (const o of texts) assert.equal(o.color, '#00e5ff');
});

test('at a given time exactly one karaoke word is active (windows do not overlap)', () => {
  const comp = composeTimeline(clip([addCaptions({ reveal: 'word' })]));
  const texts = comp.overlays.filter((o) => o.overlay_kind === 'text');
  const at = (t) => texts.filter((o) => t >= o.start && t < o.end).map((o) => o.text);
  assert.deepEqual(at(0.2), ['hit']);
  assert.deepEqual(at(0.5), ['the']);
  assert.deepEqual(at(1.0), ['ball']);
});
