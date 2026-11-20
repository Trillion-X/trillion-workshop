/**
 * #100 Per-clip audio effect chain. Proves the opaque-filter DATA seam: an `audio_filters` string (or
 * an `audio_fx` catalog key) resolves onto the clip transform and materializes onto the EDL clip as
 * `audio_filters`, which video-compose appends blind to the clip's audio chain (the audio twin of #73
 * grade). No engine code per effect: EQ/compressor/de-reverb/de-esser are all DATA.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline, materializeExportEdl, AUDIO_FX_CATALOG;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'afx-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs'); const me = join(dir, 'me.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${me}`], { encoding: 'utf8' });
  ({ composeTimeline, AUDIO_FX_CATALOG } = await import(ct));
  ({ materializeExportEdl } = await import(me));
});

// A clip carrying an audio_fx params via add-source (extractTransform resolves the catalog key).
const viewWith = (params) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [
    { item_id: 'c1', label: 'Clip', start: 0, end: 5, source_ref: { artifact_ref: 'c.mp4', source_id: 'c1' }, ...params },
  ] }],
  editDecisions: [],
  markers: [],
});

test('a freeform audio_filters string resolves onto the clip transform', () => {
  const comp = composeTimeline({
    ...viewWith({}),
    editDecisions: [{ action: 'set-transform', source_ref: { source_id: 'c1' }, parameters: {audio_filters: 'lowpass=f=300' }, created_at: 'x' }],
  });
  const clip = comp.lanes.find((l) => l.role === 'video').clips[0];
  assert.equal(clip.transform.audioFilters, 'lowpass=f=300');
});

test('an audio_fx catalog key resolves to its opaque chain', () => {
  const comp = composeTimeline({
    ...viewWith({}),
    editDecisions: [{ action: 'set-transform', source_ref: { source_id: 'c1' }, parameters: {audio_fx: 'studio-sound' }, created_at: 'x' }],
  });
  const clip = comp.lanes.find((l) => l.role === 'video').clips[0];
  assert.equal(clip.transform.audioFilters, AUDIO_FX_CATALOG['studio-sound']);
  assert.ok(clip.transform.audioFilters.includes('acompressor'), 'studio-sound has a compressor');
});

test('materialize emits audio_filters (snake_case) onto the EDL clip', () => {
  const comp = composeTimeline({
    ...viewWith({}),
    editDecisions: [{ action: 'set-transform', source_ref: { source_id: 'c1' }, parameters: {audio_filters: 'equalizer=f=1000:t=q:w=2:g=-30' }, created_at: 'x' }],
  });
  const { edl } = materializeExportEdl(comp, () => 'c.mp4', {});
  const seg = edl.spine.segments[0];
  assert.equal(seg.audio_filters, 'equalizer=f=1000:t=q:w=2:g=-30');
});
