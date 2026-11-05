// Runs the command with stand-in yt-dlp and ffmpeg programs put first on PATH (they log their arguments and write made-up bytes),
// and, when this computer has ffmpeg, once for real on a made-up test video. Checks the promises: separate argv items, the
// section and 360p limit asked of yt-dlp, a clip already there used again, a local file read from start to end, every failure
// reported with the log's last lines, and a bad request refused with what to fix.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const script = join(folder, 'do-work', 'make_contact_sheet.py');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const result = out => JSON.parse(out.stdout.trim().split('\n').pop()).result;

let work, standIns, calls;
const run = (env, ...argv) => spawnSync('python3', [script, ...argv], {
  encoding: 'utf8', env: { ...process.env, PATH: `${standIns}:${process.env.PATH}`, ...env } });

before(() => {
  work = mkdtempSync(join(tmpdir(), 'contact-sheet-'));
  standIns = join(work, 'bin');
  calls = join(work, 'calls.log');
  mkdirSync(standIns);
  // yt-dlp: writes the -o path with %(ext)s made webm, unless STAND_IN_FAIL names it.
  writeFileSync(join(standIns, 'yt-dlp'), `#!/bin/sh
echo "yt-dlp $*" >> "${calls}"
[ "$STAND_IN_FAIL" = yt-dlp ] && { echo "ERROR: the page refused"; exit 1; }
out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
printf 'clip' > "$(echo "$out" | sed 's/%(ext)s/webm/')"
`);
  // ffmpeg: writes the last argument (the sheet), unless STAND_IN_FAIL names it.
  writeFileSync(join(standIns, 'ffmpeg'), `#!/bin/sh
echo "ffmpeg $*" >> "${calls}"
[ "$STAND_IN_FAIL" = ffmpeg ] && { echo "Invalid data found when processing input"; exit 1; }
for last in "$@"; do :; done
printf 'jpeg' > "$last"
`);
  chmodSync(join(standIns, 'yt-dlp'), 0o755);
  chmodSync(join(standIns, 'ffmpeg'), 0o755);
});

test('the row runs on the person\'s computer and names the script that exists', () => {
  assert.equal(row.id, 'tool:make-a-frame-contact-sheet-of-a-video-section');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.ok(row.invoke.run.includes('tools/make-a-frame-contact-sheet-of-a-video-section/do-work/make_contact_sheet.py'));
  assert.ok(existsSync(script));
});

test('a URL is fetched once, only the section at 360p or less, then tiled one frame per step', () => {
  const out = join(work, 'url');
  const first = run({}, '--source', 'https://video.example/watch/abc', '--name', 'abc', '--start', '10', '--end', '50', '--folder', out);
  assert.equal(first.status, 0, first.stderr);
  const answer = result(first);
  assert.equal(answer.sheet, join(out, 'frames', 'abc-10-50-sheet.jpg'));
  assert.equal(answer.clip, join(out, 'clips', 'abc-10-50.webm'));
  assert.equal(answer.rows, 3);
  const log = readFileSync(calls, 'utf8');
  assert.match(log, /yt-dlp https:\/\/video\.example\/watch\/abc -f bv\*\[height<=360\]\+ba\/b\[height<=360\]\/best --download-sections \*10-50 -o /);
  assert.match(log, /fps=1\/4,scale=320:-1,tile=4x3 -frames:v 1 /);
  assert.match(readFileSync(answer.log, 'utf8'), /^\$ yt-dlp /m);
  writeFileSync(calls, '');
  const again = run({}, '--source', 'https://video.example/watch/abc', '--name', 'abc', '--start', '10', '--end', '50', '--folder', out);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(readFileSync(calls, 'utf8'), /yt-dlp/);
});

test('a local file is read from start to end without fetching', () => {
  writeFileSync(join(work, 'local.mp4'), 'video');
  writeFileSync(calls, '');
  const out = run({}, '--source', join(work, 'local.mp4'), '--name', 'here', '--start', '5', '--end', '20', '--folder', join(work, 'local'),
    '--step', '5', '--cols', '2');
  assert.equal(out.status, 0, out.stderr);
  const log = readFileSync(calls, 'utf8');
  assert.doesNotMatch(log, /yt-dlp/);
  assert.match(log, /ffmpeg -loglevel error -y -ss 5 -to 20 -i .*local\.mp4 -vf fps=1\/5,scale=320:-1,tile=2x2 /);
});

test('a failure is reported with the last lines of the log and exit 1', () => {
  const fetch = run({ STAND_IN_FAIL: 'yt-dlp' }, '--source', 'https://video.example/x', '--name', 'x', '--start', '0', '--end', '9',
    '--folder', join(work, 'fail'));
  assert.equal(fetch.status, 1);
  assert.match(result(fetch).error, /^yt-dlp exit 1/);
  assert.ok(result(fetch).log_tail.includes('ERROR: the page refused'));
  writeFileSync(join(work, 'local2.mp4'), 'video');
  const tile = run({ STAND_IN_FAIL: 'ffmpeg' }, '--source', join(work, 'local2.mp4'), '--name', 'y', '--start', '0', '--end', '9',
    '--folder', join(work, 'fail'));
  assert.equal(tile.status, 1);
  assert.match(tile.stderr, /Invalid data found/);
  writeFileSync(join(work, 'empty.mp4'), '');
  const empty = run({}, '--source', join(work, 'empty.mp4'), '--name', 'z', '--start', '0', '--end', '9', '--folder', join(work, 'fail'));
  assert.equal(empty.status, 1);
  assert.equal(result(empty).error, 'clip file is empty');
});

test('a request it cannot use is refused with what to fix', () => {
  const long = run({}, '--source', 'u', '--name', 'n', '--start', '0', '--end', '301', '--folder', join(work, 'bad'));
  assert.equal(long.status, 2);
  assert.match(result(long).error, /at most 300 s/);
  const slash = run({}, '--source', 'u', '--name', 'a/b', '--start', '0', '--end', '9', '--folder', join(work, 'bad'));
  assert.equal(slash.status, 2);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('with this computer\'s ffmpeg, a made-up test video becomes a real sheet', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, () => {
  const video = join(work, 'bars.mp4');
  const made = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=12:size=320x240:rate=10', video]);
  assert.equal(made.status, 0);
  const out = spawnSync('python3', [script, '--source', video, '--name', 'bars', '--start', '0', '--end', '12', '--folder', join(work, 'real')],
    { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(statSync(result(out).sheet).size > 0);
});
