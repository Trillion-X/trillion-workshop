// tools/generate-speech/test/speak.test.mjs
//
// Speaking in a natural voice: read-data/speak.mjs (tool:say-with-a-voice-model and tool:voices) says words with the
// voice asked for, else the person's chosen one, else the shared voices in order, passing over a voice that cannot be
// made, and keeps the request when none can; the person's voices and speeds are rows of their own lists, with reference
// recordings in their files, and every sound is made at its natural pace and answered with the place's speed. The speech
// model itself stands in as a stub `ask`, and the person's records and files as an in-memory door. Moved from the
// product repo's test/speak.test.mjs with its assertions; its notice and account-placement tests stay with the product
// repo's Mac app and src/account-speech.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { say, sayHere, speakSettings, voiceOrder, voices } from '../read-data/speak.mjs';

const folder = mkdtempSync(path.join(os.tmpdir(), 'speak-test-'));
test.after(() => rmSync(folder, { recursive: true, force: true }));
const settings = speakSettings();
const speakTools = { say, voices };
const own = { id: 'own-1', label: 'Your own voice', engine: 'qwen3-tts', reference: '/Voice/own-1.wav', reference_text: 'I said this.' };

// The person's records and files as the run's door sees them: records by id (a null value removes one), and files whose
// pieces are joined on finish. `voices` rows are put first, after the lists are made with their starters.
async function accountOf(initial = {}, voiceRows = []) {
  const records = new Map();
  const kept = new Map(Object.entries(initial).map(([name, text]) => [name, Buffer.from(text)]));
  const uploads = new Map();
  const door = {
    async read(type, id) { const record = records.get(id); return record?.type === type ? record.value : null; },
    async *list({ type }) { for (const [id, record] of records) if (record.type === type) yield { id, ...record }; },
    async write(written) { for (const { id, type, value } of written) { if (value === null) records.delete(id); else records.set(id, { type, value }); } return { changed: written.length }; },
    async files(method, request) {
      if (method === 'find_file' || method === 'read_file') {
        if (!kept.has(request.name_or_identity)) throw new Error('No such file');
        const bytes = kept.get(request.name_or_identity);
        if (method === 'find_file') return { identity: `1f:${String(bytes.length).padStart(64, '0')}`, names: [request.name_or_identity] };
        const part = bytes.subarray(request.offset, request.offset + request.length);
        return { byte_length: bytes.length, bytes_returned: part.length, content: part.toString('base64'), encoding: 'base64' };
      }
      if (method === 'write_file_start') { uploads.set(request.upload_id, []); return { next_offset: 0 }; }
      if (method === 'write_file_piece') { uploads.get(request.upload_id).push(Buffer.from(request.content_base64, 'base64')); return {}; }
      if (method === 'write_file_finish') { kept.set(request.name, Buffer.concat(uploads.get(request.upload_id))); return { identity: `1f:${'b'.repeat(64)}`, name: request.name }; }
      throw new Error(`no file call ${method}`);
    },
  };
  const rowsOf = list => [...records].filter(([id]) => id.startsWith(`record:${settings.lists[list].row_type}:`)).map(([id, record]) => ({ id: id.split(':').pop(), values: record.value }));
  const putRows = async (list, rows) => { for (const row of rows) { const id = `record:${settings.lists[list].row_type}:${row.id}`; records.set(id, { type: `record:${settings.lists[list].row_type}`, value: { ...records.get(id)?.value, ...row.values } }); } };
  await voices({}, { door }, { settings });
  if (voiceRows.length) await putRows('voices', voiceRows);
  return { door, kept, rowsOf, putRows };
}
const ownRow = { id: own.id, values: { label: own.label, engine: own.engine, reference: own.reference, reference_text: own.reference_text, chosen: 'Chosen', speed: 0.8 } };

// A speech model that makes every engine but those in `broken`, writing a few bytes to `out`.
const modelFor = (broken = [], asked = []) => async request => {
  asked.push(request);
  if (request.say) {
    if (broken.includes(request.say.model)) return { ok: false, error: `${request.say.model} cannot run here` };
    writeFileSync(request.say.out, 'RIFF');
    return { ok: true, out: request.say.out, seconds: 2.5, sample_rate: 24000, took_seconds: 0.4 };
  }
  writeFileSync(request.reference.out, 'RIFF');
  return { ok: true, out: request.reference.out, text: 'Every word of it.', seconds: 9.1 };
};

test('the voice asked for, else the chosen one, else the shared voices in order; an unknown voice is refused', () => {
  const person = { chosen: 'own-1', voices: [own] };
  assert.deepEqual(voiceOrder({ person, settings }).map(voice => voice.id), ['own-1', 'neutral']);
  assert.deepEqual(voiceOrder({ asked: 'neutral', person, settings }).map(voice => voice.id), ['neutral']);
  assert.deepEqual(voiceOrder({ person: { chosen: null, voices: [own] }, settings }).map(voice => voice.id), ['neutral']);
  assert.throws(() => voiceOrder({ asked: 'robot', person, settings }), /There is no voice robot\. The voices are own-1, neutral\./);
});

test('strict narration refuses unknown or failed requested voices without neutral substitution', async () => {
  const { door } = await accountOf({ '/Voice/own-1.wav': 'RIFF' }, [ownRow]);
  const asked = [];
  await assert.rejects(sayHere({ text: 'Use this exact voice.', voice: 'robot', out: path.join(folder, 'strict-unknown.wav') },
    { door, settings, allowFallback: false, ask: modelFor([], asked) }), /There is no voice robot/);
  assert.equal(asked.length, 0);
  await assert.rejects(sayHere({ text: 'Use this exact voice.', voice: own.id, out: path.join(folder, 'strict-failed.wav') },
    { door, settings, allowFallback: false, ask: modelFor(['mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16'], asked) }), /cannot run here/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].say.takes, 'reference');
  const made = await sayHere({ text: 'Use this exact voice.', voice: own.id, out: path.join(folder, 'strict-ok.wav') },
    { door, settings, allowFallback: false, ask: modelFor() });
  assert.equal(made.voice.id, own.id);
});

test('a voice that cannot be made is passed over with why, and the next one says it', async () => {
  const { door } = await accountOf({ '/Voice/own-1.wav': 'RIFF' }, [ownRow]);
  const asked = [];
  const out = path.join(folder, 'one.wav');
  const made = await sayHere({ text: 'Your print job is ready.', out }, { door, settings, ask: modelFor(['mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16'], asked) });
  // The chosen voice's speed comes back for the player; the model was asked at its natural pace.
  assert.equal(made.speed, 0.8);
  assert.equal('speed' in asked[0].say, false);
  assert.equal(made.voice.id, 'neutral');
  assert.equal(made.engine, 'kokoro');
  assert.deepEqual(made.passed_over.map(item => item.voice), ['own-1']);
  assert.match(made.passed_over[0].why, /cannot run here/);
  // The cloned voice was asked with the person's reference, read from their files onto this computer, and its words.
  assert.equal(asked[0].say.takes, 'reference');
  assert.equal(readFileSync(asked[0].say.reference, 'utf8'), 'RIFF');
  assert.equal(asked[0].say.reference_text, 'I said this.');
  assert.deepEqual(asked[0].say.loudness, settings.loudness);
});

test('when no voice can be made the answer is an error with every reason, so the device keeps the notice and asks again', async () => {
  const { door } = await accountOf();
  await assert.rejects(sayHere({ text: 'Hello.', out: path.join(folder, 'none.wav') }, { door, settings, ask: modelFor(['mlx-community/Kokoro-82M-bf16']) }),
    /No voice could be made on this computer: neutral: mlx-community\/Kokoro-82M-bf16 cannot run here/);
  await assert.rejects(sayHere({ text: '  ', out: path.join(folder, 'none.wav') }, { door, settings, ask: modelFor() }), /Give the words to say\./);
  await assert.rejects(sayHere({ text: 'x'.repeat(settings.longest_text + 1), out: path.join(folder, 'none.wav') }, { door, settings, ask: modelFor() }), /split it/);
});

test('tool:say-with-a-voice-model keeps the sound in the person\'s files and leaves nothing on the computer', async () => {
  const { door, kept, putRows } = await accountOf();
  await putRows('places', [{ id: 'car', values: { speed: 3 } }]);
  let made = null;
  const answer = await speakTools.say({ text: 'Three stores said yes.', place: 'car' }, { door }, { settings, ask: async request => { made = request.say.out; return modelFor()(request); } });
  assert.equal(answer.voice.id, 'neutral');
  assert.equal(answer.speed, 3);
  assert.match(answer.name, /^\/Voice\/Said\/\d{4}-\d\d-\d\d \d\d-\d\d-\d\d A calm neutral voice\.wav$/);
  assert.equal(answer.file, `1f:${'b'.repeat(64)}`);
  assert.equal(String(kept.get(answer.name)), 'RIFF');
  assert.equal(answer.text, 'Three stores said yes.');
  assert.throws(() => readFileSync(made), /ENOENT/);
  await assert.rejects(speakTools.say({ text: 'Hello.', place: 'moon' }, { door }, { settings, ask: modelFor() }), /There is no place moon/);
});

test('tool:voices makes, lists, chooses and removes the person\'s voices as rows of their Voices list', async () => {
  const { door, kept, rowsOf } = await accountOf({ '/Voice/Me talking.wav': 'RIFF' });
  const asked = [];
  const made = await speakTools.voices({ make: { recording: '/Voice/Me talking.wav' } }, { door }, { settings, ask: modelFor([], asked) });
  const voice = made.voices.find(row => row.own);
  assert.equal(made.chosen, voice.id);
  assert.equal(voice.engine, 'qwen3-tts');
  assert.deepEqual(asked[0].reference.window, settings.make.window);
  const rows = new Map(rowsOf('voices').map(row => [row.id, row.values]));
  // The shared voice became a row the person can choose and set a speed on; the new voice is the chosen one.
  assert.equal(rows.get('neutral').label, 'A calm neutral voice');
  assert.equal(rows.get(voice.id).chosen, 'Chosen');
  assert.equal(rows.get('neutral').chosen, undefined);
  assert.equal(rows.get(voice.id).reference_text, 'Every word of it.');
  assert.equal(String(kept.get(rows.get(voice.id).reference)), 'RIFF');
  assert.equal(kept.has('/Voice/voices.json'), false);
  assert.match(made.said, /Your voice was made from 9\.1 seconds/);

  assert.equal((await speakTools.voices({}, { door }, { settings })).chosen, voice.id);
  assert.equal((await speakTools.voices({ choose: 'neutral' }, { door }, { settings })).chosen, 'neutral');
  assert.equal(rowsOf('voices').find(row => row.id === voice.id).values.chosen, undefined);
  await assert.rejects(speakTools.voices({ choose: 'robot' }, { door }, { settings }), /There is no voice robot/);
  await assert.rejects(speakTools.voices({ remove: 'neutral' }, { door }, { settings }), /cannot be removed/);
  const removed = await speakTools.voices({ remove: voice.id }, { door }, { settings });
  assert.deepEqual(removed.voices.map(row => row.id), ['neutral']);
  assert.deepEqual(rowsOf('voices').map(row => row.id), ['neutral']);
  await assert.rejects(speakTools.voices({ make: {} }, { door }, { settings }), /Give a recording/);
});
