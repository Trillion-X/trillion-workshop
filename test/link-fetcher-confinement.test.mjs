// The original confined-run link-reader integration, now at the repository QA owner because it joins two tools.
// Keep every original assertion: actual Seatbelt writes are allowed inside the workspace and refused outside it,
// while the explicit disabled switch preserves the unconfined call. No source under test executes on import.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFetcher } from '../tools/audio-transcription/read-data/hear-here.mjs';
import { runConfined } from '../tools/run-on-a-persons-computer/confined-run.mjs';

const mac = { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') };

test('the link reader runs confined when the DATA switch is on, and as before when it is off', mac, async t => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), 'confined-link-reader-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = join(base, 'work'), outside = join(base, 'outside');
  await mkdir(workspace); await mkdir(outside);
  const row = part => ({ check: ['x'], info: ['/bin/sh', '-c', part] });
  const on = { enabled: true, tier: 'workspace-online' };
  assert.equal((await runFetcher(row(`echo fetched > {folder}/page.vtt; echo ok`), 'info', { folder: workspace }, 20, on, runConfined)).trim(), 'ok');
  assert.equal((await readFile(join(workspace, 'page.vtt'), 'utf8')).trim(), 'fetched');
  await assert.rejects(runFetcher(row(`echo bad > ${outside}/x && echo ok`), 'info', { folder: workspace }, 20, on, runConfined), error => /Operation not permitted/.test(error.message));
  assert.equal((await runFetcher(row(`echo bad > ${outside}/x && echo ok`), 'info', { folder: workspace }, 20, { enabled: false })).trim(), 'ok');
  assert.equal(await readFile(join(outside, 'x'), 'utf8'), 'bad\n');
});
