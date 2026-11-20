// tools/generate-speech/read-data/speak.mjs
//
// Purpose
//   Says words in a natural voice made by a speech model on the person's own computer: their own cloned voice or a
//   neutral one, never a paid service. Run as functions by tools/workflows/do-work/run-a-function.mjs, which hands
//   them only their input: this file reads and writes no records.
//     say    (tool:say-with-a-voice-model) { text, voice?, place?, voices?, places?, speech_python? } -> the sound, as the run's declared output
//     voices (tool:voices)                 { recording, label?, speech_python? } -> the voice made from that recording, with its reference sound as the run's declared output
//   Moved from the product repo's computer/speak.mjs (speakTools, sayHere, voiceOrder) with the voice and speed of a
//   place from src/voices.mjs (voiceFor).
//
// Non-negotiable invariants
//   1. Every program, model, voice, number and word is DATA (read-data/speak.json); this file names none of them.
//   2. A person's own voices, the voice they chose and every speed are theirs: rows of their own Voices list and their
//      list of places Trillion speaks, kept by their AI in a store and handed to this tool as input rows
//      ({ id, values }); a row's `reference` names a reference sound as a file on this computer. This tool keeps
//      none of it. The shared voices of speak.json speak when no row names one.
//   3. A voice is said with the voice asked for, else the chosen one, else the shared voices in order; a voice that
//      cannot be made is passed over with why, and only when none can is the answer an error (the caller keeps the words
//      and asks again; it never falls back to a system voice). An unknown voice id asked for by name is an error, never
//      a silent substitute.
//   4. A reference is only ever made by the speech program's `reference` road, which picks a stretch ending where a
//      sentence ends (do-work/speak-with-mlx.py invariant 2).
//   5. A sound is made at its natural pace: the answer carries the place's `speed`, and whoever plays it applies it with
//      the pitch kept, so every speed from the slowest to the fastest plays the same made sound.
//   6. Scratch recordings are removed when the function returns. The declared output stays in the private run folder
//      until the engine keeps it in Files and accepts completion. The original request key replays that process
//      result and resumes delivery; this producer owns no retry receipt or upload.
import { execFile } from 'node:child_process';
import { constants, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHashCodeHasher } from '../../content-identity/read-data/identity.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(new URL(import.meta.url)));
export const speakSettings = () => JSON.parse(readFileSync(path.join(HERE, 'speak.json'), 'utf8'));
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const expand = place => String(place).replace(/^~(?=\/|$)/, os.homedir());
const said = (template, values, status) => Object.assign(new Error(fill(template, values)), status ? { status } : {});

/** Every voice the person can be spoken to in: their rows first, then any shared voice not yet a row of theirs. */
export const allVoices = (person, settings) => {
  const theirs = person?.voices ?? [];
  return [...theirs, ...settings.voices.filter(voice => !theirs.some(row => row.id === voice.id))];
};

/**
 * The voices to try, in order (invariant 3): the one asked for, else the person's chosen one, then the shared voices.
 * An asked id that names no voice throws its words.
 */
export function voiceOrder({ asked = null, person = null, settings, allowFallback = true }) {
  const every = allVoices(person, settings);
  const byId = new Map(every.map(voice => [voice.id, voice]));
  if (asked && !byId.has(asked)) throw said(settings.words.unknown_voice, { voice: asked, voices: every.map(voice => voice.id).join(', ') }, 400);
  const first = byId.get(asked ?? person?.chosen ?? '') ?? null;
  if (!allowFallback) {
    if (!first) throw said(settings.words.unknown_voice, { voice: asked ?? person?.chosen ?? '', voices: every.map(voice => voice.id).join(', ') }, 400);
    return [first];
  }
  return [...new Set([first, ...settings.voices.map(voice => byId.get(voice.id))].filter(Boolean))];
}

/** The chosen mark: the one choice of the Voices list's `chosen` field. */
export const chosenMark = settings => settings.lists.voices.fields.find(field => field.id === 'chosen').choices[0];

/** A speed within the scale, or null when `value` is not a speed at all (unset, zero, not a number). */
export function speedWithin(value, scale) {
  const speed = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(speed) || speed <= 0) return null;
  return Math.min(scale.max, Math.max(scale.min, speed));
}

/** The voice and speed of a place (src/voices.mjs voiceFor): the place's voice, else the chosen one; its speed, else the voice's. */
export function voiceFor({ place = null, voices, places, settings }) {
  const placeRow = place ? places.find(row => row.id === place) : null;
  if (place && !placeRow) throw said(settings.words.unknown_place, { place, places: places.map(row => row.id).join(', ') }, 400);
  const linked = Array.isArray(placeRow?.values.voice) ? placeRow.values.voice[0] : null;
  const voice = voices.find(row => row.id === linked) ?? voices.find(row => row.values.chosen === chosenMark(settings)) ?? null;
  const speed = speedWithin(placeRow?.values.speed, settings.speed) ?? speedWithin(voice?.values.speed, settings.speed) ?? settings.speed.default;
  return { voice: voice ? { id: voice.id, ...voice.values } : null, speed };
}

/** The person's voices and the voice and speed of `place` from rows handed in ({ id, values } of the two lists). */
export function personFromRows({ voices = [], places = [] } = {}, settings = speakSettings(), { place = null } = {}) {
  const found = voiceFor({ place, voices, places, settings });
  return { chosen: found.voice?.id ?? null, voices: voices.map(row => ({ id: row.id, ...row.values })), speed: found.speed };
}

/** The speech program's answer to one request: the program run once with the request on its standard input. */
export function askSpeaker(request, { settings = speakSettings(), python = null } = {}) {
  const row = settings.programs[0];
  if (!row) return Promise.reject(said(settings.words.no_program));
  const found = python ?? (row.search_path ?? []).map(folder => path.join(expand(folder), row.check[0])).find(file => existsSync(file)) ?? row.check[0];
  const [first, ...args] = row.run.map(part => fill(part, { here: HERE }));
  const command = first === row.check[0] ? found : first;
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { env: row.env, maxBuffer: 64 * 1024 * 1024, timeout: settings.most_seconds * 1000 }, (error, stdout, stderr) => {
      if (error?.code === 'ENOENT') return reject(said(settings.words.no_program));
      try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); }
      catch { reject(new Error(String(stderr).trim().split('\n').pop() || error?.message || 'the speech program did not answer')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** A recording or reference sound: the file on this computer a request or a voice row names. */
function fileOnThisComputer(name, what) {
  const file = expand(String(name ?? ''));
  if (!name || !existsSync(file)) throw new Error(`The ${what} ${name ?? ''} is not a file on this computer.`);
  return file;
}

/**
 * Says `text` into the sound file `out`, with the first voice in voiceOrder that can be made, at its natural pace:
 * { out, seconds, sample_rate, took_seconds, voice: { id, label }, engine, produced_by, passed_over, speed }, `speed`
 * being the place's speed from the person's rows for the player to apply (invariant 5).
 */
export async function sayHere({ text, voice = null, place = null, out }, { settings = speakSettings(), ask = askSpeaker, person = personFromRows({}, settings, { place }), allowFallback = true } = {}) {
  const words = String(text ?? '').trim();
  if (!words) throw said(settings.words.needs_text, {}, 400);
  if (words.length > settings.longest_text) throw said(settings.words.too_long, { most: settings.longest_text }, 400);
  const passed = [];
  for (const row of voiceOrder({ asked: voice, person, settings, allowFallback })) {
    const engine = settings.engines.find(item => item.id === row.engine);
    try {
      if (!engine) throw new Error(`no engine ${row.engine}`);
      const reference = engine.takes === 'reference' ? fileOnThisComputer(row.reference, 'reference recording') : null;
      const answer = await ask({ say: {
        text: words, model: engine.model, takes: engine.takes, speaker: row.speaker ?? null, lang_code: engine.lang_code ?? row.lang_code ?? 'a',
        reference, reference_text: row.reference_text ?? null, out, loudness: settings.loudness,
      } }, { settings });
      if (!answer?.ok) throw new Error(answer?.error ?? 'the speech model made no sound');
      return { out, seconds: answer.seconds, sample_rate: answer.sample_rate, took_seconds: answer.took_seconds, voice: { id: row.id, label: row.label }, engine: engine.id, produced_by: engine.produced_by, passed_over: passed, speed: person.speed };
    } catch (error) {
      passed.push({ voice: row.id, why: String(error?.message ?? error) });
    }
  }
  throw said(settings.words.no_voice, { why: passed.map(item => `${item.voice}: ${item.why}`).join('; ') });
}

/** The run's speech program as an `ask`: the one the person gave as `speech_python`, else the settings' program. */
const askWith = (input, ask) => ask ?? ((request, options) => askSpeaker(request, { ...options, python: input?.speech_python ?? null }));

/**
 * Hands the sound `source` to the run's declared private output folder under its bound (`keep`): its byte identity and
 * the output manifest the engine keeps in Files. The folder is made only once the sound is whole.
 */
async function keepSound(source, keep, outputFolder) {
  const hash = makeHashCodeHasher();
  let bytes = 0;
  for await (const piece of createReadStream(source)) {
    bytes += piece.length;
    if (bytes > keep.max_bytes) throw new Error('The speech output exceeds its declared file limit.');
    hash.update(piece);
  }
  if (!bytes) throw new Error('The speech program returned an empty sound file.');
  const identity = hash.identity();
  mkdirSync(outputFolder, { recursive: true, mode: 0o700 });
  copyFileSync(source, path.join(outputFolder, keep.name), constants.COPYFILE_EXCL);
  return { file: identity, files: [{ name: keep.name, bytes, blake3: identity.slice(3) }] };
}

/**
 * tool:say-with-a-voice-model: { text, voice?, place?, voices?, places?, speech_python? } (voices and places are the rows of the person's two lists, handed in; this tool reads no records) -> { file, files, seconds, voice, engine,
 * produced_by, passed_over, speed, text }. `file` is the generated bytes' identity; `files` is the engine's declared
 * output-tree manifest. Only a successful Files keep lets the engine return this result. A failed/unknown delivery
 * retries the original request key, never this producer. The optional outputFolder dependency is a test seam; the
 * public descriptor declares the fixed private folder from speak.json, never a caller-selected path.
 */
export async function say(input, _context, { settings = speakSettings(), ask = null, outputFolder = path.resolve(HERE, settings.keep.folder) } = {}) {
  if (existsSync(path.join(outputFolder, settings.keep.name))) throw new Error('The declared speech output already exists; retry the original tool request key.');
  const folder = mkdtempSync(path.join(os.tmpdir(), 'said-'));
  try {
    const person = personFromRows({ voices: input?.voices, places: input?.places }, settings, { place: input?.place ?? null });
    const made = await sayHere({ text: input?.text, voice: input?.voice ?? null, place: input?.place ?? null, out: path.join(folder, 'said.wav') }, { settings, ask: askWith(input, ask), person });
    const kept = await keepSound(made.out, settings.keep, outputFolder);
    const { out: _, ...rest } = made;
    return { ...kept, ...rest, text: String(input.text).trim() };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

/**
 * tool:voices: { recording, label?, speech_python? } makes a voice from a recording of the person on this computer: the
 * speech model picks the stretch that ends where a sentence ends, and the answer holds { voice, files, file, said }.
 * `voice` is the row for the person's Voices list ({ id, values }: label, engine, reference_text, made_from, made_at) for
 * their AI to keep in a store; `files` is the manifest of its reference sound (the run's declared output), the file the
 * row's `reference` then names. Nothing is kept by this tool.
 */
export async function voices(input = {}, _context, { settings = speakSettings(), ask = null, outputFolder = path.resolve(HERE, settings.make.keep.folder) } = {}) {
  if (!input?.recording) throw said(settings.words.needs_recording, {}, 400);
  if (existsSync(path.join(outputFolder, settings.make.keep.name))) throw new Error('The declared voice output already exists; retry the original tool request key.');
  const recording = fileOnThisComputer(input.recording, 'recording');
  const folder = mkdtempSync(path.join(os.tmpdir(), 'voice-'));
  try {
    const out = path.join(folder, 'reference.wav');
    const engine = settings.engines.find(item => item.takes === 'reference');
    const picked = await askWith(input, ask)({ reference: { recording, out, hear_model: settings.make.hear_model, window: settings.make.window, fade_seconds: settings.make.fade_seconds } }, { settings });
    if (!picked?.ok) throw new Error(picked?.error ?? 'no reference could be made');
    const kept = await keepSound(out, settings.make.keep, outputFolder);
    const id = `own-${Date.now().toString(36)}`;
    const values = { label: input.label ?? settings.person.own_label, engine: engine.id, reference_text: picked.text, made_from: input.recording, made_at: new Date().toISOString() };
    return { voice: { id, values }, ...kept, said: fill(settings.words.made, { seconds: picked.seconds, name: input.recording, text: picked.text }) };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
