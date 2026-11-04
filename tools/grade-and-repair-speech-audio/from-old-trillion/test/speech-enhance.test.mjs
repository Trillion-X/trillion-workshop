// Speech enhancement tiers and the voice-activity pass (computer/speech-enhance.mjs, DATA in speech-enhance.json), with a real ffmpeg run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { budgetOf, commandFor, enhance, enhanceSettings, filtersHere, selectTier, speechPlaces } from '../computer/speech-enhance.mjs';

const settings = enhanceSettings();
const all = ['highpass', 'afftdn', 'agate', 'arnndn'];

test('the tier is the most expensive that fits the budget and whose filters and model file exist', () => {
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
});

test('the model file is filled into the command from the models folder', () => {
  const neural = settings.tiers.find(tier => tier.id === 'neural');
  const words = commandFor({ ...settings, models_folder: '/m' }, neural, 'in.wav', 'out.wav');
  assert.ok(words.includes('highpass=f=80,arnndn=m=/m/rnnoise.rnnn'));
  assert.deepEqual(words.slice(-2), ['-y', 'out.wav']);
});

test('speech places lie between the silences', () => {
  const text = 'silence_start: 0\nsilence_end: 1.0 | silence_duration: 1\nsilence_start: 3.5\nsilence_end: 5 | d\nsilence_start: 8';
  assert.deepEqual(speechPlaces(text, 10, 0.25), [{ start: 1, end: 3.5 }, { start: 5, end: 8 }]);
  assert.deepEqual(speechPlaces('', 4), [{ start: 0, end: 4 }]);
});

test('a real recording is cleaned with the real ffmpeg here and its speech found', { skip: !existsSync('/opt/homebrew/bin/ffmpeg') }, async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'enhance-'));
  const input = path.join(folder, 'in.wav'); const output = path.join(folder, 'out.wav');
  // 1 s silence, 2 s of a tone with noise, 1 s silence.
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=300:d=2,volume=0.5', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1', '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-y', input]);
  assert.ok((await filtersHere(settings)).includes('afftdn'));
  const done = await enhance({ input, output, settings: { ...settings, tiers: settings.tiers.filter(tier => tier.id === 'light') }, budget: 1 });
  assert.equal(done.tier, 'light');
  assert.ok(statSync(output).size > 1000);
  assert.equal(done.speech.length, 1);
  assert.ok(done.speech[0].start > 0.8 && done.speech[0].start < 1.4 && done.speech[0].end > 2.6 && done.speech[0].end < 3.2, JSON.stringify(done.speech));
  console.log('REAL readback of the enhancement:', JSON.stringify(done));
  const untouched = await enhance({ input, output, settings: { ...settings, tiers: [] }, budget: 1 });
  assert.equal(untouched.tier, null);
  assert.equal(untouched.output, null);
});
