// Runs the grading stage for real on synthetic recordings (a voiced tone at known word times over a noise floor; no real speech):
// a clean take stays as it is, a noisy and humming take and a clipped take are graded remaster with their reasons, a repeated cut
// is graded once, each audio file carries the handle either side, and the source recordings are not touched. Also checks the pure
// readers (measure, grade rules, duck, spans file, phrases, word errors) and that every row names a script that exists.
// The remaster, clone and read-back stages need DeepFilterNet, a cloning model, pyannote and whisper weights and are run by hand;
// their row, their arguments and their refusals are checked here without the models.
// Needs python3 with numpy, scipy and soundfile, and ffmpeg; without them these tests skip and say why.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));
const here = join(folder, 'test');
const doWork = join(folder, 'do-work');
const rows = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const settingsFile = join(here, 'settings-for-synthetic-speech.json');
const python = (...argv) => spawnSync('python3', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const environment = JSON.parse(python(join(here, 'check_environment.py')).stdout.trim().split('\n').pop());
const skip = environment.ok ? false : `needs python3 with numpy, scipy and soundfile, and ffmpeg (${environment.reason})`;

let work, grades, run;
before(() => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), 'grade-speech-'));
  assert.equal(python(join(here, 'build_fixture.py'), work).status, 0, 'the fixture builds');
  run = python(join(doWork, 'grade_and_repair_speech.py'), 'grade', '--spans', join(work, 'spans.json'), '--settings', settingsFile, '--out', join(work, 'out'));
  if (run.status === 0) grades = JSON.parse(readFileSync(join(work, 'out', 'grades.json'), 'utf8'));
});

test('the rows run on the person\'s computer and name scripts that exist', () => {
  assert.deepEqual(rows.map(row => row.id), [
    'tool:grade-and-repair-speech-audio',
    'tool:clone-speech-that-repair-could-not-fix',
    'tool:read-back-repaired-speech',
    'tool:pick-the-cleanest-speech-to-clone-from',
  ]);
  for (const row of rows) {
    assert.equal(row.invoke.kind, 'on-your-computer');
    assert.deepEqual(row.placements, ['placement:your-computer']);
    assert.equal(row.licence_class, 'licence:maker-own');
    const script = row.invoke.run.match(/tools\/grade-and-repair-speech-audio\/do-work\/(\w+\.py)/)?.[1];
    assert.ok(script && existsSync(join(doWork, script)), `${row.id} runs ${script}, which is in do-work/`);
    assert.ok(row.invoke.needs.includes('python') && row.invoke.needs.includes('ffmpeg'));
  }
});

test('every model the rows need is named in needs, so nothing is fetched unseen', () => {
  const named = rows.flatMap(row => row.invoke.needs).filter(need => need.startsWith('model:'));
  for (const weights of ['read_model', 'wespeaker-voxceleb-resnet34-LM', 'DeepFilterNet3', 'clone_model']) {
    assert.ok(named.some(need => need.includes(weights)), `${weights} is named in a row's needs`);
  }
  const used = ['reading.py', 'clone_speech.py', 'speaker_check.py'].map(name => readFileSync(join(doWork, name), 'utf8')).join('\n');
  for (const weights of ['wespeaker-voxceleb-resnet34-LM']) assert.ok(used.includes(weights), `${weights} is what the code loads`);
});

test('nothing in the tool names a film, a person, a brand or a home folder', () => {
  const files = ['grade_and_repair_speech.py', 'clone_speech.py', 'check_speech_by_reading.py', 'choose_clone_reference.py', 'speaker_check.py', 'reading.py', 'dfn_batch.py']
    .map(name => join(doWork, name))
    .concat(['spans.py', 'measure.py', 'grade_rules.py', 'gap_duck.py', 'phrases.py', 'settings.py', 'settings-keys.json'].map(name => join(folder, 'read-data', name)));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\/Users\/|\/Volumes\/|~\//, `${file} names no machine path`);
    assert.doesNotMatch(text, /slate|trillion-launch/i, `${file} names no film or private folder`);
  }
});

test('the pure readers keep their promises (measure, grade rules, duck, spans file, phrases, word errors)', { skip }, () => {
  const checked = python(join(here, 'check_read_data.py'));
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.stdout.trim().split('\n').pop(), 'ok');
});

test('grading writes one row per unique span, graded by the measures', { skip }, () => {
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(Object.keys(grades.spans), ['clean_0.40_5.00', 'noisy_0.40_5.00', 'clipped_0.40_5.00'], 'the repeated cut is graded once');
  assert.deepEqual(grades.counts, { good: 1, remaster: 2, clone: 0 });
  assert.equal(grades.spans['clean_0.40_5.00'].treatment, 'as-is');
  assert.match(grades.spans['noisy_0.40_5.00'].reasons.join(' '), /noise: snr/);
  assert.match(grades.spans['clipped_0.40_5.00'].reasons.join(' '), /clipping/);
  assert.equal(JSON.parse(run.stdout.trim().split('\n').pop()).result.counts.remaster, 2);
});

test('a kept span\'s audio is the cut with the settings\' handle either side, mono 48 kHz, named by its id', { skip }, () => {
  const entry = grades.spans['clean_0.40_5.00'];
  assert.equal(entry.audio, 'audio/clean_0.40_5.00.wav');
  assert.equal(entry.audio_from, 0.2);
  assert.equal(entry.audio_to, 5.2);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,duration', '-of', 'json', join(work, 'out', entry.audio)], { encoding: 'utf8' });
  const stream = JSON.parse(probe.stdout).streams[0];
  assert.equal(stream.sample_rate, '48000');
  assert.equal(stream.channels, 1);
  assert.ok(Math.abs(Number(stream.duration) - 5.0) < 0.02, `duration ${stream.duration}`);
});

test('the source recordings are only read', { skip }, () => {
  const before = statSync(join(work, 'clean.wav'));
  python(join(doWork, 'grade_and_repair_speech.py'), 'grade', '--spans', join(work, 'spans.json'), '--settings', settingsFile, '--out', join(work, 'out'));
  const after = statSync(join(work, 'clean.wav'));
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('a span file with a span that lacks a field stops the run by name and writes nothing (the other refusals are in check_read_data.py)', { skip }, () => {
  const stopped = python(join(doWork, 'grade_and_repair_speech.py'), 'grade', '--spans', join(here, 'spans-missing-text.json'), '--settings', settingsFile, '--out', join(work, 'refused'));
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stderr, /span 0 lacks text/);
  assert.ok(!existsSync(join(work, 'refused', 'grades.json')), 'nothing is written for a refused file');
});

test('the tool carries no settings: a run without the person\'s settings file stops, and so does a file missing a key', { skip }, () => {
  const none = python(join(doWork, 'grade_and_repair_speech.py'), 'grade', '--spans', join(work, 'spans.json'), '--out', join(work, 'none'));
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /--settings/);
  const incomplete = JSON.parse(readFileSync(settingsFile, 'utf8'));
  delete incomplete.speaker_similarity_min;
  const partial = join(work, 'partial-settings.json');
  writeFileSync(partial, JSON.stringify(incomplete));
  const stopped = python(join(doWork, 'grade_and_repair_speech.py'), 'grade', '--spans', join(work, 'spans.json'), '--settings', partial, '--out', join(work, 'partial'));
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stderr, /speaker_similarity_min is missing/);
  assert.ok(!existsSync(join(work, 'partial', 'grades.json')));
});

test('the settings change the grade: the same audio under a stricter noise line is graded remaster', { skip }, () => {
  const strict = { ...JSON.parse(readFileSync(settingsFile, 'utf8')), snr_db_min: 200, snr_db_hard_min: 100 };
  const file = join(work, 'strict-settings.json');
  writeFileSync(file, JSON.stringify(strict));
  const ran = python(join(doWork, 'grade_and_repair_speech.py'), 'grade', '--spans', join(work, 'spans.json'), '--settings', file, '--out', join(work, 'strict'));
  assert.equal(ran.status, 0, ran.stderr);
  const result = JSON.parse(readFileSync(join(work, 'strict', 'grades.json'), 'utf8'));
  assert.equal(result.spans['clean_0.40_5.00'].grade, 'remaster');
  assert.equal(result.settings.snr_db_min, 200, 'grades.json records the settings it was made with');
});

test('no settings are baked in: every key the code reads from the settings is listed, and no value file ships', () => {
  const keys = Object.keys(JSON.parse(readFileSync(join(folder, 'read-data', 'settings-keys.json'), 'utf8')).keys);
  const source = ['grade_and_repair_speech.py', 'clone_speech.py', 'check_speech_by_reading.py', 'choose_clone_reference.py', 'reading.py']
    .map(name => readFileSync(join(doWork, name), 'utf8')).join('\n')
    + ['grade_rules.py'].map(name => readFileSync(join(folder, 'read-data', name), 'utf8')).join('\n');
  const read = new Set([...source.matchAll(/\b(?:t|settings)\[['"](\w+)['"]\]/g)].map(match => match[1]));
  for (const key of read) assert.ok(keys.includes(key), `${key} is read from the settings but is not in settings-keys.json`);
  for (const key of keys) assert.ok(read.has(key) || source.includes(key), `${key} is in settings-keys.json but nothing reads it`);
  assert.ok(!existsSync(join(folder, 'read-data', 'thresholds.json')), 'no file of tuned values ships with the tool');
});
