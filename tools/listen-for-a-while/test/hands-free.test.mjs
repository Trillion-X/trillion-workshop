// tools/listen-for-a-while/test/hands-free.test.mjs
//
// The hands-free voice loop (read-data/hands-free.mjs): sound is cut into utterances by loudness, an idle loop hears only to
// find the wake phrase, a session answers and is ended by a spoken dismissal or silence, the loop never answers its own voice,
// and the loop never answers its own voice. The old REAL test (realParts and startCapture on a Mac) stays with those parts, which are not moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handsFreeSettings, makeHandsFree, makeVad, wavOf } from '../read-data/hands-free.mjs';
import { makeVoiceSession, voiceSettings } from '../read-data/voice-session.mjs';

const settings = handsFreeSettings();
const RATE = settings.capture.sample_rate;
const tone = (ms, amplitude = 0.3) => {
  const out = Buffer.alloc(Math.round(RATE * ms / 1000) * 2);
  for (let i = 0; i < out.length / 2; i += 1) out.writeInt16LE(Math.round(Math.sin(i * 0.3) * amplitude * 32767), i * 2);
  return out;
};
const silence = ms => Buffer.alloc(Math.round(RATE * ms / 1000) * 2);
const chunks = (buffer, size = 3200) => { const out = []; for (let at = 0; at < buffer.length; at += size) out.push(buffer.subarray(at, at + size)); return out; };

function pretend({ words, answers = ['It is Paris.'], now = () => Date.now(), spoken = [], voiceSettings: voice } = {}) {
  const heardAt = [];
  const queue = [...words];
  const session = makeVoiceSession({ now, ...(voice ? { settings: voice } : {}) });
  const asked = [];
  const loop = makeHandsFree({
    settings, session, now, folder: mkdtempSync(join(tmpdir(), 'hands-free-')),
    hear: async file => { assert.ok(existsSync(file)); heardAt.push(file); return { text: queue.shift() ?? '' }; },
    think: async messages => { asked.push(messages); return answers.shift() ?? 'Okay.'; },
    say: async text => { spoken.push(text); return null; },
    play: async () => {},
  });
  return { loop, heardAt, asked, spoken, session };
}
const feedAll = async (loop, buffer) => { for (const chunk of chunks(buffer)) loop.feed(chunk); return loop.done(); };

test('the voice activity cuts speech out of silence, keeps the lead-in, lets a blip go and closes a long one', () => {
  const vad = makeVad(settings.vad, RATE);
  const out = [...vad.push(Buffer.concat([silence(500), tone(1000), silence(1000), tone(100), silence(1000), tone(25000), silence(100)])), ...vad.flush()];
  assert.equal(out.length, 3, 'one utterance, the 100 ms blip let go, the long one closed at its limit and its rest kept');
  assert.ok(Math.abs(out[0].length / 2 / RATE * 1000 - (1000 + settings.vad.preroll_ms + settings.vad.hangover_ms)) < 200);
  assert.ok(out[1].length / 2 / RATE * 1000 <= settings.vad.max_utterance_ms + settings.vad.frame_ms);
});

test('an idle loop hears only for the wake phrase: no model is asked and nothing is said', async () => {
  const mac = pretend({ words: ['what a lovely day', 'the meeting is at three'] });
  const events = await feedAll(mac.loop, Buffer.concat([silence(500), tone(800), silence(1200), tone(800), silence(1200)]));
  assert.equal(mac.heardAt.length, 2);
  assert.deepEqual(events.map(event => event.heard), [false, false]);
  assert.equal(mac.asked.length, 0);
  assert.deepEqual(mac.spoken, []);
});

test('wake phrase, request, answer said, follow-up with history, spoken dismissal ends the session and its history', async () => {
  const mac = pretend({ words: ['Hey Trillion, what is the capital of France?', 'and of Spain', 'okay goodbye', 'and of Italy'], answers: ['Paris.', 'Madrid.'] });
  const events = await feedAll(mac.loop, Buffer.concat([silence(300), ...[0, 1, 2, 3].flatMap(() => [tone(800), silence(1200)])]));
  assert.deepEqual(events.map(event => [event.heard, event.answer ?? null, event.ended ?? null]), [[true, 'Paris.', null], [true, 'Madrid.', null], [false, null, 'dismissed'], [false, null, null]]);
  assert.deepEqual(mac.spoken, ['Paris.', 'Madrid.']);
  assert.equal(mac.asked[0].at(-1).content, 'what is the capital of france');
  assert.deepEqual(mac.asked[1].map(row => row.role), ['system', 'user', 'assistant', 'user'], 'the second request is shown the first turn');
  assert.equal(mac.asked.length, 2, 'after the dismissal the next words are not answered');
});

test('the session ends by itself on silence and the loop is quiet again', async () => {
  let clock = 1_000_000;
  const mac = pretend({ words: ['hey trillion tell me a joke', 'are you there'], now: () => clock });
  const first = await feedAll(mac.loop, Buffer.concat([tone(800), silence(1200)]));
  assert.equal(first[0].answer, 'It is Paris.');
  clock += voiceSettings().idle_seconds * 1000 + 1;
  const second = await feedAll(mac.loop, Buffer.concat([tone(800), silence(1200)]));
  assert.equal(second[0].heard, false);
  assert.equal(mac.asked.length, 1);
});

test('the loop lets go of sound while it is speaking and for the tail after, so it never answers itself', async () => {
  let clock = 5_000_000;
  const spoken = [];
  const session = makeVoiceSession({ now: () => clock });
  const heard = [];
  const loop = makeHandsFree({ settings, session, now: () => clock, folder: mkdtempSync(join(tmpdir(), 'hands-free-')),
    hear: async () => { heard.push(1); return { text: 'hey trillion say hello' }; }, think: async () => 'Hello.',
    say: async text => { spoken.push(text); return join(tmpdir(), 'nothing.wav'); },
    play: async () => { for (const chunk of chunks(Buffer.concat([tone(800), silence(1200)]))) loop.feed(chunk); } });
  for (const chunk of chunks(Buffer.concat([tone(800), silence(1200)]))) loop.feed(chunk);
  await loop.done();
  assert.equal(heard.length, 1, 'the sound made while playing was dropped');
  for (const chunk of chunks(Buffer.concat([tone(800), silence(1200)]))) loop.feed(chunk);
  await loop.done();
  assert.equal(heard.length, 1, 'and so was sound within the tail');
  clock += settings.say.mute_tail_ms + 1;
  for (const chunk of chunks(Buffer.concat([tone(800), silence(1200)]))) loop.feed(chunk);
  await loop.done();
  assert.equal(heard.length, 2);
});

test('a model that does not answer, or a voice that cannot be made, is told in words and the text answer is kept', async () => {
  const none = pretend({ words: ['hey trillion hello'], answers: [''] });
  assert.equal((await feedAll(none.loop, Buffer.concat([tone(800), silence(1200)])))[0].error, settings.words.no_answer);
  const loop = makeHandsFree({ settings, folder: mkdtempSync(join(tmpdir(), 'hands-free-')), hear: async () => ({ text: 'hey trillion hello' }),
    think: async () => 'Hi.', say: async () => { throw new Error('no voice'); }, play: async () => {} });
  const [row] = await feedAll(loop, Buffer.concat([tone(800), silence(1200)]));
  assert.equal(row.answer, 'Hi.');
  assert.match(row.not_said, /could not be said aloud: no voice/);
});

test('wavOf writes a readable header', () => {
  const wav = wavOf(tone(100), RATE);
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), RATE);
  assert.equal(wav.readUInt32LE(40), tone(100).length);
});
