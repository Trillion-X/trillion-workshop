// tools/listen-for-a-while/read-data/listen-for-a-while.mjs
//
// Purpose
//   Listens to the microphone until the end time the person gave. One recorder is opened once and writes the sound in
//   pieces back to back; each piece is heard (tools/audio-transcription), each turn in it is named from the prints
//   people enrolled (tools/know-who-is-in-this), and each turn is written as a `heard` row as soon as its piece has been
//   heard, so rows arrive while the run lasts, not only at its end. A 110 second run and a four hour run are this same
//   code: the run's length is its `until`, and the engine kills the run's process group at its deadline.
//
// Non-negotiable invariants
//   1. It listens only until `until`: the recorder is told how many seconds are left and ends by itself, finishing its
//      last piece. Nothing is recorded after the end time, and a run the engine cancels ("off") leaves only the pieces
//      already finished; a piece is deleted the moment it has been heard.
//   2. The sound never leaves the device: pieces are written in the run's own private folder, heard and named there,
//      and deleted. Only text, a name and a score are written to the person's records.
//   3. Hearing and naming are other tools' owners: this file runs audio-transcription's `transcribe` and
//      know-who-is-in-this's `who-is-in-this.py` on each piece and adds no recognizer.
//   4. One turn is one row, its id its listening and start time, so writing a piece again changes nothing.
//   5. Every number, program and wording is an input or a row; nothing here names a person.
//   6. Pause is real: nothing said after the moment the person turned listening off (their `listening-switch` row says
//      { on: false, since }) is kept, however far behind the hearing is. A piece recorded after it is let go unheard, the
//      words after it in the piece it fell in are dropped before they are named or written, and the run then ends.
//   7. Recording rules the person opted into (`recording-rule` rows and the request's `recording_rules`, read-data/
//      recording-rules.mjs) are asked again for every piece, in this capture owner: a piece recorded while they say blocked
//      is let go unheard. With none, nothing is ever blocked.
//   8. What listening sends off this computer is told from DATA (read-data/leaves.json, leavesOf), in every answer.
//   9. A stretch that is only text a hearing model makes up out of silence (read-data/meeting-ledger.mjs isFalseText) is
//      left out before it is named or written.
//  10. One device hears a listening at a time (the `transcriber` row, F-0793): a piece another device's live role covers is
//      let go unheard. Each piece says in the `listening-status` row that it is being heard and, once written, how far
//      what was said is written (F-0298), so an ask can wait for it (read-data/what-was-said.mjs).
//  11. The sound is kept only when the person asked (`keep_sound`), as one compressed file per piece in their files with
//      each turn's place in it (read-data/what-was-said.mjs keepPieceSound); invariant 2 holds otherwise.
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { evaluate } from './recording-rules.mjs';
import { isFalseText } from './meeting-ledger.mjs';
import leaves from './leaves.json' with { type: 'json' };
import { readWholeFile } from '../../records-door/read-data/whole-file.mjs';
import { TRANSCRIBER, keepPieceSound, mayTranscribe, roleHolder, roleRow, statusRow, writeSpeakersBack } from './what-was-said.mjs';

const run = promisify(execFile);
const MOST_PIECE_SECONDS = 120;

export const HEARD = 'heard';
export const SESSION = 'listening-voices';
export const VOICE_PRINT = 'voice-print';
export const RULE = 'recording-rule';
export const FACTS = 'recording-facts';
export const SWITCH = 'listening-switch';

/**
 * When the person turned listening off, in ms, while the switch still says off (null otherwise). A spoken stop is dated
 * where the words ended, not when they were heard, so what was recorded after them in pieces already waiting to be heard
 * is not kept either (invariant 6).
 */
export function pausedAt(state) {
  return state?.on === false ? Date.parse(state.since) || null : null;
}
/** The stretches said before the pause (all of them when listening is not paused). */
export const beforePause = (stretches, at) => (at == null ? stretches : stretches.filter(stretch => stretch.start_ms < at));

/**
 * What listening sends off this computer and what stays on it, worded from the same settings that decide it
 * (listen.leaves, DATA): each row shows only while all its `when` tests hold ({ setting: 'a.b', equals | not }),
 * so the list cannot say something is kept that is not. Returns { leaves: [{ id, what, to }], stays: [{ id, what, to }] }.
 */
export function leavesOf(listen) {
  const at = path_ => path_.split('.').reduce((value, key) => value?.[key], listen);
  const shown = (listen.leaves ?? []).filter(row => (row.when ?? []).every(test => (Object.hasOwn(test, 'equals') ? at(test.setting) === test.equals : at(test.setting) !== test.not)));
  const words = row => ({ id: row.id, what: row.what, to: row.to });
  return { leaves: shown.filter(row => row.leaves).map(words), stays: shown.filter(row => !row.leaves).map(words) };
}

/** The rules asked for a piece: the request's own plus the value of every `recording-rule` row, read again each piece. */
export async function rulesIn(input, door) {
  const rules = [...(input.recording_rules ?? [])];
  for await (const row of door.list({ type: RULE })) if (row.value) rules.push(row.value);
  return rules;
}
/** The facts the rules are asked about: this listening, the request's facts, then the listening's `recording-facts` row. */
export async function factsIn(input, door, { listening, device }) {
  return { kind: 'listening', device, ...(input.recording_facts ?? {}), ...((await door.read(FACTS, `${FACTS}:${listening}`)) ?? {}) };
}

/** The end time as milliseconds since 1970: a number, or an ISO time. Refuses a missing or unreadable time. */
export function endOf(until) {
  const ms = typeof until === 'number' ? until : Date.parse(until);
  if (!Number.isFinite(ms)) throw new Error('Say when to stop listening: `until` is a time.');
  return ms;
}

/** How many whole seconds are left from `now` to `end`, at least 1, so the recorder is never asked for nothing. */
export const secondsLeft = (end, now) => Math.max(1, Math.ceil((end - now) / 1000));

/** The piece length: `piece_seconds` within 5 and 120, default 30. */
export function pieceSeconds(asked) {
  const seconds = Number(asked ?? 30);
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > MOST_PIECE_SECONDS) throw new Error(`piece_seconds is between 5 and ${MOST_PIECE_SECONDS}.`);
  return Math.round(seconds);
}

/** The recorder's command: the microphone opened once, written as pieces of `seconds`, one `<file>,<start>,<end>` line each. */
export function recorderArgv({ device, seconds, folder, total }) {
  return ['-v', 'error', '-nostdin', '-f', 'avfoundation', '-i', `:${device}`, '-t', String(total), '-ac', '1', '-ar', '16000',
    '-f', 'segment', '-segment_time', String(seconds), '-reset_timestamps', '1', '-segment_list', 'pipe:1', '-segment_list_type', 'csv', '-y', join(folder, '%d.wav')];
}

/** One recorder line as a piece: { file, startMs, endMs } with times on the clock, from when the recorder began. */
export function pieceOf(line, folder, beganMs) {
  const [name, start, end] = String(line).trim().split(',');
  if (!name || !Number.isFinite(Number(start)) || !Number.isFinite(Number(end))) return null;
  return { file: join(folder, name), startMs: beganMs + Math.round(Number(start) * 1000), endMs: beganMs + Math.round(Number(end) * 1000) };
}

/** The `heard` rows for the turns of one piece (turns as who-is-in-this answers them, seconds from the piece's start). */
export function heardRows(turns, { listening, device, startMs }) {
  return turns.filter(turn => String(turn.text ?? '').trim()).map(turn => {
    const at = startMs + Math.round(turn.start * 1000);
    return {
      id: `${HEARD}:${listening}:${at}`,
      type: HEARD,
      value: {
        listening, device, start: new Date(at).toISOString(), end: new Date(startMs + Math.round(turn.end * 1000)).toISOString(), text: String(turn.text).trim(),
        speaker: turn.who, me: turn.me === true, ...(turn.voice ? { voice: turn.voice } : {}), ...(Number.isFinite(turn.score) ? { score: turn.score } : {}),
        ...(turn.unsure?.length ? { unsure: turn.unsure } : {}),
      },
    };
  });
}

/** Records the microphone until the end time; yields each finished piece as it finishes. */
export async function* recordPieces({ device, seconds, folder, end, now = () => Date.now(), start = spawn, program = 'ffmpeg' }) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const began = now();
  const child = start(program, recorderArgv({ device, seconds, folder, total: secondsLeft(end, began) }), { stdio: ['ignore', 'pipe', 'pipe'] });
  let failure = '';
  child.stderr?.on('data', chunk => { failure = (failure + chunk).slice(-400); });
  const finished = new Promise(done => child.on('close', done));
  let pending = '';
  const lines = [];
  let wake = null;
  const push = text => { pending += text; const parts = pending.split('\n'); pending = parts.pop(); lines.push(...parts); wake?.(); };
  child.stdout.on('data', chunk => push(String(chunk)));
  let closed = null;
  finished.then(code => { closed = code; wake?.(); });
  try {
    for (;;) {
      while (lines.length) { const piece = pieceOf(lines.shift(), folder, began); if (piece) yield piece; }
      if (closed !== null) break;
      await new Promise(done => { wake = done; });
      wake = null;
    }
    while (lines.length) { const piece = pieceOf(lines.shift(), folder, began); if (piece) yield piece; }
  } finally {
    // A listener that stops early (the person paused) closes the microphone itself.
    if (closed === null) child.kill('SIGTERM');
  }
  if (closed !== 0 && now() < end - 2000) throw new Error(`The microphone stopped before the end time${failure ? `: ${failure.trim()}` : '.'}`);
}

/** Hears one piece with audio-transcription's `transcribe`: its timed stretches in seconds. */
export async function hearPiece(file, { transcribeScript, modelPath, whisperCli = null, ffmpeg = null, python = 'python3' }) {
  const out = `${file}.json`;
  const programs = [...(whisperCli ? ['--whisper-cli', whisperCli] : []), ...(ffmpeg ? ['--ffmpeg', ffmpeg] : [])];
  await run(python, [transcribeScript, 'transcribe', '--audio', file, '--out', out, '--model-path', modelPath, ...programs], { maxBuffer: 64 * 1024 * 1024 });
  const heard = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out, { force: true });
  return (heard.segments ?? []).map(({ start, end, text }) => ({ start, end, text }));
}

/** Names the turns of one piece with know-who-is-in-this's `who-is-in-this.py`: { speakers, records }. */
export async function namePiece(request, { nameScript, python = 'python3' }) {
  const child = execFile(python, [nameScript], { maxBuffer: 64 * 1024 * 1024 });
  const finished = new Promise((done, fail) => {
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', fail);
    child.on('close', code => (code === 0 ? done(out) : fail(new Error(`naming failed (${code})`))));
  });
  child.stdin.end(JSON.stringify(request));
  const lines = (await finished).trim().split('\n');
  return JSON.parse(lines.at(-1));
}

/**
 * The tool: input { until, listening, device_index?, piece_seconds?, model_path, rules?, words?, folder?, recording_rules?, recording_facts? }.
 * `steps` replaces the recorder, hearing and naming for tests; the defaults are the real programs.
 */
export async function listenForAWhile(input, { door }, steps = {}) {
  // The engine ends a run at its deadline and calls that a failure of unknown outcome, so the recording ends early enough
  // for the last piece to be heard, named and written before `until`.
  const end = endOf(input.until) - finishMs(input.finish_seconds);
  const now = steps.now ?? (() => Date.now());
  const listening = String(input.listening ?? new Date(now()).toISOString().replace(/[:.]/g, '-'));
  const device = String(input.device ?? 'this-device');
  const seconds = pieceSeconds(input.piece_seconds);
  const folder = input.folder ?? join(process.env.TMPDIR ?? '.', `listening-${listening}`);
  const record = steps.record ?? (() => recordPieces({ device: input.device_index ?? 'default', seconds, folder, end, now, program: input.ffmpeg ?? 'ffmpeg' }));
  return hearPieces(input, door, steps, { listening, device, pieces: record({ end }) });
}

/** The programs one run hears and names with: the scripts of the two owners, the model and the programs the person chose. */
const workOf = input => ({ transcribeScript: input.transcribe_script ?? '/opt/audio-transcription/do-work/audio_transcription.py', modelPath: input.model_path,
  whisperCli: input.whisper_cli ?? null, ffmpeg: input.ffmpeg ?? null, nameScript: input.name_script ?? '/opt/know-who-is-in-this/do-work/who-is-in-this.py' });

/**
 * Hears, names and writes every piece `pieces` yields, one after another, each deleted once heard: the one loop both a
 * live listening and a recording another device made go through, so their rows are the same. Returns the tally.
 */
export async function hearPieces(input, door, steps, { listening, device, pieces }) {
  const work = workOf(input);
  if (!steps.hear && !work.modelPath) throw new Error('Give model_path: the ggml Whisper model file on this computer.');
  const hear = steps.hear ?? (file => hearPiece(file, work));
  const name = steps.name ?? (request => namePiece(request, work));
  const now = steps.now ?? (() => Date.now());
  const tally = { listening, pieces: 0, turns: 0, rows_written: 0, left_out: 0, let_go: 0, blocked: null, paused: null, transcriber: null, sounds_kept: 0,
    ...leavesOf({ ...leaves, keep_sound: { on: Boolean(input.keep_sound?.folder) } }) };
  // The unknown voices already heard in this listening (an earlier run of it), so voice-3 stays voice-3.
  let session = null;
  for await (const row of door.list({ type: SESSION })) if (row.value?.listening === listening) session = row.value;
  // One piece: asked against the rules, let go after a pause, heard, named and written. Answers whether listening ends.
  const listenTo = async piece => {
    // The person's own opt-in recording rules, asked again here in the capture owner (no rules: allowed).
    const verdict = evaluate(await rulesIn(input, door), await factsIn(input, door, { listening, device }));
    if (verdict.state === 'blocked') { tally.blocked = verdict.why; tally.let_go += 1; return false; }
    tally.blocked = null;
    // Recorded after the person paused listening: let go unheard, and listening ends (invariant 6). A piece recorded
    // before the pause is still heard, without the words said after it.
    const paused = pausedAt(await door.read(SWITCH, `${SWITCH}:${listening}`));
    if (paused !== null) tally.paused = new Date(paused).toISOString();
    if (paused !== null && piece.startMs >= paused) { tally.let_go += 1; return true; }
    // Another device holds the transcriber role and is still hearing: this piece is theirs (F-0793).
    const role = await door.read(TRANSCRIBER, `${TRANSCRIBER}:${listening}`);
    tally.transcriber = roleHolder(role, now());
    if (!mayTranscribe(role, device, now())) { tally.let_go += 1; return false; }
    await door.write([roleRow(listening, device, now()), statusRow(listening, { pending: true, heardUntilMs: tally.heard_until_ms, now: now(), device })], { key: `pending:${listening}:${piece.startMs}` });
    const segments = beforePause((await hear(piece.file)).map(segment => ({ ...segment, start_ms: piece.startMs + Math.round(segment.start * 1000) })), paused)
      .map(({ start_ms: _, ...segment }) => segment)
      // Text a hearing model makes up out of silence is left out before it is named or kept (isFalseText).
      .filter(segment => !isFalseText(segment.text));
    tally.pieces += 1;
    if (!segments.length) return false;
    const prints = [];
    for await (const row of door.list({ type: VOICE_PRINT })) prints.push(row);
    const sessions = session ? [session] : [];
    const named = await name({ file: piece.file, segments, listening, voice_prints: prints, voice_sessions: sessions, rules: input.rules, words: input.words, join_within_seconds: input.join_within_seconds });
    const sound = await keepPieceSound(door, piece, heardRows(named.speakers, { listening, device, startMs: piece.startMs }), { keep: input.keep_sound, listening, ffmpeg: input.ffmpeg, encode: steps.encode });
    const rows = sound.rows;
    if (sound.kept) tally.sounds_kept += 1;
    if (sound.error) tally.sound_error = sound.error;
    steps.collect?.push(...rows);
    tally.turns += named.speakers.length;
    tally.left_out += named.speakers.length - rows.length;
    const kept = [...rows, ...(named.records ?? []).map(({ id, kind, ...value }) => ({ id, type: kind, value: { kind, id, ...value } }))];
    session = (named.records ?? []).find(each => each.kind === SESSION) ?? session;
    if (kept.length) { await door.write(kept, { key: `listen:${listening}:${piece.startMs}` }); tally.rows_written += rows.length; }
    return false;
  };
  for await (const piece of pieces) {
    let stop;
    try {
      stop = await listenTo(piece);
    } finally {
      rmSync(piece.file, { force: true });
    }
    // What was said up to the end of this piece is written (or let go): an ask waiting on it may answer (F-0298).
    if (tally.transcriber === null || tally.transcriber === device) {
      tally.heard_until_ms = Math.max(tally.heard_until_ms ?? 0, piece.endMs);
      await door.write([statusRow(listening, { pending: false, heardUntilMs: tally.heard_until_ms, now: now(), device })], { key: `heard:${listening}:${piece.startMs}` });
    }
    if (stop) break;
  }
  const { heard_until_ms: heardUntil, ...answer } = tally;
  return { ...answer, heard_until: heardUntil == null ? null : new Date(heardUntil).toISOString() };
}

/** How long before `until` recording stops, so the last piece is finished in time: `finish_seconds` within 0 and 600, default 60. */
export function finishMs(asked) {
  const seconds = Number(asked ?? 60);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) throw new Error('finish_seconds is between 0 and 600.');
  return Math.round(seconds * 1000);
}

/**
 * `tool:hear-for-a-device`: hears a recording another of the person's devices made ({ file, at, device }) exactly as this
 * computer's own listening hears its pieces: every turn in it is named against the voices people enrolled and written as
 * a `heard` row of that device, dated from `at` (when the device began recording; now when left out). The recording is
 * read once through the run's door into the run's own folder and deleted there once heard; the person's file is left
 * where it is (moved from the product repo's computer/listen.mjs listeningTools.hear).
 */
export async function hearForADevice(input, { door }, steps = {}) {
  const device = String(input.device ?? '').trim();
  if (!device) throw Object.assign(new Error('Say which device recorded this: `device` is its name.'), { status: 400 });
  if (!String(input.file ?? '').trim()) throw Object.assign(new Error('Give `file`: the recording\'s name or identity in the person\'s files.'), { status: 400 });
  const now = steps.now ?? (() => Date.now());
  const startMs = input.at == null ? now() : endOf(input.at);
  const listening = String(input.listening ?? `${device}-${new Date(startMs).toISOString().replace(/[:.]/g, '-')}`);
  const folder = input.folder ?? join(process.env.TMPDIR ?? '.', `heard-${listening}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const { title, size, bytes } = await readWholeFile(door, input.file);
  if (!bytes) throw new Error(`${input.file} is ${size} bytes, more than one run reads.`);
  const file = join(folder, `0${extname(title) || '.wav'}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  async function* one() { yield { file, startMs, endMs: startMs }; }
  const collect = [];
  try {
    const tally = await hearPieces(input, door, { ...steps, collect }, { listening, device, pieces: one() });
    // Who said each turn, written beside the person's recording when they asked (write_back).
    return input.write_back ? { ...tally, written_back: await writeSpeakersBack(door, collect, { file: input.file, startMs }) } : tally;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
