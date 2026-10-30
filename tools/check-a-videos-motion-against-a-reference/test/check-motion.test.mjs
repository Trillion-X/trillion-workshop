// The bar's rows and the verdict, the still level, the command's refusals, and the real measure on small videos made here
// with ffmpeg (a moving test pattern, a still grey picture, and a pattern that moves then holds). The measure needs ffmpeg and
// ffprobe; the tests that use them skip, saying why, without. The script holds no bar: every test passes made-up rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { barFor, judge, rowsOf } from '../read-data/motion-bar.mjs';
import { measureMotion, stillLevelOf } from '../read-data/measure-motion.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const command = join(folder, 'do-work', 'check-motion.mjs');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const work = mkdtempSync(join(tmpdir(), 'check-motion-'));
const node = (...argv) => spawnSync('node', [command, ...argv], { encoding: 'utf8' });
const lastLine = run => JSON.parse(run.stdout.trim().split('\n').pop());

// Made-up rows: not the numbers anyone's pieces were held to.
const rows = [
  { name: 'moving', bar_key: 'moving_min', measure: 'moving_share', relation: 'at_least', times_reference: 0.5 },
  { name: 'hold', bar_key: 'hold_max_s', measure: 'longest_hold_s', relation: 'at_most', times_reference: 3 },
];
const barFile = (name, record) => { const path = join(work, name); writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record)); return path; };
const bar = barFile('bar.json', { kind: 'motion-bar', rows });

const ffmpegThere = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skip = ffmpegThere ? false : 'needs ffmpeg and ffprobe on the PATH; run the row\'s get_it steps';

test('the row runs on the person\'s computer, takes a bar and names the command that exists', () => {
  assert.equal(row.id, 'tool:check-a-videos-motion-against-a-reference');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.match(row.invoke.run, /do-work\/check-motion\.mjs --reference \{reference\} --render \{render\} --end-card-start \{end_card_start_seconds\} --bar \{bar\}/);
  assert.ok(existsSync(command));
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.licence_class, 'licence:maker-own');
  assert.ok(row.invoke.needs.some(need => /ffmpeg/.test(need)), 'ffmpeg is a declared need');
  assert.ok(!JSON.stringify(row).includes('/Applications/'), 'no app bundle is reached into');
});

test('a bar row is a multiple of the reference\'s value or a fixed value, kept under the row\'s own key', () => {
  assert.deepEqual(barFor({ moving_share: 0.8, longest_hold_s: 3 }, rows), { moving_min: 0.4, hold_max_s: 9 });
  const fixed = [{ name: 'fast', bar_key: 'rate_min', measure: 'holds_over_1s_per_min', relation: 'at_most', value: 4 }];
  assert.deepEqual(barFor({ holds_over_1s_per_min: 100 }, fixed), { rate_min: 4 });
});

test('a piece passes only when it clears every row, and the verdict says which failed', () => {
  const bars = { moving_min: 0.4, hold_max_s: 9 };
  assert.deepEqual(judge({ moving_share: 0.4, longest_hold_s: 9 }, bars, rows), { pass: { moving: true, hold: true }, verdict: 'passed' });
  assert.deepEqual(judge({ moving_share: 0.39, longest_hold_s: 9 }, bars, rows), { pass: { moving: false, hold: true }, verdict: 'failed' });
  assert.deepEqual(judge({ moving_share: 0.9, longest_hold_s: 9.01 }, bars, rows), { pass: { moving: true, hold: false }, verdict: 'failed' });
});

test('a bar that is not a bar says what to change', () => {
  const bad = [
    [{ kind: 'other', rows }, /"kind": "motion-bar"/],
    [{ kind: 'motion-bar', rows: [] }, /at least one row/],
    [{ kind: 'motion-bar', rows: [{ ...rows[0], measure: '' }] }, /needs "measure"/],
    [{ kind: 'motion-bar', rows: [{ ...rows[0], relation: 'near' }] }, /"at_least" or "at_most"/],
    [{ kind: 'motion-bar', rows: [{ ...rows[0], value: 1 }] }, /exactly one number/],
    [{ kind: 'motion-bar', rows: [{ ...rows[0], times_reference: undefined }] }, /exactly one number/],
    [{ kind: 'motion-bar', rows: [{ ...rows[0], name: undefined }] }, /needs "name"/],
    [{ kind: 'motion-bar', rows: [rows[0], rows[0]] }, /used twice/],
  ];
  for (const [record, message] of bad) {
    const refused = rowsOf(record);
    assert.ok(refused instanceof Error, JSON.stringify(record));
    assert.match(refused.message, message);
  }
  assert.deepEqual(rowsOf({ kind: 'motion-bar', rows }), rows);
});

test('the still level is twice the quietest tenth of changes, kept between its floor and its ceiling', () => {
  assert.equal(stillLevelOf([0.01, 0.01, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02]), 0.5, 'a quiet video gets the floor');
  assert.equal(stillLevelOf([0.6, 0.7, 0.8, 0.9, 1, 1, 1, 1, 1, 1]), 1.4, 'twice the change a tenth of the way up the sorted changes');
  assert.equal(stillLevelOf([5, 6, 7, 8, 9, 9, 9, 9, 9, 9]), 1.5, 'a video that never stops moving is not read as noise');
  assert.equal(stillLevelOf([]), 0.5);
});

// Small videos made with ffmpeg.
function make(name, ...inputs) {
  const path = join(work, name);
  const made = spawnSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-pix_fmt', 'yuv420p', path], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  return path;
}
const moving = name => make(name, '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=15', '-t', '6');
const still = name => make(name, '-f', 'lavfi', '-i', 'color=c=gray:size=160x120:rate=15', '-t', '6');
// Three seconds of moving pattern, then three seconds of a held frame.
const movesThenHolds = name => make(name, '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=15', '-f', 'lavfi', '-i', 'color=c=gray:size=160x120:rate=15',
  '-filter_complex', '[0:v]trim=duration=3,setpts=PTS-STARTPTS[a];[1:v]trim=duration=3,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0');

test('a moving video reads as moving, a still one as one long hold, and the keys are the measure\'s own', { skip }, () => {
  const lively = measureMotion(moving('moving.mp4'));
  assert.deepEqual(Object.keys(lively), ['seconds', 'moving_share', 'longest_hold_s', 'holds_over_1s_per_min', 'still_threshold']);
  assert.ok(lively.moving_share > 0.9, `the test pattern moves: ${lively.moving_share}`);
  assert.equal(lively.longest_hold_s, 0);
  const flat = measureMotion(still('still.mp4'));
  assert.equal(flat.moving_share, 0);
  assert.ok(flat.longest_hold_s > 5.5, `a still picture is one long hold: ${flat.longest_hold_s}`);
});

test('a hold is timed by the frame rate and counted per minute, and the seconds asked for cut the video short', { skip }, () => {
  const path = movesThenHolds('moves-then-holds.mp4');
  const whole = measureMotion(path);
  assert.ok(whole.longest_hold_s > 2.7 && whole.longest_hold_s < 3.1, `about three seconds held: ${whole.longest_hold_s}`);
  assert.ok(whole.moving_share > 0.4 && whole.moving_share < 0.6, `about half moves: ${whole.moving_share}`);
  assert.equal(whole.holds_over_1s_per_min, 10);
  const firstHalf = measureMotion(path, 2.5);
  assert.equal(firstHalf.seconds, 2.5);
  assert.equal(firstHalf.longest_hold_s, 0, 'the piece measured to 2.5 s never reaches the hold');
});

test('a piece is measured at the reference\'s still level, not its own', { skip }, () => {
  const path = moving('level.mp4');
  assert.equal(measureMotion(path, 0, 1.5).still_threshold, 1.5);
});

test('the command: a moving video passes against itself and a still one fails against it', { skip }, () => {
  const reference = moving('reference.mp4');
  const same = lastLine(node('--reference', reference, '--render', reference, '--end-card-start', '5', '--bar', bar)).result;
  assert.equal(same.verdict, 'passed');
  assert.ok(same.reference.moving_share > 0.5);
  const run = node('--reference', reference, '--render', still('flat.mp4'), '--end-card-start', '5', '--bar', bar);
  assert.equal(run.status, 0, 'a failed verdict is an answer, not an error');
  const flat = lastLine(run).result;
  assert.equal(flat.verdict, 'failed');
  assert.deepEqual(flat.pass, { moving: false, hold: false });
  const stricter = barFile('stricter.json', { kind: 'motion-bar', rows: [{ ...rows[0], times_reference: 2 }, rows[1]] });
  assert.equal(lastLine(node('--reference', reference, '--render', reference, '--end-card-start', '5', '--bar', stricter)).result.verdict, 'failed',
    'a different bar gives a different verdict on the same pieces');
});

test('a missing flag, bar, bad end card, video or measure name are refused with what to change', { skip }, () => {
  const reference = moving('refusals.mp4');
  const base = ['--reference', reference, '--render', reference, '--end-card-start', '5', '--bar', bar];
  const without = flag => { const i = base.indexOf(flag); return [...base.slice(0, i), ...base.slice(i + 2)]; };
  const swap = (flag, value) => { const i = base.indexOf(flag); return [...base.slice(0, i + 1), value, ...base.slice(i + 2)]; };
  const notAVideo = join(work, 'notes.txt');
  writeFileSync(notAVideo, 'not a video');
  const refusals = [
    [without('--bar'), /usage:/],
    [swap('--end-card-start', '0'), /end card begins, above 0/],
    [swap('--reference', join(work, 'absent.mp4')), /reference file .* is not there/],
    [swap('--bar', join(work, 'absent.json')), /bar file .* is not there/],
    [swap('--bar', barFile('not-json.json', 'not json')), /not JSON/],
    [swap('--bar', barFile('wrong.json', { kind: 'motion-bar', rows: [] })), /at least one row/],
    [swap('--bar', barFile('unknown-measure.json', { kind: 'motion-bar', rows: [{ ...rows[0], measure: 'sparkle' }] })), /gives no number sparkle/],
    [swap('--render', notAVideo), /ffmpeg and ffprobe on the PATH/],
    [[...base, '--shape', reference], /Could not read --shape/],
  ];
  for (const [argv, message] of refusals) {
    const run = node(...argv);
    assert.equal(run.status, 2, argv.join(' '));
    assert.match(lastLine(run).error, message);
  }
});
