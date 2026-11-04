// src/account-transcription.mjs
//
// PURPOSE
//   tool:transcribe-file (records/workshop-account-tool-records.json), run inside the person's own store on
//   placement:this-account: the words said in one audio or video file in their Trillion files, heard by Whisper and
//   kept beside the file as its `transcript` result with every word's own seconds (src/transcript-words.mjs), which
//   the Media words count, search moments, captions and the editor's Words panel read. The person store's account
//   action map hands its own store in (`transcribeAccountFile(this, input)`).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A kept transcript is reused when it has word timings, or when this tool already heard these bytes; one saved
//      elsewhere with text only is heard again, so captions and picking a stretch by its words work.
//   2. A video is heard through its sound alone (tool:extract-sound, a mono MP3 of about 0.5 MB a minute, run once
//      per video through the person's own Workshop), so a long video fits what Whisper takes; the transcript is still
//      kept under the video's identity.
//   3. Nothing is guessed: no text from the model is a failure, never an empty transcript.
//   4. The sound taken out of a video is a step of hearing it, not a file the person made: once the words are kept,
//      its name leaves their files (only while the name still holds those bytes), so Media never lists a sound.mp3
//      per video. A failed hearing keeps it, so the next try reuses the take-out.
//   5. The speech model refuses good sound at random ("Failed to decode audio file" for bytes it heard a moment
//      before: measured 2026-09-30 at about one answer in three, one at a time or several at once), so one file is
//      asked up to HEARING.tries times, the pause doubling from HEARING.first_pause_ms; only the last refusal is the
//      run's failure. A run that still fails is started again by the rule that started it (the tool row's `retry`,
//      src/automations.mjs).
//   6. Sound is heard a piece at a time (PIECE.seconds each). Asked for a whole recording at once, the speech model
//      answers for only part of it and says nothing about the rest (measured 2026-10-02: a 608 s clip came back
//      ending at 345 s, a 949 s clip at about 60 s). The taken-out sound runs at a fixed PIECE.bytes_per_second
//      (tool:extract-sound writes 64 kbit/s), so a byte offset is an exact time: each piece starts on a frame boundary
//      and its words are moved by that piece's start, so every time stays seconds from the start of the recording.
//      A piece with nothing said in it is silence, not a failure; the whole recording with nothing said still is.
//      Any recording longer than one piece is taken out first, so long audio is heard whole too.
//   7. Trillion pays for no hearing the person did not set a budget for (src/placement.json job hear-a-recording):
//      a recording is heard by one of the person's awake devices that keeps the job's tool (tool:hear-a-recording-on-
//      this-mac, the Mac's own speech model, reading the file from their files), and by Whisper here only inside their
//      `trillion-work-day` budget; with neither, the run fails with words saying it waits, and the rule that asked
//      tries again (the tool rows' `retry` reaches about a day).
//   8. What the person said about their meetings is used when Whisper here hears: the one language they chose and
//      their custom words as its vocabulary (parts/record-audio/read-data/meeting-settings.mjs hearingOptions). With
//      none set, Whisper detects the language and hears no vocabulary, exactly as before.
//   9. A language chosen by the person ("Reprocess in", input `language`) is heard again by Whisper here even when words
//      are kept, unless the kept words were already heard in that language, and it replaces the language of invariant 8.
//      It never runs on a device (their speech model hears the language it detects): the run says so rather than keeping
//      words in another language.

import { hasWordTimings, timedTranscript } from './transcript-words.mjs';
import { MEETING_SETTINGS_PREFERENCE, hearingOptions } from '../../record-voice-and-meetings/read-data/meeting-settings.mjs';

const MODEL = '@cf/openai/whisper-large-v3-turbo';
const HEARING = { tries: 4, first_pause_ms: 1500 };
const PIECE = { seconds: 60, bytes_per_second: 8000 };
const PIECE_BYTES = PIECE.seconds * PIECE.bytes_per_second;
const MOST_SOUND_BYTES = 25_000_000;
const NOTHING_SAID = 'Whisper returned no transcript text.';
const WAITING = 'Waiting for your computer to hear this recording. Its words arrive once your Mac is awake and connected to Trillion.';

const base64 = bytes => {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};

// The first MP3 frame header at or after `from` (11 sync bits, then a layer III mark), so a piece never starts
// mid-frame; the end of the bytes when there is none.
const frameAt = (bytes, from) => {
  for (let at = from; at + 1 < bytes.length; at += 1) if (bytes[at] === 0xff && (bytes[at + 1] & 0xe6) === 0xe2) return at;
  return bytes.length;
};

const shifted = (value, by) => value.segments.map(segment => ({
  ...segment, start: segment.start + by, end: segment.end + by,
  ...(segment.words ? { words: segment.words.map(word => ({ ...word, start: word.start + by, end: word.end + by })) } : {}),
}));

/**
 * What was said in taken-out sound (a constant-rate MP3), heard PIECE.seconds at a time (invariant 6). `chunks` is
 * the sound's bytes in order (a stream or any async iterable of Uint8Array); only about one piece is held at once, so
 * a recording of any length is heard without holding all of it.
 */
export async function hearInPieces(ai, chunks, options = {}) {
  const segments = [];
  const texts = [];
  let language = null;
  let held = new Uint8Array(0);
  let heldFrom = 0;
  const hearPiece = async piece => {
    let value = null;
    try { value = await hear(ai, base64(piece), options); }
    catch (error) { if (String(error?.message) !== NOTHING_SAID) throw error; }
    if (value) {
      segments.push(...shifted(value, heldFrom / PIECE.bytes_per_second));
      texts.push(value.text);
      language ??= value.language ?? null;
    }
    heldFrom += piece.length;
  };
  for await (const part of chunks) {
    const chunk = part instanceof Uint8Array ? part : new Uint8Array(part);
    const joined = new Uint8Array(held.length + chunk.length);
    joined.set(held); joined.set(chunk, held.length);
    held = joined;
    // A piece is cut only once a frame header after it has arrived, so it never ends mid-frame.
    while (held.length > PIECE_BYTES) {
      const end = frameAt(held, PIECE_BYTES);
      if (end >= held.length) break;
      await hearPiece(held.subarray(0, end));
      held = held.slice(end);
    }
  }
  if (held.length) await hearPiece(held);
  if (!texts.length) throw new Error(NOTHING_SAID);
  return { text: texts.join(' '), segments, ...(language ? { language } : {}) };
}
const PRODUCER = 'tool:transcribe-file';
const IDENTITY = /^1f:[0-9a-f]{64}$/;

/**
 * What the speech model heard in `audio` (base64), as the kept transcript shape: asked again after a pause when it
 * refuses or hears nothing, at most HEARING.tries times (invariant 4). `pause(ms)` is injected for tests; `hints` is
 * { language?, initial_prompt? } handed to the model with the sound (invariant 8).
 */
export async function hear(ai, audio, { pause = ms => new Promise(resolve => setTimeout(resolve, ms)), hints = {} } = {}) {
  let refused;
  for (let attempt = 0; attempt < HEARING.tries; attempt += 1) {
    if (attempt) await pause(HEARING.first_pause_ms * 2 ** (attempt - 1));
    try {
      const value = timedTranscript(await ai.run(MODEL, { audio, ...hints }));
      if (value.text) return value;
      refused = new Error('Whisper returned no transcript text.');
    } catch (error) { refused = error; }
  }
  throw refused;
}

/**
 * The identity of a video's sound as a small audio file, taken out by tool:extract-sound through `workshop` (the
 * person's own Workshop: run, read). The same video asks under the same request, so it is taken out once; a failed
 * take-out is tried once more; a run still working is read again every `every_ms` for at most `at_most_ms`.
 */
export async function soundOfVideo(workshop, identity, options) {
  return (await takeSoundOut(workshop, identity, options)).identity;
}

/** The sound taken out of a video: its identity and the name it was kept under ({ identity, name }). */
async function takeSoundOut(workshop, identity, options) {
  const run = await runToEnd(workshop, { tool_id: 'tool:extract-sound', input: { video: identity }, request_key: `transcribe-sound:${identity}` }, options);
  const sound = run.output?.files?.sound;
  if (run.state !== 'completed' || !sound?.identity) throw new Error(run.error ? `The sound could not be taken out of this video: ${run.error}` : 'Taking the sound out of this video did not finish.');
  return { identity: sound.identity, name: typeof sound.name === 'string' ? sound.name : null };
}

/**
 * One Workshop run read until it ends: a failed run is asked once more under a fresh key; a run still working is read
 * again every `every_ms` for at most `at_most_ms`.
 */
export async function runToEnd(workshop, { tool_id, input, request_key }, { every_ms = 3000, at_most_ms = 900000 } = {}) {
  const ask = key => workshop.run({ tool_id, input, request_key: key, wait_seconds: 50 });
  let run = await ask(request_key);
  if (run.state === 'failed') run = await ask(`${request_key}:${Date.now()}`);
  for (const until = Date.now() + at_most_ms; run.state === 'working' && Date.now() < until;) {
    await new Promise(resolve => setTimeout(resolve, every_ms));
    run = await workshop.read({ task_id: run.task_id });
  }
  return run;
}

/** What one of the person's awake devices heard in the file (placement.json `devices`), kept as this file's words. */
async function heardOnDevice(workshop, device, identity, options) {
  const run = await runToEnd(workshop, { tool_id: device.tool_id, input: { file: identity }, request_key: `hear-on-device:${identity}` }, options);
  if (run.state !== 'completed' || typeof run.output?.text !== 'string') throw new Error(run.error ? `Your device could not hear this recording: ${run.error}` : 'Your device did not finish hearing this recording.');
  const { produced_by, ...value } = run.output;
  return { value: { ...value, heard_whole: true }, produced_by: typeof produced_by === 'string' ? produced_by : device.tool_id };
}

/**
 * The words said in one file. `store` is the person's store: results.read(identity, kind), namespaceFiles().open(id)
 * -> { media_type, byte_length, stream() }, namespaceResults('put', rows), meteredAi(purpose) (the AI binding's run, counted by src/model-calls.mjs), workshop(),
 * placeWork(job) -> { pays, device? } (src/placement.json, where the hearing runs).
 */
export async function transcribeAccountFile(store, { identity, language = null } = {}) {
  if (typeof identity !== 'string' || !IDENTITY.test(identity)) throw new Error('Transcription needs a file identity.');
  if (language !== null && !(typeof language === 'string' && /^[a-z]{2,3}$/.test(language))) throw new Error('Transcription needs a language code such as en or es.');
  const existing = store.results.read(identity, 'transcript').results[0];
  // This tool's own transcripts from before sound was heard in pieces may cover only the start (invariant 6): only one
  // marked heard_whole is reused; a transcript made elsewhere is reused when it has word timings, or when it says it
  // heard the whole recording (a computer that heard a silent clip keeps empty words, which are still its answer).
  const keptFor = existing && (existing.value?.heard_whole === true || (existing.produced_by !== PRODUCER && hasWordTimings(existing.value)));
  // A language asked for is heard again unless the kept words were already heard in it (invariant 8).
  const reusable = language ? existing?.value?.language === language && keptFor : keptFor;
  if (reusable) return { identity, text: existing.value.text ?? '', segments: existing.value.segments ?? [], already_recorded: true };
  const files = store.namespaceFiles();
  const file = await files.open(identity);
  if (!/^\s*(audio|video)\//i.test(file.media_type ?? '')) return { identity, skipped: true, said: 'This file is not audio or video.' };
  // Where it is heard (invariant 7): one of the person's awake devices, else Trillion's speech model only inside the
  // budget they set, else it waits for a device and the rule that asked tries again.
  const place = await store.placeWork('hear-a-recording');
  if (place.device && language) throw new Error('Your computer hears a recording in the language it detects. Hearing it in a language you choose runs on Trillion, inside the budget you set for hearing recordings.');
  if (place.device) {
    const heardThere = await heardOnDevice(store.workshop(), place.device, identity);
    const keptThere = await store.namespaceResults('put', [{ identity, kind: 'transcript', ...heardThere }]);
    if (keptThere.refused?.length) throw new Error(`The transcript could not be saved: ${keptThere.refused[0].reason}`);
    return { identity, ...heardThere.value, already_recorded: false };
  }
  if (place.pays !== 'trillion') throw new Error(WAITING);
  const hints = hearingOptions(store.store?.eeaf?.read?.(`workspace-preference:${MEETING_SETTINGS_PREFERENCE}`));
  const spoken = language ? { ...hints, language } : hints;
  const takeOut = /^\s*video\//i.test(file.media_type) || file.byte_length > PIECE_BYTES;
  const sound = takeOut ? await takeSoundOut(store.workshop(), identity) : null;
  const heard = sound ? await files.open(sound.identity) : file;
  if (!sound && heard.byte_length > MOST_SOUND_BYTES) throw new Error('Whisper takes at most 25 MB of sound at once.');
  const value = sound
    ? await hearInPieces(store.meteredAi('transcription'), await heard.stream(), { hints: spoken })
    : await hear(store.meteredAi('transcription'), base64(new Uint8Array(await new Response(await heard.stream()).arrayBuffer())), { hints: spoken });
  const kept = await store.namespaceResults('put', [{ identity, kind: 'transcript', value: { ...value, ...(language ? { language } : {}), heard_whole: true }, produced_by: PRODUCER }]);
  if (kept.refused?.length) throw new Error(`The transcript could not be saved: ${kept.refused[0].reason}`);
  if (sound?.name && (await store.namespaceByName(sound.name))?.identity === sound.identity) await store.namespacePutNames([{ name: sound.name, remove: true }]);
  return { identity, ...value, already_recorded: false };
}
