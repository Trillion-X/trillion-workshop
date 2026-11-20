/**
 * file: packages/media-composition/do-work/process-scripts/author-concat-edl-cli.test.mjs
 *
 * Tests the DEPLOYABLE author-concat-edl CLI (the compute.process entrypoint for the
 * CJ-B.4 highlight-reel author step) in BOTH invocation forms — positional (local) and
 * --flag (workflow) — proving it emits the exact `video-compose.mjs` render EDL from the
 * `constrained-span-pack` output shape. Runs the SOURCE cli (bundling is a deploy step;
 * the .built.mjs is byte-identical logic).
 */

import { tempFolder } from '../../../../test-helpers/temp-folder.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'author-concat-edl-cli.mjs');
const BASE = '/clips/match.mp4';

// The exact constrained-span-pack .selected shape.
const SELECTED = [
  { id: 'b1', start: 2, end: 4.5, score: 0.95, category: 'bounce' },
  { id: 'b3', start: 18.8, end: 21.8, score: 0.9, category: 'bounce' },
];

test('author-concat-edl CLI — workflow --flag form → clean EDL JSON on stdout', () => {
  const out = execFileSync('node', [
    CLI,
    '--windows-json', JSON.stringify(SELECTED),
    '--base-artifact', BASE,
    '--encode-json', JSON.stringify({ width: 1080, height: 1920, fps: 30 }),
  ], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.segmentCount, 2);
  assert.equal(r.edl.base.artifact, BASE);
  assert.deepEqual(r.edl.spine.segments.map((s) => [s.kind, s.src_in]), [['base_span', 2], ['base_span', 18.8]]);
  assert.deepEqual(r.edl.encode, { width: 1080, height: 1920, fps: 30 });
  assert.equal(r.totalDurationS, 5.5);
});

test('author-concat-edl CLI — positional (local) form <windows.json> <base> → same EDL', () => {
  const dir = tempFolder(join(tmpdir(), 'author-edl-'));
  const wf = join(dir, 'windows.json');
  writeFileSync(wf, JSON.stringify(SELECTED));
  const out = execFileSync('node', [CLI, wf, BASE], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.segmentCount, 2);
  assert.equal(r.edl.spine.segments[0].kind, 'base_span');
});

test('author-concat-edl CLI — --output-json writes the result to a file (workflow return-binding form)', () => {
  const dir = tempFolder(join(tmpdir(), 'author-edl-'));
  const outFile = join(dir, 'edl.json');
  execFileSync('node', [CLI, '--windows-json', JSON.stringify(SELECTED), '--base-artifact', BASE, '--output-json', outFile], { encoding: 'utf8' });
  const r = JSON.parse(execFileSync('cat', [outFile], { encoding: 'utf8' }));
  assert.equal(r.segmentCount, 2);
  assert.equal(r.edl.base.artifact, BASE);
});
