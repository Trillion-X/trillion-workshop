/**
 * #72 Overlays: add-overlay decisions (title / lower-third text + arrow-callout image) collect
 * onto the composition and materialize into edl.text_overlays + edl.image_overlays, which
 * video-compose composites (drawtext + image overlay). The generic render composite is proven
 * offline; this proves the DATA authoring seam.
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let composeTimeline, materializeExportEdl;

before(async () => {
  const dir = tempFolder(join(tmpdir(), 'overlays-'));
  const ctOut = join(dir, 'ct.mjs');
  const meOut = join(dir, 'me.mjs');
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ctOut}`], { encoding: 'utf8' });
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'materialize-edl.ts'), `--outfile=${meOut}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ctOut));
  ({ materializeExportEdl } = await import(meOut));
});

const dec = (parameters) => ({ action: 'add-overlay', label: 'add-overlay', span: {}, source_ref: {}, created_at: '2026-08-05T00:00:00.000Z', parameters });

test('add-overlay collects text + image overlays onto the composition', () => {
  const view = {
    lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4' } }] }],
    editDecisions: [
      dec({ overlay_kind: 'text', text: 'Rosa Example', x: 80, y: 'H-h-80', size: 42, box: true, start: 1, end: 3 }), // lower-third title
      dec({ overlay_kind: 'image', image_path: '/tmp/arrow.png', x: 500, y: 200, rotate: 0.6, opacity: 0.9, start: 2, end: 5 }), // arrow callout
    ],
    markers: [],
  };
  const comp = composeTimeline(view);
  assert.equal(comp.overlays.length, 2, 'both overlays collected');
  assert.equal(comp.overlays[0].overlay_kind, 'text');
  assert.equal(comp.overlays[0].y, 'H-h-80', 'position expr preserved');
  assert.equal(comp.overlays[1].overlay_kind, 'image');
  assert.equal(comp.overlays[1].rotate, 0.6);
});

test('materializeExportEdl splits overlays into text_overlays + image_overlays', () => {
  const view = {
    lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4' } }] }],
    editDecisions: [
      dec({ overlay_kind: 'text', text: 'Title', x: 40, y: 40, start: 0, end: 2 }),
      dec({ overlay_kind: 'image', image_path: '/tmp/arrow.png', x: 10, y: 10, start: 1, end: 4 }),
    ],
    markers: [],
  };
  const comp = composeTimeline(view);
  const { edl } = materializeExportEdl(comp, () => 'clip.mp4', { width: 1280, height: 720 });
  assert.equal(edl.text_overlays.length, 1, 'one text overlay in EDL');
  assert.equal(edl.text_overlays[0].text, 'Title');
  assert.equal(edl.image_overlays.length, 1, 'one image overlay in EDL');
  assert.equal(edl.image_overlays[0].image_path, '/tmp/arrow.png');
  assert.equal(edl.image_overlays[0].start, 1);
});
