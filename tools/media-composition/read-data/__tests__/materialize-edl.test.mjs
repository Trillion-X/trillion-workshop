/**
 * file: packages/media-composition/read-data/__tests__/materialize-edl.test.mjs
 *
 * SSOT test (plan 2026-07-18 T2): the export EDL is derived from the SAME
 * MaterializedComposition the preview consumes, byte-identically for the same
 * fold. The TS module is bundled on the fly with esbuild (node:test runner —
 * the package has no TS test harness).
 */
import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let materializeExportEdl;
before(async () => {
  const out = join(tempFolder(join(tmpdir(), 'medl-')), 'materialize-edl.mjs');
  execFileSync('npx', ['esbuild', '--bundle', '--format=esm', join(here, '..', 'materialize-edl.ts'), `--outfile=${out}`], { encoding: 'utf8' });
  ({ materializeExportEdl } = await import(out));
});

const clip = (id, sourceId, overrides = {}) => ({
  clipId: id, sourceId, laneRole: 'video', label: id,
  inPoint: 0, outPoint: 3, laneStart: 0, laneEnd: 3, transform: {}, ...overrides,
});
const comp = (lanes) => ({ lanes, durationSeconds: 3, markers: [], globalTransform: {} });
const lane = (laneId, clips) => ({ laneId, role: 'video', label: laneId, tone: 'source', clips, duration: 3 });

test('deterministic: same fold -> byte-identical EDL (preview/export SSOT)', () => {
  const composition = comp([lane('l1', [clip('a', 's1'), clip('b', 's2', { laneStart: 3, laneEnd: 6 })])]);
  const resolve = (id) => `/cas/${id}`;
  const one = JSON.stringify(materializeExportEdl(composition, resolve).edl);
  const two = JSON.stringify(materializeExportEdl(composition, resolve).edl);
  assert.equal(one, two);
});

test('clips ordered by laneStart within lane order; property grammar passes through verbatim', () => {
  const composition = comp([lane('l1', [
    clip('late', 's1', { laneStart: 5, laneEnd: 8 }),
    clip('early', 's2', { laneStart: 0, laneEnd: 3, transform: { speed: 2, flip: 'h', keyframes: { opacity: [{ t: 0, value: 1 }] } } }),
  ])]);
  const { edl } = materializeExportEdl(composition, (id) => `/cas/${id}`);
  assert.deepEqual(edl.spine.segments.map((s) => s.id), ['early', 'late']);
  const early = edl.spine.segments[0];
  assert.equal(early.speed, 2);
  assert.equal(early.flip, 'h');
  assert.deepEqual(early.keyframes, { opacity: [{ t: 0, value: 1 }] });
});

test('unresolved sources are REPORTED, never silently dropped', () => {
  const composition = comp([lane('l1', [clip('a', 'known'), clip('b', 'missing')])]);
  const { edl, unresolvedSourceIds } = materializeExportEdl(composition, (id) => (id === 'known' ? '/cas/known' : null));
  assert.deepEqual(unresolvedSourceIds, ['missing']);
  assert.equal(edl.spine.segments.length, 1);
});

test('zero-duration clips and empty lanes are excluded; tracks mirror contributing lanes', () => {
  const composition = comp([
    lane('empty', []),
    lane('l1', [clip('z', 's1', { inPoint: 2, outPoint: 2 }), clip('ok', 's2')]),
  ]);
  const { edl } = materializeExportEdl(composition, (id) => `/cas/${id}`);
  assert.deepEqual(edl.tracks, [{ id: 'l1' }]);
  assert.deepEqual(edl.spine.segments.map((s) => s.id), ['ok']);
  assert.equal(edl.spine.segments[0].track_id, 'l1');
});

test('encode row passes through as DATA', () => {
  const { edl } = materializeExportEdl(comp([lane('l1', [clip('a', 's1')])]), (id) => id, { width: 1080, height: 1920 });
  assert.deepEqual(edl.encode, { width: 1080, height: 1920 });
});
