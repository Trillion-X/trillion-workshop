// computer/speak.mjs
//
// Purpose
//   Says words in a natural voice made by a speech model on this computer's own chip: the person's own cloned voice
//   or a neutral one, never a paid service. It is the device side of tool:speak (src/account-speech.mjs places the
//   job on whichever of the person's devices can run a model, src/placement.json job speak), run here as
//   tool:say-with-a-voice-model and tool:voices by computer/mac-tools.mjs, and by the Trillion Mac app to say
//   notices out loud (macos/App/SpeakAloud.swift, through ComputerReader):
//
//     node computer/speak.mjs --out <file.wav> --answer <file.json>
//                                                   account key, then { text, voice?, place? } as one JSON line, on stdin
//
//   writes { out, seconds, voice, engine, produced_by, speed } to the answer file (and prints it) and exits 0, or
//   writes and prints { error } and exits 1, so the app keeps the notice and makes its sound again later. A notice whose
//   sound could never be made before it was too old to say is told to the person's AI work instead:
//
//     node computer/speak.mjs --unsaid             account key, then { notice, title, why, hours } as one JSON line, on stdin
//
//   reports it once through `unsaid.tool` (tool:report-progress) as failed work, worded by speak.json `unsaid`.
//
// Non-negotiable invariants
//   1. Every program, model, voice, number and word is DATA (computer/speak.json and the speech-program and speech-engine
//      rows of records/speech-engine-records.json); this file names none of them.
//   2. A person's own voices, the voice they chose and every speed are theirs: rows of their own Voices list and their
//      list of places Trillion speaks (src/voices.mjs, read through tool:voice-for with their key), with each reference
//      recording in their own Trillion files; nothing about them is kept in this repository or on this computer beyond
//      a cached reference. The shared voices of speak.json are kept as rows too, so the person sees and sets them.
//   6. A sound is made at its natural pace: the answer carries the place's `speed`, and whoever plays it applies it
//      with the pitch kept, so every speed from the slowest to the fastest plays the same made sound.
//   3. A voice is said with the voice asked for, else the chosen one, else the shared voices in order; a voice that
//      cannot be made is passed over with why, and only when none can is the answer an error (the caller keeps the notice
//      and asks again; it never falls back to a system voice). An unknown voice id asked for by name is an error, never a silent substitute.
//   4. A reference is only ever made by the resident speaker's `reference` road, which picks a stretch ending where a
//      sentence ends (computer/speak-with-mlx.py invariant 2).
//   5. The model stays loaded in one resident speaker per computer (a Unix socket only this user can open), started
//      on first use and ending itself after it has been idle; nothing it makes leaves this computer except a sound the
//      person's own tool keeps in their own files.
//
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askResident, hearingHere as programHere, toolCaller } from './keep-drive-files.mjs';
import { withTables } from '../src/data-rows.mjs';
import speechRecords from '../records/speech-engine-records.json' with { type: 'json' };

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The settings file with the programs and engines (`programs`, `engines`) read from their speech-program and speech-engine rows.
export const speakSettings = () => withTables(JSON.parse(readFileSync(path.join(HERE, 'speak.json'), 'utf8')), {
  programs: { kind: 'speech-program', records: speechRecords },
  engines: { kind: 'speech-engine', records: speechRecords },
});
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

/** The resident speaker's answer to one request, starting it when no speaker answers on its socket. */
export async function askSpeaker(request, { settings = speakSettings(), program = undefined, ask = askResident } = {}) {
  const found = program === undefined ? programHere(settings.programs) : program;
  const speaker = { ...settings.speaker, socket: expand(settings.speaker.socket) };
  const [first, ...args] = (found?.run ?? []).map(part => fill(part, { here: HERE }));
  const command = found?.program && first === found.check[0] ? found.program : first;
  const answer = () => ask(speaker, [command, ...args, 'serve', speaker.socket, String(speaker.idle_seconds)], request, { env: found?.env });
  if (found) return answer();
  // With no speech program here, a speaker already running still answers; none running is said in words.
  try { return await ask(speaker, null, request); }
  catch { throw said(settings.words.no_program); }
}

/**
 * The person's voices and the voice and speed of `place` from their own rows (tool:voice-for, src/voices.mjs):
 * { chosen, voices, speed, list, chosen_mark }. One answer per place per minute is reused (the same request_key), so speaking
 * often keeps one run a minute. The account is asked for at most `person.read_seconds`, and each answer is kept on this
 * computer (`person.kept`, per place), so when the account is late or cannot be reached (no network, a stalled password
 * service on this Mac) the last answer speaks in the person's voice instead of the sound waiting on the account; their
 * reference recording is likewise the copy already here when the account is late (fileHere). With no
 * account and nothing kept, there are none and the shared voices speak.
 */
export async function personVoices(call, settings = speakSettings(), { place = null, now = new Date() } = {}) {
  const none = { chosen: null, voices: [], speed: null, list: null, chosen_mark: null };
  const kept = path.join(expand(settings.folder), fill(settings.person.kept, { place: String(place ?? 'chosen').replace(/[^\w.-]+/g, '-') }));
  const lastKept = () => { try { return { ...none, ...JSON.parse(readFileSync(kept, 'utf8')) }; } catch { return none; } };
  if (!call) return lastKept();
  let answer;
  try {
    answer = await within(call('run_tool', { tool_id: settings.person.tool, input: place ? { place } : {}, request_key: `${settings.person.tool}:${place ?? 'chosen'}:${now.toISOString().slice(0, 16)}`, wait_seconds: 30 }), settings.person.read_seconds);
  } catch { return lastKept(); }
  const found = answer?.output ?? null;
  if (!found) return lastKept();
  const theirs = { chosen: found.voice?.id ?? null, voices: Array.isArray(found.voices) ? found.voices : [], speed: found.speed ?? null, list: found.lists?.voices ?? null, chosen_mark: found.chosen_mark ?? null };
  try { mkdirSync(path.dirname(kept), { recursive: true, mode: 0o700 }); writeFileSync(kept, JSON.stringify(theirs), { mode: 0o600 }); } catch {}
  return theirs;
}

/** A file of the person's on this computer, read once by its identity into `folder` and kept for the next time. */
async function fileHere(call, name, folder, { seconds = null, fetchImpl = fetch } = {}) {
  // Which copy each name was last, so a late or unreachable account still finds the copy already here.
  const names = path.join(folder, 'names.json');
  const known = () => { try { return JSON.parse(readFileSync(names, 'utf8')); } catch { return {}; } };
  let found;
  try { found = await within(call('find_file', { name_or_identity: name, seconds: 600 }), seconds); }
  catch (error) {
    const file = known()[name];
    if (file && existsSync(file) && statSync(file).size) return file;
    throw error;
  }
  const identity = String(found.identity ?? name);
  const file = path.join(folder, `${identity.replace(/[^\w.-]+/g, '-')}${path.extname(found.names?.[0] ?? found.name ?? name) || '.wav'}`);
  if (!(existsSync(file) && statSync(file).size)) {
    const answer = await fetchImpl(found.url, { signal: AbortSignal.timeout(600_000) });
    if (!answer.ok) throw new Error(`reading ${name}: ${answer.status}`);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(file, Buffer.from(await answer.arrayBuffer()), { mode: 0o600 });
  }
  try { writeFileSync(names, JSON.stringify({ ...known(), [name]: file }), { mode: 0o600 }); } catch {}
  return file;
}

/** `promise`, or an error once `seconds` have passed (no limit when seconds is null). */
async function within(promise, seconds) {
  if (seconds == null) return promise;
  let timer;
  const late = new Promise((_, refuse) => { timer = setTimeout(() => refuse(new Error('late')), seconds * 1000); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

/**
 * Says `text` into the sound file `out` on this computer, with the first voice in voiceOrder that can be made, at its
 * natural pace: { out, seconds, sample_rate, took_seconds, voice: { id, label }, engine, produced_by, passed_over,
 * speed }, `speed` being the place's speed from the person's rows for the player to apply (invariant 6).
 */
export async function sayHere({ text, voice = null, place = null, out }, { call = null, settings = speakSettings(), ask = askSpeaker, person = undefined, allowFallback = true } = {}) {
  const words = String(text ?? '').trim();
  if (!words) throw said(settings.words.needs_text, {}, 400);
  if (words.length > settings.longest_text) throw said(settings.words.too_long, { most: settings.longest_text }, 400);
  const theirs = person === undefined ? await personVoices(call, settings, { place }) : person;
  const passed = [];
  for (const row of voiceOrder({ asked: voice, person: theirs, settings, allowFallback })) {
    const engine = settings.engines.find(item => item.id === row.engine);
    try {
      if (!engine) throw new Error(`no engine ${row.engine}`);
      const reference = engine.takes === 'reference' ? await fileHere(call, row.reference, path.join(expand(settings.folder), 'references'), { seconds: settings.person.read_seconds }) : null;
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
/** Keeps voice rows ({ id, values }) in the person's Voices list, and removes the ids in `remove`. */
const keepVoices = (call, list, rows, remove = []) => call('put_list_rows', { list_id: list, rows, ...(remove.length ? { remove } : {}) });
/** A voice as its row's values: only the fields the Voices list keeps. */
const rowValues = ({ id, own, ...values }) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null));
const sendBytes = (call, name, file, media_type) => call('write_file', { name, content_base64: readFileSync(file).toString('base64'), media_type });

export const speakTools = {
  /**
   * tool:say-with-a-voice-model: { text, voice?, place? } -> { file, name, seconds, voice, engine, produced_by, passed_over,
   * speed }, the sound kept in the person's files (speak.json keep) at its natural pace so any of their devices plays
   * it, at `speed`.
   */
  async say(input, context = {}, { call = context.key ? toolCaller(context.origin, context.key) : null, settings = speakSettings(), ask = askSpeaker } = {}) {
    const folder = expand(settings.folder);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const out = path.join(folder, `said-${process.pid}-${Date.now()}.wav`);
    try {
      const made = await sayHere({ text: input?.text, voice: input?.voice ?? null, place: input?.place ?? null, out }, { call, settings, ask });
      const name = `${settings.keep.folder.replace(/\/$/, '')}/${fill(settings.keep.name, { time: stamp(), voice: made.voice.label })}`;
      const kept = await sendBytes(call, name, out, settings.keep.media_type);
      const { out: _, ...rest } = made;
      return { file: kept.identity, name: kept.name ?? name, ...rest, text: String(input.text).trim() };
    } finally { rmSync(out, { force: true }); }
  },
  /**
   * tool:voices: {} lists { chosen, voices }; { make: { recording, label?, choose? } } makes the person's
   * voice from a recording of them; { choose: id } chooses the voice Trillion speaks in; { remove: id } removes one of
   * their own voices (its reference recording stays in their files until they delete it). Every voice, and which one
   * is chosen, is a row of the person's Voices list (invariant 2): each answer first keeps any shared voice of this
   * computer that is not yet a row, so the person can choose it and set its speed anywhere.
   */
  async voices(input = {}, context = {}, { call = context.key ? toolCaller(context.origin, context.key) : null, settings = speakSettings(), ask = askSpeaker } = {}) {
    let person = await personVoices(call, settings);
    if (!person.list) throw said(settings.words.no_list);
    const shared = settings.voices.filter(voice => !person.voices.some(row => row.id === voice.id));
    if (shared.length) {
      await keepVoices(call, person.list, shared.map(voice => ({ id: voice.id, values: rowValues(voice) })));
      person = { ...person, voices: [...person.voices, ...shared] };
    }
    const isShared = id => settings.voices.some(voice => voice.id === id);
    const list = (chosen, voices) => ({ chosen: chosen ?? null, voices: voices.map(({ id, label, engine, speed, made_from, made_at }) => ({ id, label, engine, speed: speed ?? null, made_from: made_from ?? null, made_at: made_at ?? null, own: !isShared(id) })) });
    const choose = (voices, id) => voices.map(row => ({ id: row.id, values: { chosen: row.id === id ? person.chosen_mark : null } }));
    if (input.make) {
      if (!input.make.recording) throw said(settings.words.needs_recording, {}, 400);
      const folder = expand(settings.folder);
      const recording = await fileHere(call, input.make.recording, path.join(folder, 'recordings'));
      const out = path.join(folder, `reference-${Date.now()}.wav`);
      try {
        const engine = settings.engines.find(item => item.takes === 'reference');
        const picked = await ask({ reference: { recording, out, hear_model: settings.make.hear_model, window: settings.make.window, fade_seconds: settings.make.fade_seconds } }, { settings });
        if (!picked?.ok) throw new Error(picked?.error ?? 'no reference could be made');
        const id = `own-${Date.now().toString(36)}`;
        const name = `${settings.person.folder}/${id}.wav`;
        await sendBytes(call, name, out, 'audio/wav');
        const row = { id, label: input.make.label ?? settings.person.own_label, engine: engine.id, reference: name, reference_text: picked.text, made_from: input.make.recording, made_at: new Date().toISOString() };
        const voices = [...person.voices, row];
        const chosen = input.make.choose === false ? person.chosen : id;
        await keepVoices(call, person.list, [...(chosen === id ? choose(person.voices, id) : []), { id, values: rowValues({ ...row, chosen: chosen === id ? person.chosen_mark : null }) }]);
        return { ...list(chosen, voices), said: fill(settings.words.made, { seconds: picked.seconds, name: input.make.recording, text: picked.text }) };
      } finally { rmSync(out, { force: true }); }
    }
    if (input.choose) {
      const voice = person.voices.find(row => row.id === input.choose);
      if (!voice) throw said(settings.words.unknown_voice, { voice: input.choose, voices: person.voices.map(row => row.id).join(', ') }, 400);
      await keepVoices(call, person.list, choose(person.voices, voice.id));
      return { ...list(voice.id, person.voices), said: fill(settings.words.chosen, { label: voice.label }) };
    }
    if (input.remove) {
      const voice = person.voices.find(row => row.id === input.remove);
      if (!voice || isShared(voice.id)) throw said(voice ? settings.words.keeps_one : settings.words.unknown_voice, { voice: input.remove, voices: person.voices.map(row => row.id).join(', ') }, 400);
      await keepVoices(call, person.list, [], [voice.id]);
      return { ...list(person.chosen === voice.id ? null : person.chosen, person.voices.filter(row => row.id !== voice.id)), said: fill(settings.words.removed, { label: voice.label }) };
    }
    return list(person.chosen, person.voices);
  },
};

// ---- The Mac app's road: say one notice into a local file (key and request on stdin) ----------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : ''; };
  const out = argument('--out');
  const answer = argument('--answer');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const [key, line] = input.split('\n');
  const origin = process.env.TRILLION_ORIGIN ?? JSON.parse(readFileSync(path.join(HERE, 'mac-tools.json'), 'utf8')).origin;
  try {
    const request = JSON.parse(line || '{}');
    if (process.argv.includes('--unsaid')) {
      if (!key) throw new Error('Give the account key to tell the person.');
      const { unsaid } = speakSettings();
      const values = { notice: request.notice ?? '', title: request.title ?? '', why: request.why ?? '', hours: request.hours ?? '' };
      const told = await toolCaller(origin, key.trim())('run_tool', { tool_id: unsaid.tool, input: { key: fill(unsaid.key, values), kind: unsaid.kind, state: unsaid.state, title: fill(unsaid.title, values), body: fill(unsaid.body, values), source: os.hostname() }, wait_seconds: 30 });
      process.stdout.write(`${JSON.stringify(told?.output ?? told ?? {})}\n`);
      process.exit(0);
    }
    if (!out) throw new Error('Give --out, the sound file to write.');
    const made = await sayHere({ text: request.text, voice: request.voice ?? null, place: request.place ?? null, out }, { call: key ? toolCaller(origin, key.trim()) : null });
    if (answer) writeFileSync(answer, JSON.stringify(made), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(made)}\n`);
  } catch (error) {
    const said = JSON.stringify({ error: String(error?.message ?? error) });
    if (answer) try { writeFileSync(answer, said, { mode: 0o600 }); } catch {}
    process.stdout.write(`${said}\n`);
    process.exitCode = 1;
  }
}
