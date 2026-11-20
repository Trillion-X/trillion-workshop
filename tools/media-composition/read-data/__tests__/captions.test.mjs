/**
 * #77 Burn-in captions from transcript.
 *  - groupWordsIntoCaptionLines: pure grouping of transcript words into timed lines, bounded
 *    by maxWords / maxChars / maxGap (DATA knobs), each line spanning first-start..last-end.
 *  - add-captions fold: expands a DATA `lines` array into one timed text overlay per line,
 *    sharing a `style`; materialize emits them as text_overlays that the render burns.
 * The actual burned caption at the right time is proven by the offline render.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline, materializeExportEdl, groupWordsIntoCaptionLines;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'captions-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs'); const cl = join(dir, 'cl.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'caption-lines.ts'), `--outfile=${cl}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
  ({ groupWordsIntoCaptionLines } = await import(cl));
});

const words = (n) => Array.from({ length: n }, (_, i) => ({ text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }));

test('grouping breaks lines at maxWords', () => {
  const lines = groupWordsIntoCaptionLines(words(10), { maxWords: 4, maxChars: 999, maxGap: 999 });
  assert.equal(lines.length, 3, '10 words / 4 per line = 3 lines');
  assert.equal(lines[0].text, 'w0 w1 w2 w3');
  assert.equal(lines[0].start, 0);
  assert.equal(lines[0].end, 1.9, 'line window = first start .. last end');
});

test('grouping breaks on a silence gap', () => {
  const ws = [
    { text: 'hello', start: 0, end: 0.4 },
    { text: 'there', start: 0.5, end: 0.9 },
    // 2s gap -> new line
    { text: 'again', start: 3.0, end: 3.4 },
  ];
  const lines = groupWordsIntoCaptionLines(ws, { maxWords: 99, maxChars: 999, maxGap: 0.6 });
  assert.equal(lines.length, 2, 'the gap forces a break');
  assert.equal(lines[0].text, 'hello there');
  assert.equal(lines[1].text, 'again');
});

test('grouping skips empty / malformed words', () => {
  const ws = [{ text: '  ', start: 0, end: 1 }, { text: 'ok', start: 1, end: 2 }, { text: 'x', start: NaN, end: 3 }];
  const lines = groupWordsIntoCaptionLines(ws);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'ok');
});

const captionView = (lines, style) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 5, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: [{ action: 'add-captions', label: 'Add captions', span: {}, source_ref: { source_id: 's1' }, created_at: '2026-08-05T00:00:00.000Z', parameters: { lines, style: style ?? {} } }],
  markers: [],
});

test('add-captions expands lines into one timed text overlay each', () => {
  const lines = [{ text: 'first line', start: 0, end: 1.5 }, { text: 'second line', start: 1.5, end: 3 }];
  const comp = composeTimeline(captionView(lines));
  const caps = comp.overlays.filter((o) => o.overlay_kind === 'text');
  assert.equal(caps.length, 2);
  assert.equal(caps[0].text, 'first line');
  assert.equal(caps[0].start, 0);
  assert.equal(caps[0].end, 1.5);
  assert.equal(caps[1].text, 'second line');
  // default centered-bottom + boxed
  assert.equal(caps[0].x, 0.5);
  assert.equal(caps[0].y, 0.9);
  assert.equal(caps[0].box, true);
});

test('add-captions honors a style DATA row', () => {
  const comp = composeTimeline(captionView([{ text: 'styled', start: 0, end: 1 }], { size: 30, color: 'yellow', y: 0.5, box: false, fade_in: 0.2 }));
  const c = comp.overlays.find((o) => o.overlay_kind === 'text');
  assert.equal(c.size, 30);
  assert.equal(c.color, 'yellow');
  assert.equal(c.y, 0.5);
  assert.equal(c.box, false);
  assert.equal(c.fade_in, 0.2);
});

test('add-captions drops malformed lines (no text / no timing)', () => {
  const comp = composeTimeline(captionView([{ text: '', start: 0, end: 1 }, { text: 'ok', start: 1, end: 2 }, { text: 'notime' }]));
  const caps = comp.overlays.filter((o) => o.overlay_kind === 'text');
  assert.equal(caps.length, 1);
  assert.equal(caps[0].text, 'ok');
});

test('materialize emits captions as EDL text_overlays', () => {
  const comp = composeTimeline(captionView([{ text: 'hi', start: 0.5, end: 2 }]));
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 640, height: 360 });
  assert.ok(Array.isArray(edl.text_overlays) && edl.text_overlays.length === 1, 'one text overlay in the EDL');
  assert.equal(edl.text_overlays[0].text, 'hi');
  assert.equal(edl.text_overlays[0].start, 0.5);
  assert.equal(edl.text_overlays[0].end, 2);
});
