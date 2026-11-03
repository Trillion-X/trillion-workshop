// tools/media-composition/test/stream-core.test.mjs
//
// The stream detector (do-work/stream-core.mjs, its encoder do-work/stream-features.mjs, its detector row in
// read-data/detect-events.json): state carried explicitly, heads as rows, and the whole path through detect-events on a real clip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newState, run, step } from '../do-work/stream-core.mjs';
import settings from '../read-data/detect-events.json' with { type: 'json' };
import { detectEvents } from '../do-work/detect-events.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const config = settings.streams['sound-and-motion'];
const quiet = Array.from({ length: 60 }, (_, at) => ({ t: at * 0.1, sound: 0.02 + (at % 3) * 0.005, motion: 0.1 }));
const withHit = at => quiet.map((frame, index) => (index === at ? { ...frame, sound: 1, motion: 0.8 } : frame));

test('a frame far above the baseline so far is an event; nothing is made while warming or from a flat stream', () => {
  assert.deepEqual(run(config, quiet).events, []);
  assert.deepEqual(run(config, withHit(5)).events, [], 'inside the warm-up the baseline is not known yet');
  const found = run(config, withHit(40)).events;
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'stroke');
  assert.equal(found[0].time, 4);
  assert.ok(found[0].confidence > 0.9);
});

test('state goes in and out of every step: stopping and resuming gives the same events, and a step does not change what it is given', () => {
  const frames = withHit(40);
  const whole = run(config, frames);
  const first = run(config, frames.slice(0, 30));
  const frozen = JSON.stringify(first.state);
  const rest = run(config, frames.slice(30), first.state);
  assert.equal(JSON.stringify(first.state), frozen);
  assert.deepEqual([...first.events, ...rest.events], whole.events);
  assert.deepEqual(rest.state, whole.state);
  const before = newState();
  step(config, before, quiet[0]);
  assert.deepEqual(before, newState());
});

test('a hit is judged against the baseline from before it, one hit is one event inside the refractory time, and a head is a row', () => {
  const twice = quiet.map((frame, index) => ([40, 42].includes(index) ? { ...frame, sound: 1 } : frame));
  assert.equal(run(config, twice).events.length, 1);
  const quick = { ...config, heads: [{ ...config.heads[0], refractory_s: 0.05 }, { kind: 'quiet-spell', weights: { sound: -1 }, z_min: 2, z_full: 6, refractory_s: 5 }] };
  assert.equal(run(quick, twice).events.filter(event => event.kind === 'stroke').length, 2, 'retuning the head is a row');
});

test('a detector that is not kept, a stream that is not kept and a job row with no model are each an error in words', async () => {
  await assert.rejects(detectEvents({ detector: 'nothing', video: 'unused.mp4' }), /No detector named nothing is kept\./);
  const broken = { ...settings, detectors: [{ id: 'lost', stream: 'missing' }] };
  await assert.rejects(detectEvents({ detector: 'lost', video: 'unused.mp4', config: broken }), /names a stream, missing, that is not kept\./);
  const job = { ...settings, detectors: [{ id: 'model', job: 'local-model-job:detect-events', events_key: 'events' }] };
  await assert.rejects(detectEvents({ detector: 'model', video: 'unused.mp4', config: job }), /needs a model job and none can be asked\./);
  const asked = await detectEvents({ detector: 'model', video: 'unused.mp4', from: 0, to: 10, config: job,
    askModel: async () => ({ events: [{ kind: 'serve', time: 2, confidence: 1.4 }, { kind: 'serve', time: 12, confidence: 0.9 }, { kind: 'serve', time: 'x', confidence: 1 }] }) });
  assert.deepEqual(asked, [{ kind: 'serve', time: 2, confidence: 1 }], 'outside [from, to] and unfinite times are dropped; confidence is clamped');
});

test('through the detector row and a real clip: loud bursts are found by the adaptive stream, and the command answers them as JSON', { skip: !hasFfmpeg, timeout: 170_000 }, async () => {
  const folder = mkdtempSync(join(tmpdir(), 'stream-'));
  const file = join(folder, 'match.mp4');
  const gate = [8, 15, 21].map(t => `between(t,${t},${t + 0.15})`).join('+');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=26', '-f', 'lavfi', '-i', 'sine=frequency=900:sample_rate=22050:duration=26',
    '-af', `volume='if(${gate},1,0.01)':eval=frame`, '-shortest', '-pix_fmt', 'yuv420p', file]);
  const events = await detectEvents({ detector: 'adaptive', video: file, from: 0, to: 26 });
  assert.ok(events.length >= 3, JSON.stringify(events));
  for (const target of [8, 15, 21]) assert.ok(events.some(event => Math.abs(event.time - target) < 0.6), `an event near ${target}: ${JSON.stringify(events.map(e => e.time))}`);
  const command = new URL('../do-work/detect-events.mjs', import.meta.url).pathname;
  const answer = spawnSync(process.execPath, [command, file, '--detector', 'adaptive', '--from', '0', '--to', '26'], { encoding: 'utf8', timeout: 170_000 });
  assert.equal(answer.status, 0, answer.stderr);
  const report = JSON.parse(answer.stdout.trim());
  assert.equal(report.detector, 'adaptive');
  assert.deepEqual(report.events, events);
});
