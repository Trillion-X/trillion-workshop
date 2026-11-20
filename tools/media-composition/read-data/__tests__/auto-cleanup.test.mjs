/**
 * #69 Descript-class auto-cleanup: detectCleanupSpans finds silence gaps + filler
 * words, and the resulting remove-span decisions (authored right-to-left) shorten the
 * composition by exactly the removed total through composeTimeline.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let detectCleanupSpans, cleanupSpansInAuthorOrder, composeTimeline;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'cleanup-'));
  const acOut = join(dir, 'ac.mjs');
  const ctOut = join(dir, 'ct.mjs');
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'auto-cleanup.ts'), `--outfile=${acOut}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ctOut}`], { encoding: 'utf8' });
  ({ detectCleanupSpans, cleanupSpansInAuthorOrder } = await import(acOut));
  ({ composeTimeline } = await import(ctOut));
});

// words: "hello" 0-1, [2s SILENCE], "world" 3-4, "um" 4-4.5, "there" 5-6
const WORDS = [
  { text: 'Hello', start: 0, end: 1 },
  { text: 'world', start: 3, end: 4 },
  { text: 'um', start: 4, end: 4.5 },
  { text: 'there', start: 5, end: 6 },
];

test('detects the silence gap and the filler word', () => {
  const spans = detectCleanupSpans(WORDS, { minSilence: 0.6, silencePad: 0, fillers: ['um'] });
  const silence = spans.find((s) => s.reason === 'silence');
  const filler = spans.find((s) => s.reason === 'filler');
  assert.ok(silence, 'a silence span exists');
  assert.deepEqual([silence.start, silence.end], [1, 3], 'silence spans the 1..3 gap');
  assert.ok(filler, 'a filler span exists');
  assert.deepEqual([filler.start, filler.end], [4, 4.5], 'filler spans the um');
});

test('silencePad keeps breathing room', () => {
  const [s] = detectCleanupSpans(WORDS, { minSilence: 0.6, silencePad: 0.25, removeFillers: false });
  assert.deepEqual([s.start, s.end], [1.25, 2.75], 'pad shrinks the cut at both edges');
});

test('author order is right-to-left so ripples never invalidate coordinates', () => {
  const spans = detectCleanupSpans(WORDS, { minSilence: 0.6, silencePad: 0, fillers: ['um'] });
  const ordered = cleanupSpansInAuthorOrder(spans);
  for (let i = 0; i < ordered.length - 1; i += 1) {
    assert.ok(ordered[i].start >= ordered[i + 1].start, 'descending by start');
  }
});

test('applying the remove-span decisions shortens the composition by the removed total', () => {
  const spans = detectCleanupSpans(WORDS, { minSilence: 0.6, silencePad: 0, fillers: ['um'] });
  const removed = spans.reduce((sum, s) => sum + (s.end - s.start), 0); // 2.0 (silence) + 0.5 (um) = 2.5
  const decisions = cleanupSpansInAuthorOrder(spans).map((s) => ({
    action: 'remove-span', parameters: { start: s.start, end: s.end }, span: {}, source_ref: {}, created_at: '2026-08-05T00:00:00.000Z', label: 'remove-span',
  }));
  const view = { lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 6 }] }], editDecisions: decisions, markers: [] };
  const comp = composeTimeline(view);
  assert.equal(Math.round(comp.durationSeconds * 1000), Math.round((6 - removed) * 1000), 'duration shrank by exactly the removed total');
});
