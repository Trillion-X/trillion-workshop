// test/cut-the-action.test.mjs
//
// The consumer of the video-pipeline, event-detection, kept-range, confidence-filter, session-pairing and frame-calibration engines:
// the command trillion-workshop tools/media-composition/do-work/cut-the-action.mjs, run as a person's tool would run it, on a real generated clip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COMMAND = new URL(import.meta.resolve('../do-work/cut-the-action.mjs')).pathname;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const burstsAt = [4, 11, 19];

function clip(folder) {
  const file = join(folder, 'match.mp4');
  const gate = burstsAt.map(t => `between(t,${t},${t + 0.15})`).join('+');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=24', '-f', 'lavfi', '-i', 'sine=frequency=900:sample_rate=22050:duration=24',
    '-af', `volume='if(${gate},1,0.01)':eval=frame`, '-shortest', '-pix_fmt', 'yuv420p', file]);
  return file;
}
const run = args => {
  const answer = spawnSync(process.execPath, [COMMAND, ...args], { encoding: 'utf8', timeout: 170_000 });
  return { status: answer.status, report: answer.stdout.trim() ? JSON.parse(answer.stdout.trim().split('\n').at(-1)) : null, error: answer.stderr };
};
const duration = file => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

test('the command finds the loud moments, keeps ranges around them, renders exactly that length and leaves a report', { skip: !hasFfmpeg, timeout: 180_000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'cut-action-'));
  const video = clip(folder), output = join(folder, 'cut.mp4'), runs = mkdtempSync(join(tmpdir(), 'cut-runs-'));
  const { status, report, error } = run(['--video', video, '--output', output, '--runs', runs]);
  assert.equal(status, 0, error);
  assert.equal(report.state, 'done');
  assert.equal(report.percent, 100);
  const kept = report.stages.cut.result.kept;
  assert.ok(kept.length >= 2);
  const total = kept.reduce((sum, range) => sum + range.end - range.start, 0);
  assert.ok(Math.abs(duration(output) - total) < 0.6, `rendered ${duration(output)} s for ${total} s kept`);
  assert.ok(total < 24 * 0.8);
  const saved = JSON.parse(readFileSync(join(runs, '.trillion/video-runs', `${report.id}.json`), 'utf8'));
  assert.deepEqual(Object.keys(saved.plans), ['proposed', 'applied']);
  assert.deepEqual(report.history.map(row => `${row.stage}:${row.to}`), ['detect:running', 'detect:done', 'cut:running', 'cut:done', 'render:running', 'render:done']);
  console.log(JSON.stringify({ kept, total, rendered: duration(output), history: report.history.map(row => `${row.stage}:${row.to}`) }));
});

test('a stop in the middle of the render is finished by --resume without finding the moments again', { skip: !hasFfmpeg, timeout: 180_000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'cut-action-'));
  const video = clip(folder), output = join(folder, 'cut.mp4'), runs = mkdtempSync(join(tmpdir(), 'cut-runs-'));
  const first = run(['--video', video, '--output', output, '--runs', runs]).report;
  const file = join(runs, '.trillion/video-runs', `${first.id}.json`);
  const stopped = JSON.parse(readFileSync(file, 'utf8'));
  stopped.stages.render.state = 'running'; stopped.state = 'running'; delete stopped.stages.render.result;
  writeFileSync(file, JSON.stringify(stopped));
  execFileSync('rm', ['-f', output]);
  const { status, report, error } = run(['--resume', first.id, '--runs', runs]);
  assert.equal(status, 0, error);
  assert.equal(report.state, 'done');
  assert.ok(existsSync(output));
  assert.equal(report.stages.detect.attempts, 1, 'the moments were not found again');
  assert.ok(report.history.some(row => row.stage === 'render' && row.to === 'interrupted'));
});

test('a model detector, a session of devices and a calibrated frame decide which events are kept; uncertain ones are asked, not cut', { skip: !hasFfmpeg, timeout: 180_000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'cut-action-'));
  const video = clip(folder), output = join(folder, 'cut.mp4'), runs = mkdtempSync(join(tmpdir(), 'cut-runs-'));
  // The model program answers four events: a stroke from the joined camera, a stroke from a camera that never joined, a serve
  // outside the court corners, and an unsure stroke.
  const model = join(folder, 'model.mjs');
  writeFileSync(model, `process.stdin.resume(); let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{ console.log(JSON.stringify({ events: [
    { kind: 'stroke', time: 4, confidence: 0.95, device: 'cam1' },
    { kind: 'stroke', time: 11, confidence: 0.95, device: 'cam9' },
    { kind: 'serve', time: 19, confidence: 0.95, device: 'cam1', at: [500, 500] },
    { kind: 'stroke', time: 22, confidence: 0.6, device: 'cam1' } ] })); });`);
  execFileSync('chmod', ['+x', model]);
  const wrapper = join(folder, 'ask.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${model}\n`);
  execFileSync('chmod', ['+x', wrapper]);
  const session = join(folder, 'session.json');
  writeFileSync(session, JSON.stringify({ id: 's1', states: ['ready', 'recording'], messages: [{ session: 's1', device: 'cam1', type: 'join', role: 'primary' }, { session: 'other', device: 'cam9', type: 'join' }] }));
  const { status, report, error } = run(['--video', video, '--output', output, '--runs', runs, '--detector', 'local-model', '--ask-model-command', wrapper, '--session', session,
    '--corners', JSON.stringify([[0, 0], [100, 0], [100, 100], [0, 100]])]);
  assert.equal(status, 0, error);
  const cut = report.stages.cut.result;
  assert.deepEqual(cut.kept.map(range => [Math.round(range.start), Math.round(range.end)]), [[3, 7]], 'only the joined camera\'s certain stroke is kept');
  assert.deepEqual(cut.dropped.map(row => [row.event.time, row.reason]), [[11, 'other_device'], [19, 'outside_frame']]);
  assert.deepEqual(cut.asked.map(row => row.event.time), [22]);
  assert.match(cut.said, /1 event\(s\) need the person/);
});

test('a model detector with no way to ask the model refuses in words and keeps its report', { skip: !hasFfmpeg, timeout: 120_000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'cut-action-'));
  const { status, report } = run(['--video', clip(folder), '--output', join(folder, 'x.mp4'), '--runs', mkdtempSync(join(tmpdir(), 'cut-runs-')), '--detector', 'local-model']);
  assert.equal(status, 1);
  assert.equal(report.state, 'failed');
  assert.match(report.stages.detect.error, /needs a model job and none can be asked/);
});

test('a second-stage model row for an event kind can silence that kind, and the command then says nothing was kept instead of rendering', { skip: !hasFfmpeg, timeout: 120_000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'cut-action-'));
  const wrapper = join(folder, 'ask.sh');
  writeFileSync(wrapper, `#!/bin/sh\ncat >/dev/null\necho '{"events":[{"kind":"stroke","time":4,"confidence":0.9},{"kind":"stroke","time":9,"confidence":0.9}]}'\n`);
  execFileSync('chmod', ['+x', wrapper]);
  const models = join(folder, 'models.json');
  writeFileSync(models, JSON.stringify([{ context: 'stroke', bias: -8, weights: { gap_after: 0.01 }, keep_above: 0.5 }]));
  const { status, report } = run(['--video', clip(folder), '--output', join(folder, 'x.mp4'), '--runs', mkdtempSync(join(tmpdir(), 'cut-runs-')), '--detector', 'local-model', '--ask-model-command', wrapper, '--models', models]);
  assert.equal(status, 1);
  assert.deepEqual(report.stages.cut.result.dropped.map(row => row.reason), ['second_stage', 'second_stage']);
  assert.match(report.stages.render.error, /No event was kept/);
  assert.equal(report.stages.render.attempts, 1, 'a refusal that says retry:false is not tried again');
});

test('a render that needs pieces not yet ready waits, saying which time is missing, and writes no file', { skip: !hasFfmpeg, timeout: 170_000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'cut-action-'));
  const video = clip(folder), runs = mkdtempSync(join(tmpdir(), 'cut-runs-'));
  const segments = join(folder, 'segments.json');
  writeFileSync(segments, JSON.stringify({ ready: ['ready'], segments: [{ start: 0, end: 3, state: 'ready' }, { start: 3, end: 30, state: 'working' }] }));
  const waiting = run(['--video', video, '--output', join(folder, 'late.mp4'), '--runs', runs, '--segments', segments]);
  assert.equal(waiting.status, 1);
  assert.match(waiting.report.stages.render.error, /Not ready: the pieces this render needs do not yet cover/);
  assert.equal(existsSync(join(folder, 'late.mp4')), false);
});

test('a transcript is cut by auto-edit (the lane that owns word cuts), and without it the run says so and does not try again', { skip: !hasFfmpeg || existsSync(new URL('./auto-edit.mjs', `file://${COMMAND}`)), timeout: 170_000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'cut-action-'));
  const transcript = join(folder, 'words.json');
  writeFileSync(transcript, JSON.stringify({ words: [{ text: 'so', start: 0.5, end: 0.9 }] }));
  const answer = run(['--video', clip(folder), '--output', join(folder, 'speech.mp4'), '--runs', mkdtempSync(join(tmpdir(), 'cut-runs-')), '--transcript', transcript]);
  assert.equal(answer.status, 1);
  assert.match(answer.report.stages.cut.error, /needs auto-edit\.mjs/);
  assert.equal(answer.report.stages.cut.attempts, 1);
});

test('with an upload command the video goes in numbered parts: a failed part is sent again alone, and the file is freed only after every part is confirmed', { skip: !hasFfmpeg, timeout: 170_000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'cut-action-'));
  const log = join(folder, 'sent.log'), marker = join(folder, 'failed-once');
  const upload = join(folder, 'send.sh');
  writeFileSync(upload, `#!/bin/sh\necho "$1" >> ${log}\nif [ "$1" = "2" ] && [ ! -f ${marker} ]; then touch ${marker}; exit 1; fi\nexit 0\n`);
  execFileSync('chmod', ['+x', upload]);
  const output = join(folder, 'cut.mp4');
  const { status, report, error } = run(['--video', clip(folder), '--output', output, '--runs', mkdtempSync(join(tmpdir(), 'cut-runs-')), '--upload-command', upload, '--part-size', '20000']);
  assert.equal(status, 0, error);
  assert.equal(report.state, 'done');
  const sent = readFileSync(log, 'utf8').trim().split('\n').map(Number);
  assert.equal(report.stages.upload.attempts, 2);
  assert.equal(sent.filter(number => number === 1).length, 1, 'a confirmed part is not sent again');
  assert.equal(sent.filter(number => number === 2).length, 2, 'the failed part was sent again');
  assert.equal(report.stages.upload.result.confirmed, true);
  assert.equal(existsSync(output), false, 'freed after the parts were confirmed');
  assert.equal(report.stages.free_local.result.freed, true);
});
