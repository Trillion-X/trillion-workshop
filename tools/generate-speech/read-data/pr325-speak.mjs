// tools/generate-speech/read-data/speak.mjs
//
// Purpose
//   Says words in a natural voice made by a speech model on the person's own computer: their own cloned voice or a
//   neutral one, never a paid service. Run as functions by tools/records-door's run-an-export.mjs:
//     say    (tool:say-with-a-voice-model) { text, voice?, place?, speech_python? } -> the sound kept in their files
//     voices (tool:voices)                 lists, makes, chooses and removes their voices
//   Moved from the product repo's computer/speak.mjs (speakTools, sayHere, voiceOrder) with the voice and speed of a
//   place from src/voices.mjs (voiceFor), over the person's lists through the run's records door.
//
// Non-negotiable invariants
//   1. Every program, model, voice, number and word is DATA (read-data/speak.json); this file names none of them.
//   2. A person's own voices, the voice they chose and every speed are theirs: rows of their own Voices list and their
//      list of places Trillion speaks, read and kept through their records door, with each reference recording in their
//      own files; nothing about them is kept in this repository or on the computer after the run. The shared voices of
//      speak.json are kept as rows too, so the person sees and sets them.
//   3. A voice is said with the voice asked for, else the chosen one, else the shared voices in order; a voice that
//      cannot be made is passed over with why, and only when none can is the answer an error (the caller keeps the words
//      and asks again; it never falls back to a system voice). An unknown voice id asked for by name is an error, never
//      a silent substitute.
//   4. A reference is only ever made by the speech program's `reference` road, which picks a stretch ending where a
//      sentence ends (do-work/speak-with-mlx.py invariant 2).
//   5. A sound is made at its natural pace: the answer carries the place's `speed`, and whoever plays it applies it with
//      the pitch kept, so every speed from the slowest to the fastest plays the same made sound.
//   6. Nothing is left on the computer: every sound, reference and recording is in the run's own folder, removed when
//      the run's function returns.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listsOverDoor } from '../../records-door/read-data/lists-door.mjs';
import { readWholeFile, writeWholeFile } from '../../records-door/read-data/whole-file.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
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

/**
 * The person's voices and the voice and speed of `place` from their own rows: { chosen, voices, speed, list, chosen_mark }.
 * The two lists are made once, with their starter rows, the first time anything asks. With no door there are none and
 * the shared voices speak.
 */
export async function personVoices(door, settings = speakSettings(), { place = null } = {}) {
  if (!door) return { chosen: null, voices: [], speed: null, list: null, chosen_mark: null };
  const lists = listsOverDoor(door);
  await lists.ensure(settings.lists.voices);
  await lists.ensure(settings.lists.places);
  const voices = (await lists.read(settings.lists.voices.id)).rows;
  const places = (await lists.read(settings.lists.places.id)).rows;
  const found = voiceFor({ place, voices, places, settings });
  return { chosen: found.voice?.id ?? null, voices: voices.map(row => ({ id: row.id, ...row.values })), speed: found.speed, list: settings.lists.voices.id, chosen_mark: chosenMark(settings) };
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

/** One of the person's files written into `folder` for the speech program: its local path. */
async function fileHere(door, name, folder) {
  const { title, size, bytes } = await readWholeFile(door, name);
  if (!bytes) throw new Error(`${name} is ${size} bytes, more than one run reads.`);
  const file = path.join(folder, `${Date.now()}-${path.basename(title) || 'recording'}${path.extname(title) ? '' : '.wav'}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

/**
 * Says `text` into the sound file `out`, with the first voice in voiceOrder that can be made, at its natural pace:
 * { out, seconds, sample_rate, took_seconds, voice: { id, label }, engine, produced_by, passed_over, speed }, `speed`
 * being the place's speed from the person's rows for the player to apply (invariant 5).
 */
export async function sayHere({ text, voice = null, place = null, out }, { door = null, settings = speakSettings(), ask = askSpeaker, person = undefined, allowFallback = true } = {}) {
  const words = String(text ?? '').trim();
  if (!words) throw said(settings.words.needs_text, {}, 400);
  if (words.length > settings.longest_text) throw said(settings.words.too_long, { most: settings.longest_text }, 400);
  const theirs = person === undefined ? await personVoices(door, settings, { place }) : person;
  const passed = [];
  for (const row of voiceOrder({ asked: voice, person: theirs, settings, allowFallback })) {
    const engine = settings.engines.find(item => item.id === row.engine);
    try {
      if (!engine) throw new Error(`no engine ${row.engine}`);
      const reference = engine.takes === 'reference' ? await fileHere(door, row.reference, path.dirname(out)) : null;
      const answer = await ask({ say: {
        text: words, model: engine.model, takes: engine.takes, speaker: row.speaker ?? null, lang_code: engine.lang_code ?? row.lang_code ?? 'a',
        reference, reference_text: row.reference_text ?? null, out, loudness: settings.loudness,
      } }, { settings });
      if (!answer?.ok) throw new Error(answer?.error ?? 'the speech model made no sound');
      return { out, seconds: answer.seconds, sample_rate: answer.sample_rate, took_seconds: answer.took_seconds, voice: { id: row.id, label: row.label }, engine: engine.id, produced_by: engine.produced_by, passed_over: passed, speed: theirs?.speed ?? null };
    } catch (error) {
      passed.push({ voice: row.id, why: String(error?.message ?? error) });
    }
  }
  throw said(settings.words.no_voice, { why: passed.map(item => `${item.voice}: ${item.why}`).join('; ') });
}

const stamp = (date = new Date()) => date.toISOString().replace('T', ' ').replace(/:/g, '-').slice(0, 19);
/** A voice as its row's values: only the fields the Voices list keeps. */
const rowValues = ({ id, own, ...values }) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null));
/** The run's speech program as an `ask`: the one the person gave as `speech_python`, else the settings' program. */
const askWith = (input, ask) => ask ?? ((request, options) => askSpeaker(request, { ...options, python: input?.speech_python ?? null }));

/**
 * tool:say-with-a-voice-model: { text, voice?, place?, speech_python? } -> { file, name, seconds, voice, engine,
 * produced_by, passed_over, speed, text }, the sound kept in the person's files (speak.json keep) at its natural pace so
 * any of their devices plays it, at `speed`.
 */
export async function say(input, { door } = {}, { settings = speakSettings(), ask = null } = {}) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'said-'));
  try {
    const made = await sayHere({ text: input?.text, voice: input?.voice ?? null, place: input?.place ?? null, out: path.join(folder, 'said.wav') }, { door, settings, ask: askWith(input, ask) });
    const name = `${settings.keep.folder.replace(/\/$/, '')}/${fill(settings.keep.name, { time: stamp(), voice: made.voice.label })}`;
    const kept = await writeWholeFile(door, name, readFileSync(made.out), { mediaType: settings.keep.media_type });
    const { out: _, ...rest } = made;
    return { file: kept?.identity ?? name, name: kept?.name ?? name, ...rest, text: String(input.text).trim() };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

/**
 * tool:voices: {} lists { chosen, voices }; { make: { recording, label?, choose? } } makes the person's voice from a
 * recording of them; { choose: id } chooses the voice Trillion speaks in; { remove: id } removes one of their own voices
 * (its reference recording stays in their files until they delete it). Every voice, and which one is chosen, is a row of
 * the person's Voices list (invariant 2): each answer first keeps any shared voice that is not yet a row, so the person
 * can choose it and set its speed anywhere.
 */
export async function voices(input = {}, { door } = {}, { settings = speakSettings(), ask = null } = {}) {
  const lists = listsOverDoor(door);
  const keepVoices = (rows, remove = []) => Promise.all([
    rows.length ? lists.putRows(person.list, { rows }) : null,
    remove.length ? lists.find(person.list).then(list => door.write(remove.map(id => ({ id: `record:${list.row_type}:${id}`, type: `record:${list.row_type}`, value: null })), { key: `voices:remove:${remove.join(',')}` })) : null,
  ]);
  let person = await personVoices(door, settings);
  const shared = settings.voices.filter(voice => !person.voices.some(row => row.id === voice.id));
  if (shared.length) {
    await keepVoices(shared.map(voice => ({ id: voice.id, values: rowValues(voice) })));
    person = { ...person, voices: [...person.voices, ...shared] };
  }
  const isShared = id => settings.voices.some(voice => voice.id === id);
  const list = (chosen, every) => ({ chosen: chosen ?? null, voices: every.map(({ id, label, engine, speed, made_from, made_at }) => ({ id, label, engine, speed: speed ?? null, made_from: made_from ?? null, made_at: made_at ?? null, own: !isShared(id) })) });
  const choose = (every, id) => every.map(row => ({ id: row.id, values: { chosen: row.id === id ? person.chosen_mark : null } }));
  if (input.make) {
    if (!input.make.recording) throw said(settings.words.needs_recording, {}, 400);
    const folder = mkdtempSync(path.join(os.tmpdir(), 'voice-'));
    try {
      const recording = await fileHere(door, input.make.recording, folder);
      const out = path.join(folder, 'reference.wav');
      const engine = settings.engines.find(item => item.takes === 'reference');
      const picked = await askWith(input, ask)({ reference: { recording, out, hear_model: settings.make.hear_model, window: settings.make.window, fade_seconds: settings.make.fade_seconds } }, { settings });
      if (!picked?.ok) throw new Error(picked?.error ?? 'no reference could be made');
      const id = `own-${Date.now().toString(36)}`;
      const name = `${settings.person.folder}/${id}.wav`;
      await writeWholeFile(door, name, readFileSync(out), { mediaType: 'audio/wav' });
      const row = { id, label: input.make.label ?? settings.person.own_label, engine: engine.id, reference: name, reference_text: picked.text, made_from: input.make.recording, made_at: new Date().toISOString() };
      const every = [...person.voices, row];
      const chosen = input.make.choose === false ? person.chosen : id;
      await keepVoices([...(chosen === id ? choose(person.voices, id) : []), { id, values: rowValues({ ...row, chosen: chosen === id ? person.chosen_mark : null }) }]);
      return { ...list(chosen, every), said: fill(settings.words.made, { seconds: picked.seconds, name: input.make.recording, text: picked.text }) };
    } finally { rmSync(folder, { recursive: true, force: true }); }
  }
  if (input.choose) {
    const voice = person.voices.find(row => row.id === input.choose);
    if (!voice) throw said(settings.words.unknown_voice, { voice: input.choose, voices: person.voices.map(row => row.id).join(', ') }, 400);
    await keepVoices(choose(person.voices, voice.id));
    return { ...list(voice.id, person.voices), said: fill(settings.words.chosen, { label: voice.label }) };
  }
  if (input.remove) {
    const voice = person.voices.find(row => row.id === input.remove);
    if (!voice || isShared(voice.id)) throw said(voice ? settings.words.keeps_one : settings.words.unknown_voice, { voice: input.remove, voices: person.voices.map(row => row.id).join(', ') }, 400);
    await keepVoices([], [voice.id]);
    return { ...list(person.chosen === voice.id ? null : person.chosen, person.voices.filter(row => row.id !== voice.id)), said: fill(settings.words.removed, { label: voice.label }) };
  }
  return list(person.chosen, person.voices);
}
