// tools/listen-for-a-while/read-data/hands-free.mjs
//
// PURPOSE
//   The hands-free voice loop: the microphone is read as a stream; speech is cut out of it by loudness (voice activity);
//   each utterance is heard on this Mac (the hearing row of computer/computer-sources.json, mlx-whisper); the words go
//   through the voice session (read-data/voice-session.mjs: a wake phrase opens it, silence or a spoken dismissal ends it);
//   what the session hands on is answered by a model on this Mac (computer/local-models.mjs, the `hands-free` job row of
//   records/local-model-records.json) and the answer is said aloud (computer/speak.mjs). It was tool:talk-hands-free.
//   Moved here: the voice activity and the loop over injected parts (hear, think, say, play). Not moved: the real parts
//   on the Mac (realParts, startCapture) and the tool entry that kept a loop running between calls; see README.md, Not yet.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: the capture program, loudness numbers, hearing row, model job, play program and every sentence are
//      read-data/hands-free.json (and the rows it names). A different microphone program, threshold or model is a data edit.
//   2. Idle is private: while no session is open, an utterance is heard only to look for the wake phrase; its words are
//      kept nowhere and sent nowhere, and the answer model is never asked. Nothing here writes a transcript to disk: only
//      counts are kept (status).
//   3. The loop never answers its own voice: the stream is let go while the answer is said and for `say.mute_tail_ms`.
//   4. The speech model's failure is told in words and the text answer is kept in the result; it never falls back to a
//      system voice (computer/speak.mjs invariant 3).
//   5. The session ends the history: the model is shown only the turns of the open session.
//
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeVoiceSession } from './voice-session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const handsFreeSettings = () => JSON.parse(readFileSync(path.join(HERE, 'hands-free.json'), 'utf8'));
const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** Raw 16-bit little-endian mono sound as a WAV file's bytes. */
export function wavOf(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Loudness of one frame of 16-bit samples, 0 to 1. */
const loudness = frame => {
  let sum = 0;
  for (let at = 0; at + 1 < frame.length; at += 2) { const sample = frame.readInt16LE(at) / 32768; sum += sample * sample; }
  return Math.sqrt(sum / Math.max(1, frame.length / 2));
};

/** Voice activity over a stream of sound: push(chunk) -> the utterances (Buffers of raw sound) closed by that chunk; flush() closes an open one. */
export function makeVad(vad, sampleRate) {
  const frameBytes = Math.round(sampleRate * vad.frame_ms / 1000) * 2;
  const frames = ms => Math.max(1, Math.round(ms / vad.frame_ms));
  let rest = Buffer.alloc(0), floor = null, run = 0, quiet = 0, open = null;
  const preroll = [];
  const close = out => {
    const sound = Buffer.concat(open.frames);
    const length = (open.frames.length - open.lead - quiet) * vad.frame_ms;
    open = null; quiet = 0; run = 0;
    if (length >= vad.min_utterance_ms) out.push(sound);
  };
  const take = (frame, out) => {
    const level = loudness(frame);
    const over = Math.max(vad.threshold, (floor ?? 0) * vad.floor_multiple);
    const speech = level > over;
    if (!speech) floor = floor === null ? level : floor * 0.95 + level * 0.05;
    if (open) {
      open.frames.push(frame);
      quiet = speech ? 0 : quiet + 1;
      if (quiet >= frames(vad.hangover_ms) || open.frames.length * vad.frame_ms >= vad.max_utterance_ms) close(out);
      return;
    }
    preroll.push(frame);
    while (preroll.length > frames(vad.preroll_ms) + vad.start_frames) preroll.shift();
    run = speech ? run + 1 : 0;
    if (run >= vad.start_frames) { const lead = preroll.splice(0); open = { frames: lead, lead: Math.max(0, lead.length - vad.start_frames) }; quiet = 0; run = 0; }
  };
  return {
    push(chunk) {
      const out = [];
      rest = Buffer.concat([rest, chunk]);
      while (rest.length >= frameBytes) { take(rest.subarray(0, frameBytes), out); rest = rest.subarray(frameBytes); }
      return out;
    },
    flush() { const out = []; if (open) { quiet = frames(vad.hangover_ms); close(out); } return out; },
  };
}

/**
 * The loop over injected parts so tests hold pretend ones. `hear(file)` -> { text }; `think(messages)` -> the answer's
 * words; `say(text)` -> a sound file or null; `play(file)` plays it. feed(chunk) takes sound; done() finishes what is queued.
 */
export function makeHandsFree({ settings = handsFreeSettings(), session = makeVoiceSession(), hear, think, say, play, now = () => Date.now(), folder, log = () => {} }) {
  const vad = makeVad(settings.vad, settings.capture.sample_rate);
  const state = { utterances: 0, handled: 0, replies: 0, last_error: null };
  let history = [];
  let mutedUntil = 0;
  let queue = Promise.resolve();

  async function handle(sound) {
    state.utterances += 1;
    const file = path.join(folder, `utterance-${process.pid}-${state.utterances}.wav`);
    writeFileSync(file, wavOf(sound, settings.capture.sample_rate), { mode: 0o600 });
    let text;
    try { text = (await hear(file))?.text ?? ''; } finally { rmSync(file, { force: true }); }
    const result = session.heard(text);
    if (result.ended) { history = []; log({ ended: result.ended }); }
    if (!result.handle) return { heard: false, ...(result.ended ? { ended: result.ended, said: result.said } : {}) };
    state.handled += 1;
    history.push({ role: 'user', content: result.text });
    history = history.slice(-settings.think.history_turns * 2);
    let answer;
    try { answer = String(await think([{ role: 'system', content: settings.think.system }, ...history]) ?? '').trim(); }
    catch (error) { state.last_error = String(error?.message ?? error); return { heard: true, request: result.text, error: settings.words.no_answer }; }
    if (!answer) return { heard: true, request: result.text, error: settings.words.no_answer };
    history.push({ role: 'assistant', content: answer });
    state.replies += 1;
    const row = { heard: true, request: result.text, answer };
    try {
      const sound = await say(answer);
      if (sound) {
        mutedUntil = Infinity;
        try { await play(sound); } finally { mutedUntil = now() + settings.say.mute_tail_ms; rmSync(sound, { force: true }); }
      }
    } catch (error) { row.not_said = fill(settings.words.no_voice, { why: String(error?.message ?? error) }); state.last_error = row.not_said; }
    return row;
  }

  const enqueue = (sounds, events) => { for (const sound of sounds) queue = queue.then(async () => { try { events.push(await handle(sound)); } catch (error) { state.last_error = String(error?.message ?? error); events.push({ heard: false, error: state.last_error }); } }); };
  const events = [];
  return {
    feed(chunk) { if (now() >= mutedUntil) enqueue(vad.push(chunk), events); },
    async done() { enqueue(vad.flush(), events); await queue; return events.splice(0); },
    state: () => ({ ...state, session: session.state() }),
    session,
  };
}

/** Runs the loop over a sound stream until it ends; resolves with every event. */
export async function runLoop(loop, stream) {
  for await (const chunk of stream) loop.feed(chunk);
  return loop.done();
}
