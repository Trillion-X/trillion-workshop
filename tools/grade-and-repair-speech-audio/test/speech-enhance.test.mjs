// Speech enhancement wired into a row (F-0478): the CPU-budget tier choice (light / near-voice / neural with arnndn) and the
// silencedetect speech places, run on a recording on this computer (no records door), with the real ffmpeg when this computer has one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import toolRows from '../tool-rows.json' with { type: 'json' };
import { budgetAsked, budgetOf, commandFor, enhance, enhanceSettings, enhanceSpeech, filtersHere, selectTier, settingsFor, speechPlaces } from '../read-data/speech-enhance.mjs';

const settings = enhanceSettings();
const all = ['highpass', 'afftdn', 'agate', 'arnndn'];
const ffmpeg = ['/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync);

const folder = mkdtempSync(path.join(os.tmpdir(), 'enhance-test-'));
test.after(() => rmSync(folder, { recursive: true, force: true }));
const fileOf = (name, bytes) => { const file = path.join(folder, name); writeFileSync(file, bytes); return file; };

test('F-0478: the tier is the most expensive within the CPU budget whose filters and model file exist here', () => {
  assert.equal(selectTier(settings, { filters: all, budget: 4, exists: () => true }).tier.id, 'neural');
  assert.equal(selectTier(settings, { filters: all, budget: 4, exists: () => false }).tier.id, 'near-voice', 'no model file: the neural tier is passed over');
  assert.equal(selectTier(settings, { filters: ['highpass', 'afftdn'], budget: 4, exists: () => true }).tier.id, 'light', 'no agate or arnndn here');
  assert.equal(selectTier(settings, { filters: all, budget: 1 }).tier.id, 'light');
  const none = selectTier(settings, { filters: [], budget: 4 });
  assert.equal(none.tier, null);
  assert.match(none.why, /highpass/);
  assert.match(selectTier({ ...settings, tiers: [] }, { budget: 1 }).why, /every tier costs more/);
  assert.equal(budgetOf({ ...settings, cpu_budget: null }, 8), 4);
  assert.equal(budgetOf({ ...settings, cpu_budget: 3 }, 8), 3);
  assert.equal(budgetAsked(undefined, { ...settings, cpu_budget: 3 }), 3);
  assert.equal(budgetAsked(2, settings), 2);
  assert.throws(() => budgetAsked(0, settings), /cpu_budget/);
});

test('a request\'s settings: no models folder granted passes the neural tier over; the granted ffmpeg\'s folder is searched first', () => {
  assert.equal(selectTier(settingsFor({}), { filters: all, budget: 4, exists: () => true }).tier.id, 'near-voice');
  const granted = settingsFor({ models_folder: '/m', ffmpeg: '/granted/bin/ffmpeg' });
  assert.equal(selectTier(granted, { filters: all, budget: 4, exists: () => true }).tier.id, 'neural');
  assert.deepEqual(granted.search_path, ['/granted/bin']);
  const words = commandFor(granted, granted.tiers.find(tier => tier.id === 'neural'), 'in.wav', 'out.wav');
  assert.ok(words.includes('highpass=f=80,arnndn=m=/m/rnnoise.rnnn'));
  assert.deepEqual(words.slice(-2), ['-y', 'out.wav']);
});

test('F-0478: speech places lie between the silences', () => {
  const text = 'silence_start: 0\nsilence_end: 1.0 | silence_duration: 1\nsilence_start: 3.5\nsilence_end: 5 | d\nsilence_start: 8';
  assert.deepEqual(speechPlaces(text, 10, 0.25), [{ start: 1, end: 3.5 }, { start: 5, end: 8 }]);
  assert.deepEqual(speechPlaces('', 4), [{ start: 0, end: 4 }]);
});

test('no tier fits: the recording is left untouched and no output is made', async () => {
  const file = fileOf('r.wav', Buffer.from('RIFF'));
  const outputFolder = path.join(folder, 'none-output');
  const done = await enhanceSpeech({ file }, undefined, { outputFolder, enhance: async () => ({ tier: null, why: 'none', budget: 1, output: null, seconds: 1, speech: [] }) });
  assert.deepEqual(done.files, []);
  assert.equal(existsSync(outputFolder), false);
  assert.equal(readFileSync(file, 'utf8'), 'RIFF', 'the recording is never changed');
  await assert.rejects(enhanceSpeech({}, undefined), /file/);
  await assert.rejects(enhanceSpeech({ file: path.join(folder, 'nowhere.wav') }, undefined), /is not a file on this computer/);
});

test('a cleaned sound is handed to the declared output with its exact identity, and the answer holds the manifest and no path', async () => {
  const file = fileOf('talk.wav', Buffer.from('RIFF'));
  const outputFolder = path.join(folder, 'enhanced-output');
  const enhance = async ({ output }) => { writeFileSync(output, 'CLEAN'); return { tier: 'light', why: null, budget: 1, output, seconds: 2, speech: [{ start: 0, end: 2 }] }; };
  const done = await enhanceSpeech({ file }, undefined, { outputFolder, enhance });
  assert.equal(done.tier, 'light');
  assert.deepEqual(done.speech, [{ start: 0, end: 2 }]);
  assert.deepEqual(done.files, [{ name: settings.keep.name, bytes: 5, blake3: makeHashCodeHexFromBytes(Buffer.from('CLEAN')).slice(3) }]);
  assert.equal(readFileSync(path.join(outputFolder, settings.keep.name), 'utf8'), 'CLEAN');
  assert.equal('output' in done, false, 'no path of the run leaves in the answer');
  assert.equal(readFileSync(file, 'utf8'), 'RIFF', 'the recording is never changed');
  await assert.rejects(enhanceSpeech({ file }, undefined, { outputFolder, enhance }), /retry the original tool request key/);
});

test('the row declares no records door and one declared output', () => {
  const row = toolRows.records.map(record => record.payload).find(payload => payload.id === 'tool:enhance-speech');
  assert.equal(row.invoke.records, undefined);
  assert.deepEqual(row.invoke.outputs.map(output => [output.name, output.keep_in, output.tree.files_from]), [['enhanced', 'files', 'result.files']]);
  assert.equal(row.input_schema.properties.output, undefined, 'a caller selects no output path');
});

test('a real recording on this computer is cleaned with the real ffmpeg and its speech found', { skip: !ffmpeg }, async () => {
  // 1 s silence, 2 s of a tone, 1 s silence.
  const wav = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=300:d=2,volume=0.5', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1',
    '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-ac', '1', '-ar', '16000', '-f', 'wav', '-']);
  const file = fileOf('real-talk.wav', wav);
  const outputFolder = path.join(folder, 'real-output');
  const done = await enhanceSpeech({ file, ffmpeg, cpu_budget: 1 }, undefined, { outputFolder });
  assert.equal(done.tier, 'light');
  assert.equal(done.budget, 1);
  assert.equal(done.files.length, 1);
  assert.ok(readFileSync(path.join(outputFolder, settings.keep.name)).length > 1000);
  assert.equal(done.speech.length, 1, JSON.stringify(done.speech));
  assert.ok(done.speech[0].start > 0.8 && done.speech[0].start < 1.4 && done.speech[0].end > 2.6 && done.speech[0].end < 3.2, JSON.stringify(done.speech));
});

// The old test's real-ffmpeg lines (the old app repository, b7dc53d08a test/speech-enhance.test.mjs:44, 51-53): the filter list is read from the
// ffmpeg here, and with no tier at all the recording is left alone (tier null, no output) while its speech places are still found.
test('the real ffmpeg\'s filter list is read, and with no tier the recording is untouched yet its speech is found', { skip: !ffmpeg }, async () => {
  const wav = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=300:d=2,volume=0.5', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1',
    '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-ac', '1', '-ar', '16000', '-f', 'wav', '-']);
  const input = fileOf('no-tier.wav', wav);
  const here = settingsFor({ ffmpeg });
  assert.ok((await filtersHere(here)).includes('afftdn'));
  const untouched = await enhance({ input, output: path.join(folder, 'no-tier-out.wav'), settings: { ...here, tiers: [] }, budget: 1 });
  assert.equal(untouched.tier, null);
  assert.equal(untouched.output, null);
  assert.match(untouched.why, /every tier costs more/);
  assert.equal(existsSync(path.join(folder, 'no-tier-out.wav')), false);
  assert.equal(untouched.speech.length, 1, JSON.stringify(untouched.speech));
  assert.ok(untouched.speech[0].start > 0.8 && untouched.speech[0].start < 1.4 && untouched.speech[0].end > 2.6 && untouched.speech[0].end < 3.2, JSON.stringify(untouched.speech));
});
