/**
 * A decision the fold cannot apply is said, never dropped without a word: composeTimeline lists every decision that
 * changed nothing (an overlay_kind it does not draw, an action no fold knows) in `unapplied`, and leaves it out when
 * every decision applied.
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
  const dir = tempFolder(join(tmpdir(), 'unapplied-'));
  const alias = '--alias:@=' + join(here, '..', '..', '..', '..');
  const ct = join(dir, 'ct.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', alias, join(here, '..', 'compose-timeline.ts'), `--outfile=${ct}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(ct));
});

const view = (decisions) => ({
  lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items: [{ item_id: 's1', label: 'Main', start: 0, end: 4, source_ref: { artifact_ref: 'clip.mp4', source_id: 's1' } }] }],
  editDecisions: decisions.map((decision, i) => ({ span: {}, source_ref: { item_id: 's1' }, created_at: `2026-08-05T00:00:0${i}.000Z`, ...decision })),
  markers: [],
});

test('every decision applied: no unapplied list', () => {
  const comp = composeTimeline(view([{ decision_id: 'd1', action: 'add-overlay', parameters: { overlay_kind: 'text', text: 'Hello' } }]));
  assert.equal(comp.overlays.length, 1);
  assert.equal('unapplied' in comp, false);
});

test('an overlay kind the compositor does not draw and an unknown action are listed, the rest still applies', () => {
  const comp = composeTimeline(view([
    { decision_id: 'd1', action: 'add-overlay', parameters: { overlay_kind: 'hologram', text: 'Hi' } },
    { decision_id: 'd2', action: 'add-overlay', parameters: { overlay_kind: 'text', text: 'Shown' } },
    { decision_id: 'd3', action: 'make-it-pop', parameters: {} },
  ]));
  assert.deepEqual(comp.overlays.map((overlay) => overlay.text), ['Shown']);
  assert.deepEqual(comp.unapplied, [{ index: 0, decision_id: 'd1', action: 'add-overlay' }, { index: 2, decision_id: 'd3', action: 'make-it-pop' }]);
});
