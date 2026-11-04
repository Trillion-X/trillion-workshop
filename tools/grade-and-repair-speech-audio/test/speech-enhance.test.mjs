// Speech enhancement wired into a row (F-0478): the CPU-budget tier choice (light / near-voice / neural with arnndn) and the
// silencedetect speech places, run on a recording read through a fake door, with the real ffmpeg when this computer has one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { budgetAsked, budgetOf, cleanedName, commandFor, enhanceSettings, enhanceSpeech, selectTier, settingsFor, speechPlaces } from '../read-data/speech-enhance.mjs';

const settings = enhanceSettings();
const all = ['highpass', 'afftdn', 'agate', 'arnndn'];
const ffmpeg = ['/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(existsSync);

/** A door over made-up files: find_file and read_file answer `files`, written pieces land in `written`. */
const fakeDoor = files => {
  const written = {};
  const uploads = {};
  return {
    written,
    async files(method, input) {
      if (method === 'find_file') return { names: [input.name_or_identity] };
      if (method === 'read_file') {
        const bytes = files[input.name_or_identity];
        const piece = bytes.subarray(input.offset, input.offset + input.length);
        return { byte_length: bytes.length, bytes_returned: piece.length, encoding: 'base64', content: piece.toString('base64') };
      }
      if (method === 'write_file_start') { uploads[input.upload_id] = []; return { next_offset: 0 }; }
      if (method === 'write_file_piece') { uploads[input.upload_id].push(Buffer.from(input.content_base64, 'base64')); return {}; }
      if (method === 'write_file_finish') { written[input.name] = Buffer.concat(uploads[input.upload_id]); return { name: input.name }; }
      throw new Error(method);
    },
  };
};

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
  assert.equal(cleanedName('/Recordings/talk.m4a'), '/Recordings/talk.clean.wav');
});

test('F-0478: speech places lie between the silences', () => {
  const text = 'silence_start: 0\nsilence_end: 1.0 | silence_duration: 1\nsilence_start: 3.5\nsilence_end: 5 | d\nsilence_start: 8';
  assert.deepEqual(speechPlaces(text, 10, 0.25), [{ start: 1, end: 3.5 }, { start: 5, end: 8 }]);
  assert.deepEqual(speechPlaces('', 4), [{ start: 0, end: 4 }]);
});

test('no tier fits: the recording is left untouched and nothing is written', async () => {
  const door = fakeDoor({ '/r.wav': Buffer.from('RIFF') });
  const done = await enhanceSpeech({ file: '/r.wav' }, { door }, { enhance: async () => ({ tier: null, why: 'none', budget: 1, output: null, seconds: 1, speech: [] }) });
  assert.equal(done.output, null);
  assert.deepEqual(door.written, {});
  await assert.rejects(enhanceSpeech({}, { door }), /file/);
});

test('a real recording read through the door is cleaned with the real ffmpeg and its speech found', { skip: !ffmpeg }, async () => {
  // 1 s silence, 2 s of a tone, 1 s silence.
  const wav = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1', '-f', 'lavfi', '-i', 'sine=f=300:d=2,volume=0.5', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1',
    '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-ac', '1', '-ar', '16000', '-f', 'wav', '-']);
  const door = fakeDoor({ '/Recordings/talk.wav': wav });
  const done = await enhanceSpeech({ file: '/Recordings/talk.wav', ffmpeg, cpu_budget: 1 }, { door });
  assert.equal(done.tier, 'light');
  assert.equal(done.output, '/Recordings/talk.clean.wav');
  assert.equal(done.budget, 1);
  assert.ok(door.written['/Recordings/talk.clean.wav'].length > 1000);
  assert.equal(done.speech.length, 1, JSON.stringify(done.speech));
  assert.ok(done.speech[0].start > 0.8 && done.speech[0].start < 1.4 && done.speech[0].end > 2.6 && done.speech[0].end < 3.2, JSON.stringify(done.speech));
});
