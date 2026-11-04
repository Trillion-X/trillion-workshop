// The old app had no test of computer/durable-job.mjs; these check its four invariants as they were written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJobs, job, jobSettings } from '../read-data/durable-job.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const place = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'jobs-')), 'jobs.json');

test('the row runs on the person\'s computer with only the granted folder', () => {
  const [row] = rows;
  assert.equal(row.id, 'tool:job');
  assert.equal(row.invoke.kind, 'computer');
  assert.deepEqual(row.invoke.capabilities, ['change-a-folder']);
  assert.deepEqual(row.invoke.stdin.folder, { fill: { from: 'task', field: 'grants.change-a-folder.folder' } });
  assert.equal(row.result_selector, '$.result');
});

test('starting twice with one key is one job, and its seed and version never change', () => {
  const jobs = createJobs({ file: place() });
  const first = jobs.start({ key: 'sample-meeting', seed: 7, version: 1 });
  const again = jobs.start({ key: 'sample-meeting', seed: 9, version: 2 });
  assert.deepEqual([again.id, again.seed, again.version, again.stream_url], [first.id, 7, 1, first.stream_url]);
  assert.equal(jobs.list().length, 1);
  assert.throws(() => jobs.start({ key: ' ' }), /Give a key/);
});

test('output is numbered and reading from a cursor resumes exactly after it', () => {
  const jobs = createJobs({ file: place() });
  const { id } = jobs.start({ key: 'sample-transcript' });
  for (const piece of ['one', 'two', 'three']) jobs.append(id, piece);
  const all = jobs.read(id, 0);
  assert.deepEqual(all.pieces.map(entry => entry.piece), ['one', 'two', 'three']);
  assert.deepEqual(jobs.read(id, 1).pieces, jobs.read(id, 1).pieces);
  assert.deepEqual(jobs.read(id, 1).pieces.map(entry => entry.seq), [2, 3]);
  assert.equal(jobs.read(id, all.cursor).pieces.length, 0);
});

test('a finished, cancelled or expired job takes no more output, and an expired one cannot be read', () => {
  const clock = { at: Date.parse('2026-11-03T10:00:00Z') };
  const jobs = createJobs({ file: place(), now: () => clock.at });
  const done = jobs.start({ key: 'a' }); jobs.finish(done.id);
  assert.throws(() => jobs.append(done.id, 'x'), error => error.status === 409 && /is done/.test(error.message));
  const cancelled = jobs.start({ key: 'b' }); jobs.cancel(cancelled.id);
  assert.throws(() => jobs.append(cancelled.id, 'x'), /is cancelled/);
  const late = jobs.start({ key: 'c' });
  clock.at += (jobSettings().ttl_seconds + 1) * 1000;
  assert.throws(() => jobs.read(late.id), error => error.status === 410 && /expired/.test(error.message));
  assert.throws(() => jobs.read('nothing'), error => error.status === 404);
});

test('the export keeps jobs in the granted folder and refuses without one', async () => {
  const folder = path.dirname(place());
  const started = await job({ input: { action: 'start', key: 'k' }, folder });
  assert.equal((await job({ input: { action: 'list' }, folder })).jobs[0].id, started.id);
  assert.ok(readFileSync(path.join(folder, 'jobs.json'), 'utf8').includes(started.id));
  await assert.rejects(job({ input: { action: 'list' } }), /Grant a folder/);
});
