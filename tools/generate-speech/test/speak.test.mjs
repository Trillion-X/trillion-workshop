// tools/generate-speech/test/speak.test.mjs
//
// Speaking in a natural voice: read-data/speak.mjs (tool:say-with-a-voice-model and tool:voices) says words with the
// voice asked for, else the person's chosen one, else the shared voices in order, passing over a voice that cannot be
// made, and keeps the request when none can; the person's voices and speeds are rows of their own lists handed in as
// input, with reference recordings as files on this computer, and every sound is made at its natural pace and answered
// with the place's speed. No records door is handed to any run: the tools read and write no records. The speech model
// itself stands in as a stub `ask`. Moved from the product repo's test/speak.test.mjs with its assertions; its notice
// and account-placement tests stay with the product repo's Mac app and src/account-speech.mjs.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { say, sayHere, speakSettings, voiceOrder, voices, personFromRows } from '../read-data/speak.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import toolRows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

const folder = tempFolder(path.join(os.tmpdir(), 'speak-test-'));
test.after(() => rmSync(folder, { recursive: true, force: true }));
const settings = speakSettings();
const referenceFile = path.join(folder, 'own-1.wav');
writeFileSync(referenceFile, 'RIFF');
const own = { id: 'own-1', label: 'Your own voice', engine: 'qwen3-tts', reference: referenceFile, reference_text: 'I said this.' };
const ownRow = { id: own.id, values: { label: own.label, engine: own.engine, reference: own.reference, reference_text: own.reference_text, chosen: 'Chosen', speed: 0.8 } };
const personWithOwn = () => personFromRows({ voices: [ownRow] }, settings);

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
  const person = personWithOwn();
  const asked = [];
  await assert.rejects(sayHere({ text: 'Use this exact voice.', voice: 'robot', out: path.join(folder, 'strict-unknown.wav') },
    { settings, person, allowFallback: false, ask: modelFor([], asked) }), /There is no voice robot/);
  assert.equal(asked.length, 0);
  await assert.rejects(sayHere({ text: 'Use this exact voice.', voice: own.id, out: path.join(folder, 'strict-failed.wav') },
    { settings, person, allowFallback: false, ask: modelFor(['mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16'], asked) }), /cannot run here/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].say.takes, 'reference');
  const made = await sayHere({ text: 'Use this exact voice.', voice: own.id, out: path.join(folder, 'strict-ok.wav') },
    { settings, person, allowFallback: false, ask: modelFor() });
  assert.equal(made.voice.id, own.id);
});

test('a voice that cannot be made is passed over with why, and the next one says it', async () => {
  const person = personWithOwn();
  const asked = [];
  const out = path.join(folder, 'one.wav');
  const made = await sayHere({ text: 'Your print job is ready.', out }, { settings, person, ask: modelFor(['mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16'], asked) });
  // The chosen voice's speed comes back for the player; the model was asked at its natural pace.
  assert.equal(made.speed, 0.8);
  assert.equal('speed' in asked[0].say, false);
  assert.equal(made.voice.id, 'neutral');
  assert.equal(made.engine, 'kokoro');
  assert.deepEqual(made.passed_over.map(item => item.voice), ['own-1']);
  assert.match(made.passed_over[0].why, /cannot run here/);
  // The cloned voice was asked with the person's reference, the file on this computer its row names, and its words.
  assert.equal(asked[0].say.takes, 'reference');
  assert.equal(readFileSync(asked[0].say.reference, 'utf8'), 'RIFF');
  assert.equal(asked[0].say.reference_text, 'I said this.');
  assert.deepEqual(asked[0].say.loudness, settings.loudness);
});

test('a voice whose reference is not a file on this computer is passed over with why', async () => {
  const person = personFromRows({ voices: [{ id: 'own-2', values: { ...ownRow.values, reference: path.join(folder, 'missing.wav') } }] }, settings);
  const made = await sayHere({ text: 'Hello.', out: path.join(folder, 'missing-reference.wav') }, { settings, person, ask: modelFor() });
  assert.equal(made.voice.id, 'neutral');
  assert.match(made.passed_over[0].why, /is not a file on this computer/);
});

test('when no voice can be made the answer is an error with every reason, so the device keeps the notice and asks again', async () => {
  await assert.rejects(sayHere({ text: 'Hello.', out: path.join(folder, 'none.wav') }, { settings, ask: modelFor(['mlx-community/Kokoro-82M-bf16']) }),
    /No voice could be made on this computer: neutral: mlx-community\/Kokoro-82M-bf16 cannot run here/);
  await assert.rejects(sayHere({ text: '  ', out: path.join(folder, 'none.wav') }, { settings, ask: modelFor() }), /Give the words to say\./);
  await assert.rejects(sayHere({ text: 'x'.repeat(settings.longest_text + 1), out: path.join(folder, 'none.wav') }, { settings, ask: modelFor() }), /split it/);
});

test('tool:say-with-a-voice-model hands exact bytes to the original-result-bound output owner and reads no store', async () => {
  let made = null;
  const outputFolder = path.join(folder, 'said-output');
  const places = [{ id: 'car', values: { speed: 3 } }];
  const answer = await say({ text: 'Three stores said yes.', place: 'car', voices: [], places }, undefined, { settings, outputFolder, ask: async request => { made = request.say.out; return modelFor()(request); } });
  assert.equal(answer.voice.id, 'neutral');
  assert.equal(answer.speed, 3);
  const expected = makeHashCodeHexFromBytes(Buffer.from('RIFF'));
  assert.equal(answer.file, expected);
  assert.deepEqual(answer.files, [{ name: settings.keep.name, bytes: 4, blake3: expected.slice(3) }]);
  assert.equal(readFileSync(path.join(outputFolder, answer.files[0].name), 'utf8'), 'RIFF');
  assert.equal('name' in answer, false, 'the producer must not invent the Namespace name the engine has not kept yet');
  assert.equal(answer.text, 'Three stores said yes.');
  assert.ok(!JSON.stringify(answer).includes(folder), 'no private scratch or declared local path is returned');
  assert.throws(() => readFileSync(made), /ENOENT/);
  await assert.rejects(say({ text: 'Hello.', place: 'moon', voices: [], places }, undefined, { settings, outputFolder: path.join(folder, 'failed-output'), ask: modelFor() }), /There is no place moon/);
});

test('an existing retained output refuses another generation instead of replacing the original bytes', async () => {
  const outputFolder = path.join(folder, 'retained-output');
  mkdirSync(outputFolder);
  const out = path.join(outputFolder, settings.keep.name);
  writeFileSync(out, 'original');
  let calls = 0;
  await assert.rejects(say({ text: 'Another request.' }, undefined, { settings, outputFolder, ask: async () => { calls++; } }), /retry the original tool request key/);
  assert.equal(calls, 0);
  assert.equal(readFileSync(out, 'utf8'), 'original');
});

test('failed, missing, empty and oversized sounds return no output manifest and remove scratch', async () => {
  let scratch;
  for (const kind of ['failed', 'too-large', 'empty', 'missing']) {
    const outputFolder = path.join(folder, kind);
    const limited = { ...settings, keep: { ...settings.keep, max_bytes: 3 } };
    await assert.rejects(say({ text: 'Synthetic words.' }, undefined, { settings: limited, outputFolder, ask: async request => {
      scratch = request.say.out;
      if (kind !== 'missing') writeFileSync(scratch, kind === 'empty' ? '' : 'RIFF');
      return kind === 'failed' ? { ok: false, error: 'synthetic refusal' } : { ok: true, seconds: 1 };
    } }), kind === 'failed' ? /synthetic refusal/ : kind === 'empty' ? /empty sound file/ : kind === 'missing' ? /ENOENT/ : /declared file limit/);
    assert.equal(existsSync(scratch), false);
    assert.equal(existsSync(outputFolder), false);
  }
});

test('the public rows declare no records door, and give the original result manifest to the existing output owner without a caller-selected path', () => {
  const rows = new Map(toolRows.records.map(record => [record.payload.id, record.payload]));
  for (const row of rows.values()) assert.equal(row.invoke.records, undefined, `${row.id} declares no records door`);
  const row = rows.get('tool:say-with-a-voice-model');
  const output = row.invoke.outputs[0];
  assert.equal(row.invoke.outputs.length, 1);
  assert.deepEqual(output, { name: 'speech', path: `/opt/generate-speech/${path.relative(path.resolve(import.meta.dirname, '..'), path.resolve(import.meta.dirname, '../read-data', settings.keep.folder))}`,
    keep_in: 'files', media_type: settings.keep.media_type, max_bytes: settings.keep.max_bytes,
    tree: { files_from: 'result.files', max_files: 1, max_bytes: settings.keep.max_bytes } });
  assert.equal(row.input_schema.additionalProperties, false);
  assert.equal(row.input_schema.properties.outputFolder, undefined, 'public input cannot select a local output path');
  assert.equal(row.result_selector, '$.result');
  assert.match('1f:' + 'a'.repeat(64), new RegExp(row.output_schema.properties.file.pattern));
  const made = rows.get('tool:voices').invoke.outputs[0];
  assert.deepEqual(made, { name: 'voice', path: `/opt/generate-speech/${path.relative(path.resolve(import.meta.dirname, '..'), path.resolve(import.meta.dirname, '../read-data', settings.make.keep.folder))}`,
    keep_in: 'files', media_type: settings.make.keep.media_type, max_bytes: settings.make.keep.max_bytes,
    tree: { files_from: 'result.files', max_files: 1, max_bytes: settings.make.keep.max_bytes } });
});

test('tool:voices makes the voice from a recording on this computer and returns the row and its reference sound; it keeps nothing', async () => {
  const recording = path.join(folder, 'Me talking.wav');
  writeFileSync(recording, 'RIFF');
  const outputFolder = path.join(folder, 'voice-output');
  const asked = [];
  const made = await voices({ recording, label: 'My own voice' }, undefined, { settings, outputFolder, ask: modelFor([], asked) });
  assert.equal(made.voice.values.engine, 'qwen3-tts');
  assert.equal(made.voice.values.label, 'My own voice');
  assert.equal(made.voice.values.reference_text, 'Every word of it.');
  assert.equal(made.voice.values.made_from, recording);
  assert.match(made.voice.id, /^own-/);
  assert.deepEqual(asked[0].reference.window, settings.make.window);
  const expected = makeHashCodeHexFromBytes(Buffer.from('RIFF'));
  assert.equal(made.file, expected);
  assert.deepEqual(made.files, [{ name: settings.make.keep.name, bytes: 4, blake3: expected.slice(3) }]);
  assert.equal(readFileSync(path.join(outputFolder, made.files[0].name), 'utf8'), 'RIFF');
  assert.match(made.said, /Your voice was made from 9\.1 seconds/);
  await assert.rejects(voices({ make: {} }, undefined, { settings, outputFolder: path.join(folder, 'none-output') }), /Give a recording/);
  await assert.rejects(voices({ recording: path.join(folder, 'nowhere.wav') }, undefined, { settings, outputFolder: path.join(folder, 'none-output'), ask: modelFor() }), /is not a file on this computer/);
  await assert.rejects(voices({ recording }, undefined, { settings, outputFolder, ask: modelFor() }), /retry the original tool request key/);
});
