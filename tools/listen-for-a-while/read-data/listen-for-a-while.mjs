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
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MOST_PIECE_SECONDS = 120;

export const HEARD = 'heard';
export const SESSION = 'listening-voices';
export const VOICE_PRINT = 'voice-print';

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
  for (;;) {
    while (lines.length) { const piece = pieceOf(lines.shift(), folder, began); if (piece) yield piece; }
    if (closed !== null) break;
    await new Promise(done => { wake = done; });
    wake = null;
  }
  while (lines.length) { const piece = pieceOf(lines.shift(), folder, began); if (piece) yield piece; }
  if (closed !== 0 && now() < end - 2000) throw new Error(`The microphone stopped before the end time${failure ? `: ${failure.trim()}` : '.'}`);
}

/** Hears one piece with audio-transcription's `transcribe`: its timed stretches in seconds. */
export async function hearPiece(file, { transcribeScript, modelPath, python = 'python3' }) {
  const out = `${file}.json`;
  await run(python, [transcribeScript, 'transcribe', '--audio', file, '--out', out, '--model-path', modelPath], { maxBuffer: 64 * 1024 * 1024 });
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
 * The tool: input { until, listening, device_index?, piece_seconds?, model_path, rules?, words?, folder? }.
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
  const work = { transcribeScript: input.transcribe_script ?? '/opt/audio-transcription/do-work/audio_transcription.py', modelPath: input.model_path,
    nameScript: input.name_script ?? '/opt/know-who-is-in-this/do-work/who-is-in-this.py' };
  if (!steps.hear && !work.modelPath) throw new Error('Give model_path: the ggml Whisper model file on this computer.');
  const record = steps.record ?? (() => recordPieces({ device: input.device_index ?? 'default', seconds, folder, end, now }));
  const hear = steps.hear ?? (file => hearPiece(file, work));
  const name = steps.name ?? (request => namePiece(request, work));
  const tally = { listening, pieces: 0, turns: 0, rows_written: 0, left_out: 0 };
  // The unknown voices already heard in this listening (an earlier run of it), so voice-3 stays voice-3.
  let session = null;
  for await (const row of door.list({ type: SESSION })) if (row.value?.listening === listening) session = row.value;
  for await (const piece of record({ end })) {
    try {
      const segments = await hear(piece.file);
      tally.pieces += 1;
      if (!segments.length) continue;
      const prints = [];
      for await (const row of door.list({ type: VOICE_PRINT })) prints.push(row);
      const sessions = session ? [session] : [];
      const named = await name({ file: piece.file, segments, listening, voice_prints: prints, voice_sessions: sessions, rules: input.rules, words: input.words, join_within_seconds: input.join_within_seconds });
      const rows = heardRows(named.speakers, { listening, device, startMs: piece.startMs });
      tally.turns += named.speakers.length;
      tally.left_out += named.speakers.length - rows.length;
      const kept = [...rows, ...(named.records ?? []).map(({ id, kind, ...value }) => ({ id, type: kind, value: { kind, id, ...value } }))];
      session = (named.records ?? []).find(each => each.kind === SESSION) ?? session;
      if (kept.length) { await door.write(kept, { key: `listen:${listening}:${piece.startMs}` }); tally.rows_written += rows.length; }
    } finally {
      rmSync(piece.file, { force: true });
    }
  }
  return tally;
}

/** How long before `until` recording stops, so the last piece is finished in time: `finish_seconds` within 0 and 600, default 60. */
export function finishMs(asked) {
  const seconds = Number(asked ?? 60);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) throw new Error('finish_seconds is between 0 and 600.');
  return Math.round(seconds * 1000);
}
