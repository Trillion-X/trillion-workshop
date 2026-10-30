// Runs the script for real. It holds no camera, curve or look: every test hands it a profile. Two profiles are used: a
// published-curve example (test/fixture) whose 5-point table is the byte-for-byte golden, and a made-up camera written here
// that proves the same mechanism reads another curve. Checks the .cube shape, a rising grey ramp, each setting, the
// profile's own settings and the flags that override them, and refusals that say what to change.
// Needs python3 with numpy; without them these tests skip and say why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const script = join(folder, 'do-work', 'make_lut.py');
const fixture = join(folder, 'test', 'fixture');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const work = mkdtempSync(join(tmpdir(), 'make-lut-'));
const python = (...argv) => spawnSync('python3', ['-I', ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const numpy = python('-c', 'import numpy');
const skip = numpy.status === 0 ? false : 'needs python3 with numpy; run the row\'s get_it commands';

const published = join(fixture, 'published-slog3-example.profile.json');
const publishedProfile = JSON.parse(readFileSync(published, 'utf8'));
// A camera that exists nowhere: another toe, another log segment, another matrix, another shoulder and gamma.
const madeUp = {
  kind: 'log-to-display-profile',
  title: 'Made-up camera log to display',
  log_curve: {
    code_scale: 255,
    cut_code: 60,
    log: { base: 2, offset_code: 120, slope_code: 40, mid_grey: 0.2, pedestal: 0.02 },
    toe: { origin_code: 20, linear_at_cut: 0.02 },
  },
  gamut_matrix: [[1.2, -0.1, -0.1], [-0.05, 1.1, -0.05], [0, -0.1, 1.1]],
  luma_weights: [0.3, 0.59, 0.11],
  video_range: { black_code: 16, white_code: 235 },
  shoulder: { a: 2.4, b: 0.05, c: 2.4, d: 0.6, e: 0.15 },
  display_gamma: 2.2,
};
const profileFile = (name, profile) => { const path = join(work, name); writeFileSync(path, typeof profile === 'string' ? profile : JSON.stringify(profile)); return path; };

let count = 0;
function make(profile, ...options) {
  const out = join(work, `lut-${count++}.cube`);
  const run = python(script, '--profile', profile, '--out', out, ...options);
  const last = JSON.parse(run.stdout.trim().split('\n').pop());
  return { run, last, out, lines: existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n') : [] };
}
const entries = lines => lines.slice(2).map(line => line.split(' ').map(Number));
const middle = (lines, size) => entries(lines)[Math.floor(size / 2) * (1 + size + size * size)];

test('the row runs on the person\'s computer, takes a profile and names the script that exists', () => {
  assert.equal(row.id, 'tool:make-a-lut-for-log-footage');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.match(row.invoke.run, /tools\/make-a-lut-for-log-footage\/do-work\/make_lut\.py --profile \{profile\} --out \{output\}/);
  assert.ok(existsSync(script));
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.licence_class, 'licence:maker-own');
});

test('the script holds no camera: it cannot run without a profile', { skip }, () => {
  const run = python(script, '--out', join(work, 'none.cube'));
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--profile/);
});

test('the published-curve 5-point table is byte for byte the golden file', { skip }, () => {
  const { out, last } = make(published, '--size', '5');
  assert.equal(last.result.entries, 125);
  assert.equal(readFileSync(out, 'utf8'), readFileSync(join(fixture, 'published-slog3-size5.cube'), 'utf8'));
});

test('the file is a .cube: the profile\'s title, size, then size cubed rows of three numbers in range', { skip }, () => {
  const { lines, last } = make(profileFile('made-up.json', madeUp), '--size', '9');
  assert.equal(lines[0], 'TITLE "Made-up camera log to display exp 1.0 sat 1.0"');
  assert.equal(lines[1], 'LUT_3D_SIZE 9');
  assert.equal(lines.length, 2 + 9 ** 3);
  assert.equal(last.result.profile, 'Made-up camera log to display');
  for (const row of entries(lines)) for (const v of row) assert.ok(v >= 0 && v <= 1, `${v} is in 0..1`);
});

test('another camera gives another table, and its grey ramp rises from black to near white with red changing fastest', { skip }, () => {
  const size = 9;
  const a = entries(make(published, '--size', String(size)).lines);
  const b = entries(make(profileFile('made-up.json', madeUp), '--size', String(size)).lines);
  assert.notDeepEqual(a, b);
  const at = (rows, r, g, bl) => rows[r + g * size + bl * size * size];
  assert.ok(at(b, 1, 0, 0)[0] > at(b, 0, 0, 0)[0], 'the second row differs in red: red is the fastest axis');
  for (const rows of [a, b]) {
    let before = -1;
    for (let i = 0; i < size; i++) {
      const g = at(rows, i, i, i)[1];
      assert.ok(g > before, `grey step ${i} is brighter than the one before`);
      before = g;
    }
    assert.ok(at(rows, 0, 0, 0)[1] < 0.05, 'black stays black');
    assert.ok(at(rows, size - 1, size - 1, size - 1)[1] > 0.9, 'white stays near white');
  }
});

test('exposure brightens, saturation 0 gives grey and each gain moves only its own colour', { skip }, () => {
  const size = 5;
  const base = middle(make(published, '--size', String(size)).lines, size);
  assert.ok(middle(make(published, '--size', String(size), '--exposure', '1.6').lines, size)[1] > base[1]);
  for (const [r, g, b] of entries(make(published, '--size', String(size), '--saturation', '0').lines)) {
    assert.ok(Math.abs(r - g) < 1e-6 && Math.abs(g - b) < 1e-6, 'every entry is grey');
  }
  const warmer = middle(make(published, '--size', String(size), '--red-gain', '1.2').lines, size);
  assert.ok(warmer[0] > base[0]);
  assert.ok(Math.abs(warmer[2] - base[2]) < 0.05, 'blue is not raised by a red gain');
  assert.ok(middle(make(published, '--size', String(size), '--blue-gain', '1.2').lines, size)[2] > base[2]);
});

test('settings in the profile are used and a flag overrides them', { skip }, () => {
  const withSettings = profileFile('with-settings.json', { ...publishedProfile, settings: { exposure: 1.4, saturation: 0.5, size: 5 } });
  const used = make(withSettings);
  assert.deepEqual([used.last.result.exposure, used.last.result.saturation, used.last.result.size], [1.4, 0.5, 5]);
  assert.equal(used.lines[0], 'TITLE "S-Log3 S-Gamut3.Cine to Rec709 exp 1.4 sat 0.5"');
  const overridden = make(withSettings, '--exposure', '1.0', '--size', '3');
  assert.deepEqual([overridden.last.result.exposure, overridden.last.result.saturation, overridden.last.result.size], [1, 0.5, 3]);
});

test('a missing or wrong profile, and settings that give no numbers, are refused with what to change', { skip }, () => {
  const noToe = structuredClone(publishedProfile);
  delete noToe.log_curve.toe;
  const refusals = [
    [join(work, 'absent.json'), [], /is not there/],
    [profileFile('not-json.json', 'not json at all'), [], /is not JSON/],
    [profileFile('wrong-kind.json', { ...publishedProfile, kind: 'something-else' }), [], /"kind": "log-to-display-profile"/],
    [profileFile('no-toe.json', noToe), [], /needs log_curve\.toe\.origin_code/],
    [profileFile('bad-matrix.json', { ...publishedProfile, gamut_matrix: [[1, 0, 0]] }), [], /gamut_matrix must be 3 rows of 3 numbers/],
    [profileFile('bad-setting.json', { ...publishedProfile, settings: { brightness: 2 } }), [], /may hold only exposure/],
    [published, ['--size', '1'], /size must be 2 or more/],
    [published, ['--exposure', 'nan'], /not numbers/],
  ];
  for (const [profile, options, message] of refusals) {
    const { run, last } = make(profile, ...options);
    assert.equal(run.status, 2, `${profile} ${options.join(' ')}`);
    assert.match(last.error, message);
  }
});
