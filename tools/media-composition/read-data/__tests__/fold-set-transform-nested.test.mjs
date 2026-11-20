/**
 * Proves foldSetTransform extracts the NESTED `transform` object param (the shape
 * the set-transform op-schema declares + the inspector authors). Before the fix,
 * extractTransform read flat params and the whole inspector folded to a no-op.
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
  const out = join(tempFolder(join(tmpdir(), 'settx-')), 'c.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm',
    '--alias:@=' + join(here, '..', '..', '..', '..'),
    join(here, '..', 'compose-timeline.ts'), `--outfile=${out}`], { encoding: 'utf8' });
  ({ composeTimeline } = await import(out));
});
const viewWith = (decisions, items = [{ item_id: 's1', label: 'Main', start: 0, end: 10 }]) =>
  ({ lanes: [{ lane_id: 'video', role: 'video', label: 'Video', items }], editDecisions: decisions, markers: [] });
const dec = (action, parameters) => ({ action, parameters, span: {}, source_ref: {}, created_at: '2026-08-05T00:00:00.000Z', label: action });

test('global set-transform extracts NESTED transform.speed', () => {
  const comp = composeTimeline(viewWith([dec('set-transform', { transform: { speed: 0.5, volume: 0.8 } })]));
  assert.equal(comp.globalTransform?.speed, 0.5, 'nested speed extracted');
  assert.equal(comp.globalTransform?.volume, 0.8, 'nested volume extracted');
});

test('flat params still work (legacy/global caller)', () => {
  const comp = composeTimeline(viewWith([dec('set-transform', { speed: 2, global: true })]));
  assert.equal(comp.globalTransform?.speed, 2, 'flat speed still extracted');
});
