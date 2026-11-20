/**
 * #99 TTS narration track. Proves the DATA chain: a narrationAddSourceDecision folds through
 * composeTimeline into an audio clip carrying transform.narration, and materializeExportEdl routes
 * it to edl.audio_graph.narration[] (placed at its start, NOT a video spine segment).
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline, materializeExportEdl, narrationAddSourceDecision;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'narr-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs'); const ns = join(dir, 'ns.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'narration-source.ts'), `--outfile=${ns}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
  ({ materializeExportEdl } = await import(me));
  ({ narrationAddSourceDecision } = await import(ns));
});

const baseView = (extraDecisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 'v1', label: 'Clip', start: 0, end: 8, source_ref: { artifact_ref: 'v.mp4', source_id: 'v1' } },
  ] }],
  editDecisions: extraDecisions,
  markers: [],
});

test('narration decision folds into an audio clip carrying transform.narration', () => {
  const d = narrationAddSourceDecision({ sourceId: 'nar1', artifactRef: 'narr.wav', startSeconds: 3, durationSeconds: 4, createdAt: 'x' });
  const comp = composeTimeline(baseView([d]));
  const narLane = comp.lanes.find((l) => l.role === 'narration');
  assert.ok(narLane, 'a narration lane exists');
  assert.equal(narLane.clips.length, 1);
  assert.equal(narLane.clips[0].transform.narration, true);
  assert.ok(Math.abs(narLane.clips[0].laneStart - 3) < 1e-6, 'placed at start 3s');
});

test('materialize routes the narration to audio_graph.narration, not the video spine', () => {
  const d = narrationAddSourceDecision({ sourceId: 'nar1', artifactRef: 'narr.wav', startSeconds: 3, durationSeconds: 4, volume: 0.9, createdAt: 'x' });
  const comp = composeTimeline(baseView([d]));
  const { edl } = materializeExportEdl(comp, (id) => (id === 'v1' ? 'v.mp4' : 'narr.wav'), { width: 320, height: 240 });
  assert.ok(edl.audio_graph && Array.isArray(edl.audio_graph.narration), 'audio_graph.narration exists');
  assert.equal(edl.audio_graph.narration.length, 1);
  const n = edl.audio_graph.narration[0];
  assert.equal(n.artifact, 'narr.wav');
  assert.equal(n.start, 3);
  assert.equal(n.out, 4);
  assert.equal(n.volume, 0.9);
  // The narration is NOT a video spine segment (the spine is only the video clip).
  const spineSources = edl.spine.segments.map((s) => s.source);
  assert.ok(!spineSources.includes('narr.wav'), 'narration is not in the video spine');
});

test('multiple narration clips all route to the audio graph', () => {
  const d1 = narrationAddSourceDecision({ sourceId: 'n1', artifactRef: 'a.wav', startSeconds: 0, durationSeconds: 2, createdAt: 'x' });
  const d2 = narrationAddSourceDecision({ sourceId: 'n2', artifactRef: 'b.wav', startSeconds: 5, durationSeconds: 2, createdAt: 'x' });
  const comp = composeTimeline(baseView([d1, d2]));
  const { edl } = materializeExportEdl(comp, (id) => `${id}.wav`, {});
  assert.equal(edl.audio_graph.narration.length, 2);
});
