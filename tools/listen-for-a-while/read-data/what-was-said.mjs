// tools/listen-for-a-while/read-data/what-was-said.mjs
//
// Purpose
//   What happens to a listening's `heard` rows after they are written, and what an ask about a listening waits for, all
//   on the person's own records (no Mac state file):
//   - a voice heard as "Someone (voice-N)" named once that voice is enrolled (`nameHeardVoice`, tool:name-a-heard-voice);
//   - the sound of a piece kept in the person's files with each turn's place in it (`keepPieceSound`, keep_sound);
//   - who said each turn of a recording written back beside that recording (`writeSpeakersBack`, write_back);
//   - captions: the person's corrections to the turns, as ops over a `captions` row (`reduceCaptions`, `applyCaptions`,
//     tool:caption-what-is-heard, F-0792);
//   - the transcriber role: one device hears a listening at a time, held by a keepalive in a `transcriber` row
//     (`roleHolder`, `mayTranscribe`, `roleRow`, F-0793);
//   - the transcript cursor: an ask answers only the turns after what that conversation was last given, from an
//     `ask-cursor` row over heard row ids (`turnsAfter`, F-0297);
//   - the ask-time flush: an ask waits until what was said before it is heard and written, from the listening's
//     `listening-status` row (`statusRow`, `waitForHearing`, F-0298), and `askWhatWasSaid` (tool:ask-what-was-said) does
//     the three in order.
//
// Non-negotiable invariants
//   1. Every state is a record of the person's: captions, the role, the cursor and the status are rows; nothing is kept in
//      a file of this computer, so any of the person's devices reads the same state.
//   2. A rename changes only turns still under "Someone (voice-N)" for one of the voices named; a turn a person already
//      named, an unsure turn and another listening's turn are never changed. The former label stays on the row.
//   3. Captions never rewrite a heard row: the person's corrections are kept beside the words and applied when read, so
//      the words as heard are always there to go back to.
//   4. Kept sound is the person's opt-in (keep_sound); without it no sound is written anywhere. A sound that cannot be
//      kept never stops the words from being written.
//   5. An ask never waits past its own limit, and a listening that is not live is not waited for (livenessOf).
//   6. Every number and word is DATA (read-data/what-was-said.json).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { livenessOf } from './meeting-ledger.mjs';
import { writeWholeFile } from '../../records-door/read-data/whole-file.mjs';
import data from './what-was-said.json' with { type: 'json' };

const run = promisify(execFile);
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const fail = (template, values = {}, status = 400) => Object.assign(new Error(fill(template, values)), { status });

export const HEARD = 'heard';
export const CAPTIONS = 'captions';
export const TRANSCRIBER = 'transcriber';
export const CURSOR = 'ask-cursor';
export const STATUS = 'listening-status';

/** A heard row's start in milliseconds, from its id (`heard:<listening>:<ms>`), so ordering never parses text. */
export const startOf = id => Number(String(id).split(':').at(-1));

/** Every heard row of one listening, oldest first. */
export async function heardOf(door, listening) {
  const rows = [];
  for await (const row of door.list({ type: HEARD, prefix: `${HEARD}:${listening}:` })) if (row.value?.listening === listening) rows.push(row);
  return rows.sort((a, b) => startOf(a.id) - startOf(b.id));
}

// ---- Naming a voice heard before it was enrolled -------------------------------------------------------------------

/** The rows to rewrite when `voices` (the labels the enrolled voice was heard under) become `name`: only turns still
 *  under an unknown-voice label, each keeping its former label in `renamed_from`. */
export function renamedRows(rows, { voices, name, me = false }, words = data) {
  const unknown = new RegExp(words.rename.unknown_speaker);
  return rows.filter(row => voices.includes(row.value?.voice) && unknown.test(String(row.value?.speaker ?? '')))
    .map(row => ({ id: row.id, type: HEARD, value: { ...row.value, speaker: name, me: me === true, renamed_from: row.value.speaker } }));
}

/** tool:name-a-heard-voice: { listening, voices, name, me? } -> { listening, name, renamed, rows_written }. `voices` is
 *  the enrol tool's `heard_as` (or one voice-N label). */
export async function nameHeardVoice(input, { door }) {
  const listening = String(input?.listening ?? '').trim();
  const name = String(input?.name ?? '').trim();
  const voices = [input?.voices ?? []].flat().map(String).filter(Boolean);
  if (!listening || !name || !voices.length) throw fail(data.words.rename_needs);
  const rows = renamedRows(await heardOf(door, listening), { voices, name, me: input.me }, data);
  for (let at = 0; at < rows.length; at += data.rename.batch) {
    await door.write(rows.slice(at, at + data.rename.batch), { key: `name-voice:${listening}:${voices.join(',')}:${name}:${at}` });
  }
  return { listening, name, voices, renamed: rows.length, said: fill(data.words.renamed, { count: rows.length, name }) };
}

// ---- Keeping a piece's sound -----------------------------------------------------------------------------------------

/** Where a piece's sound is kept: `<folder>/<day>/<listening>-<start>.<ext>`, the day and start in UTC. */
export function soundNameOf({ folder, listening, startMs, ext = data.keep_sound.ext }) {
  const at = new Date(startMs).toISOString();
  return `${String(folder).replace(/\/+$/, '')}/${at.slice(0, 10)}/${listening}-${at.slice(11, 19).replace(/:/g, '-')}.${ext}`;
}

/** The rows with the kept sound's name and each turn's place in it, in seconds from the piece's start; `keep_until`
 *  when the person keeps sound for a number of days. */
export function withSound(rows, { name, startMs, keepDays = null }) {
  const until = Number.isFinite(keepDays) ? new Date(startMs + keepDays * 86_400_000).toISOString() : null;
  return rows.map(row => ({ ...row, value: { ...row.value, sound: name,
    sound_from: (Date.parse(row.value.start) - startMs) / 1000, sound_to: (Date.parse(row.value.end) - startMs) / 1000, ...(until ? { keep_until: until } : {}) } }));
}

/** The piece compressed for keeping by the ffmpeg the person granted (keep_sound.encode, DATA), as bytes. */
export async function encodePiece(file, { ffmpeg = 'ffmpeg' } = {}) {
  const out = `${file}.${data.keep_sound.ext}`;
  await run(ffmpeg, data.keep_sound.encode.map(word => fill(word, { input: file, output: out })), { maxBuffer: 16 * 1024 * 1024 });
  return readFileSync(out);
}

/** Keeps one piece's sound when the request asked (keep_sound: { folder, keep_days? }); answers the rows to write, with
 *  their places in it, or the rows unchanged and why the sound was not kept. */
export async function keepPieceSound(door, piece, rows, { keep, listening, ffmpeg = null, encode = encodePiece }) {
  if (!keep?.folder || !rows.length) return { rows };
  const name = soundNameOf({ folder: keep.folder, listening, startMs: piece.startMs });
  try {
    await writeWholeFile(door, name, await encode(piece.file, { ffmpeg: ffmpeg ?? 'ffmpeg' }), { mediaType: data.keep_sound.media_type });
    return { rows: withSound(rows, { name, startMs: piece.startMs, keepDays: keep.keep_days ?? null }), kept: name };
  } catch (error) {
    return { rows, error: fill(data.words.sound_not_kept, { why: String(error.message ?? error).split('\n')[0] }) };
  }
}

// ---- Writing who spoke back onto the recording -----------------------------------------------------------------------

/** The speakers file beside a recording: `<recording>.speakers.json`. */
export const speakersNameOf = file => `${file}${data.write_back.suffix}`;

/** What is written beside a recording: each turn with its place in the recording, in seconds, and who said it. */
export function speakersOf(rows, { file, startMs }) {
  return { file, heard_at: new Date(startMs).toISOString(), turns: rows.map(({ id, value }) => ({ heard: id,
    start: (Date.parse(value.start) - startMs) / 1000, end: (Date.parse(value.end) - startMs) / 1000, speaker: value.speaker, me: value.me === true, text: value.text })) };
}

export async function writeSpeakersBack(door, rows, { file, startMs, name = speakersNameOf(file) }) {
  const body = Buffer.from(`${JSON.stringify(speakersOf(rows, { file, startMs }), null, 1)}\n`);
  await writeWholeFile(door, name, body, { mediaType: 'application/json' });
  return name;
}

// ---- Captions (F-0792) -----------------------------------------------------------------------------------------------

/** One caption op over the captions state { on, edits: { <heard id>: { text?, speaker?, hidden? } } }:
 *  on | off | edit { id, text } | speaker { id, name } | hide { id } | show { id } | undo { id }. Refuses an unknown op. */
export function reduceCaptions(state, op, words = data.words) {
  const next = { on: state?.on !== false, edits: { ...(state?.edits ?? {}) } };
  const id = String(op?.id ?? '');
  const needsId = ['edit', 'speaker', 'hide', 'show', 'undo'].includes(op?.op);
  if (needsId && !id.startsWith(`${HEARD}:`)) throw fail(words.caption_needs_id, { op: op.op });
  const edit = patch => { next.edits[id] = { ...(next.edits[id] ?? {}), ...patch }; };
  if (op?.op === 'on' || op?.op === 'off') next.on = op.op === 'on';
  else if (op?.op === 'edit') edit({ text: String(op.text ?? '') });
  else if (op?.op === 'speaker') edit({ speaker: String(op.name ?? '') });
  else if (op?.op === 'hide') edit({ hidden: true });
  else if (op?.op === 'show') edit({ hidden: false });
  else if (op?.op === 'undo') delete next.edits[id];
  else throw fail(words.caption_unknown_op, { op: op?.op, ops: data.captions.ops.join(', ') });
  return next;
}

/** The turns as captions: the person's corrections applied, hidden turns left out, the words as heard kept on each. */
export function applyCaptions(rows, state) {
  return rows.flatMap(({ id, value }) => {
    const edit = state?.edits?.[id] ?? {};
    if (edit.hidden) return [];
    return [{ id, start: value.start, end: value.end, speaker: edit.speaker || value.speaker, me: value.me === true, text: edit.text ?? value.text,
      ...(edit.text !== undefined || edit.speaker ? { heard_as: { text: value.text, speaker: value.speaker } } : {}) }];
  });
}

/** tool:caption-what-is-heard: { listening, ops?, last? } -> { listening, on, lines }: applies the ops to the captions row
 *  and answers the last `last` captions (DATA default). */
export async function captionWhatIsHeard(input, { door }) {
  const listening = String(input?.listening ?? '').trim();
  if (!listening) throw fail(data.words.needs_listening);
  const id = `${CAPTIONS}:${listening}`;
  let state = (await door.read(CAPTIONS, id)) ?? { on: true, edits: {} };
  const ops = [input.ops ?? []].flat();
  for (const op of ops) state = reduceCaptions(state, op);
  if (ops.length) await door.write([{ id, type: CAPTIONS, value: { listening, ...state } }], { key: `captions:${listening}:${JSON.stringify(ops)}` });
  const last = Math.min(Number(input.last ?? data.captions.last), data.captions.most);
  return { listening, on: state.on, lines: state.on ? applyCaptions(await heardOf(door, listening), state).slice(-last) : [] };
}

// ---- The transcriber role (F-0793) -----------------------------------------------------------------------------------

/** Who holds the transcriber role now: the row's device while its keepalive has not run out, else null. */
export function roleHolder(row, now = Date.now()) {
  return row?.device && Date.parse(row.until) > now ? row.device : null;
}
/** Whether `device` may hear the listening now: nobody holds the role, or it does. */
export const mayTranscribe = (row, device, now = Date.now()) => [null, device].includes(roleHolder(row, now));
/** The role row `device` writes to hold or refresh the role for keepalive_seconds (DATA). */
export const roleRow = (listening, device, now = Date.now(), seconds = data.transcriber.keepalive_seconds) =>
  ({ id: `${TRANSCRIBER}:${listening}`, type: TRANSCRIBER, value: { listening, device, since: new Date(now).toISOString(), until: new Date(now + seconds * 1000).toISOString() } });

// ---- The listening's status, the cursor and the ask (F-0298, F-0297) -------------------------------------------------

/** The listening's status row: whether a piece is being heard, how far what was said is written, and a heartbeat. */
export const statusRow = (listening, { pending, heardUntilMs = null, now = Date.now(), device }) => ({ id: `${STATUS}:${listening}`, type: STATUS,
  value: { listening, device, hearing_pending: pending === true, heard_until: heardUntilMs == null ? null : new Date(heardUntilMs).toISOString(), heartbeat_ms: now } });

/**
 * Waits until what was said before `askedAt` is heard and written: the status says nothing is pending and heard_until
 * reaches askedAt, or the listening is not live, or `waitMs` passes. Answers { flushed, live, heard_until, waited_ms }.
 */
export async function waitForHearing(door, listening, { askedAt, waitMs = data.ask.wait_seconds * 1000, now = () => Date.now(), sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  const began = now();
  for (;;) {
    const status = await door.read(STATUS, `${STATUS}:${listening}`);
    const live = livenessOf(status ? { listening: true, heartbeat_ms: status.heartbeat_ms } : null, now()).live;
    const flushed = Boolean(status) && !status.hearing_pending && Date.parse(status.heard_until ?? '') >= askedAt;
    if (flushed || !live || now() - began >= waitMs) return { flushed, live, heard_until: status?.heard_until ?? null, waited_ms: now() - began };
    await sleep(Math.min(data.ask.poll_ms, Math.max(0, waitMs - (now() - began))));
  }
}

/** The turns after the cursor (the start in milliseconds of the last turn given), oldest first. */
export const turnsAfter = (rows, cursor) => rows.filter(row => startOf(row.id) > Number(cursor?.after_ms ?? -Infinity));

/**
 * tool:ask-what-was-said: { listening, conversation, wait_seconds?, asked_at? } -> { listening, lines, flushed, live,
 * heard_until, cursor }. Waits for what was said before the ask to be written (F-0298), answers the captions of the turns
 * this conversation was not given yet (F-0297, F-0792), and moves the conversation's cursor past them.
 */
export async function askWhatWasSaid(input, { door }, steps = {}) {
  const listening = String(input?.listening ?? '').trim();
  const conversation = String(input?.conversation ?? '').trim();
  if (!listening || !conversation) throw fail(data.words.ask_needs);
  const now = steps.now ?? (() => Date.now());
  const askedAt = input.asked_at == null ? now() : Date.parse(input.asked_at);
  const waitSeconds = Math.min(Number(input.wait_seconds ?? data.ask.wait_seconds), data.ask.most_wait_seconds);
  const flush = await waitForHearing(door, listening, { askedAt, waitMs: waitSeconds * 1000, now, sleep: steps.sleep });
  const cursorId = `${CURSOR}:${conversation}:${listening}`;
  const cursor = await door.read(CURSOR, cursorId);
  const fresh = turnsAfter(await heardOf(door, listening), cursor);
  const captions = (await door.read(CAPTIONS, `${CAPTIONS}:${listening}`)) ?? {};
  const after = fresh.length ? startOf(fresh.at(-1).id) : Number(cursor?.after_ms ?? -1);
  if (fresh.length) await door.write([{ id: cursorId, type: CURSOR, value: { conversation, listening, after_ms: after, at: new Date(now()).toISOString() } }], { key: `${cursorId}:${after}` });
  return { listening, conversation, ...flush, lines: applyCaptions(fresh, { edits: captions.edits ?? {} }), cursor: after };
}
