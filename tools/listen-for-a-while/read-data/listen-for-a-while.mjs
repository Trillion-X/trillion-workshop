// tools/listen-for-a-while/read-data/listen-for-a-while.mjs
//
// Purpose
//   Listens to the microphone until the end time the person gave. One recorder is opened once and writes the sound in
//   pieces back to back; each piece is heard (tools/audio-transcription), each turn in it is named from the prints
//   people enrolled (tools/know-who-is-in-this, handed in as `voice_prints`), and the turns come back in the answer as
//   `heard` rows. The tool keeps nothing: it reads no row and writes none; everything it needs is its request and
//   everything it makes is its answer. A 110 second run and a four hour run are this same code: the run's length is its
//   `until`, and the engine kills the run's process group at its deadline.
//
// Non-negotiable invariants
//   1. It listens only until `until`: the recorder is told how many seconds are left and ends by itself, finishing its
//      last piece. Nothing is recorded after the end time, and a run the engine cancels ("off") leaves only the pieces
//      already finished; a piece is deleted the moment it has been heard.
//   2. The sound never leaves the device: pieces are written in the run's own private folder, heard and named there,
//      and deleted. Only text, a name and a score are in the answer.
//   3. Hearing and naming are other tools' owners: this file runs audio-transcription's `transcribe` and
//      know-who-is-in-this's `who-is-in-this.py` on each piece and adds no recognizer.
//   4. One turn is one row, its id its listening and start time, so writing a piece again changes nothing.
//   5. Every number, program and wording is an input or a row; nothing here names a person.
//   6. Pause is real: nothing said after the moment the person turned listening off (the request's `listening_switch`
//      says { on: false, since }) is kept, however far behind the hearing is. A piece recorded after it is let go unheard,
//      the words after it in the piece it fell in are dropped before they are named, and the run then ends.
//   7. Recording rules the person opted into (the request's `recording_rules`, read-data/recording-rules.mjs) are asked
//      for every piece, in this capture owner: a piece recorded while they say blocked is let go unheard. With none,
//      nothing is ever blocked.
//   8. What listening sends off this computer is told from DATA (read-data/leaves.json, leavesOf), in every answer.
//   9. A stretch that is only text a hearing model makes up out of silence (read-data/meeting-ledger.mjs isFalseText) is
//      left out before it is named or written.
//  10. One device hears a listening at a time (the request's `transcriber` role, { device, until }, F-0793): a piece
//      another device's live role covers is let go unheard. The answer says how far what was said is heard (`heard_until`).
//  11. The sound is never kept: not in the answer, not in the person's files.
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { evaluate } from './recording-rules.mjs';
import { isFalseText } from './meeting-ledger.mjs';
import leaves from './leaves.json' with { type: 'json' };
import { readWholeFile } from '../../records-door/read-data/whole-file.mjs';
import { mayTranscribe, roleHolder } from './what-was-said.mjs';
import { beforePause, leavesOf } from './listening-pure-functions-core.mjs';
export { beforePause, leavesOf };

const run = promisify(execFile);
const MOST_PIECE_SECONDS = 120;

export const HEARD = 'heard';
export const SESSION = 'listening-voices';

/**
 * When the person turned listening off, in ms, while the switch still says off (null otherwise). A spoken stop is dated
 * where the words ended, not when they were heard, so what was recorded after them in pieces already waiting to be heard
 * is not kept either (invariant 6).
 */
export function pausedAt(state) {
  return state?.on === false ? Date.parse(state.since) || null : null;
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
 * The tool: input { until, listening, device_index?, piece_seconds?, model_path, rules?, words?, folder?, recording_rules?, recording_facts?,
 * voice_prints?, voice_session?, listening_switch?, transcriber? }. It answers the turns it heard (`heard`) and keeps nothing.
 * `steps` replaces the recorder, hearing and naming for tests; the defaults are the real programs.
 */
export async function listenForAWhile(input, _context = {}, steps = {}) {
  // The engine ends a run at its deadline and calls that a failure of unknown outcome, so the recording ends early enough
  // for the last piece to be heard, named and written before `until`.
  const end = endOf(input.until) - finishMs(input.finish_seconds);
  const now = steps.now ?? (() => Date.now());
  const listening = String(input.listening ?? new Date(now()).toISOString().replace(/[:.]/g, '-'));
  const device = String(input.device ?? 'this-device');
  const seconds = pieceSeconds(input.piece_seconds);
  const folder = input.folder ?? join(process.env.TMPDIR ?? '.', `listening-${listening}`);
  const record = steps.record ?? (() => recordPieces({ device: input.device_index ?? 'default', seconds, folder, end, now, program: input.ffmpeg ?? 'ffmpeg' }));
  return hearPieces(input, steps, { listening, device, pieces: record({ end }) });
}

/** The programs one run hears and names with: the scripts of the two owners, the model and the programs the person chose. */
const workOf = input => ({ transcribeScript: input.transcribe_script ?? '/opt/audio-transcription/do-work/audio_transcription.py', modelPath: input.model_path,
  whisperCli: input.whisper_cli ?? null, ffmpeg: input.ffmpeg ?? null, nameScript: input.name_script ?? '/opt/know-who-is-in-this/do-work/who-is-in-this.py' });

/**
 * Hears and names every piece `pieces` yields, one after another, each deleted once heard: the one loop both a live
 * listening and a recording another device made go through, so their turns are the same. Answers the tally with the
 * `heard` rows (one per turn, id its listening and start time) and the listening's `voice_session` to hand to the next run.
 */
export async function hearPieces(input, steps, { listening, device, pieces }) {
  const work = workOf(input);
  if (!steps.hear && !work.modelPath) throw new Error('Give model_path: the ggml Whisper model file on this computer.');
  const hear = steps.hear ?? (file => hearPiece(file, work));
  const name = steps.name ?? (request => namePiece(request, work));
  const now = steps.now ?? (() => Date.now());
  const tally = { listening, pieces: 0, turns: 0, left_out: 0, let_go: 0, blocked: null, paused: null, transcriber: null, ...leavesOf(leaves), heard: [] };
  // The unknown voices already heard in this listening (an earlier run of it), so voice-3 stays voice-3.
  let session = input.voice_session ?? null;
  const prints = input.voice_prints ?? [];
  const role = input.transcriber ?? null;
  const paused = pausedAt(input.listening_switch);
  if (paused !== null) tally.paused = new Date(paused).toISOString();
  // The person's own opt-in recording rules, asked in the capture owner (no rules: allowed).
  const verdict = evaluate(input.recording_rules ?? [], { kind: 'listening', device, ...(input.recording_facts ?? {}) });
  let heardUntilMs = null;
  // One piece: asked against the rules, let go after a pause, heard and named. Answers whether listening ends.
  const listenTo = async piece => {
    if (verdict.state === 'blocked') { tally.blocked = verdict.why; tally.let_go += 1; return false; }
    // Recorded after the person paused listening: let go unheard, and listening ends (invariant 6). A piece recorded
    // before the pause is still heard, without the words said after it.
    if (paused !== null && piece.startMs >= paused) { tally.let_go += 1; return true; }
    // Another device holds the transcriber role and is still hearing: this piece is theirs (F-0793).
    tally.transcriber = roleHolder(role, now());
    if (!mayTranscribe(role, device, now())) { tally.let_go += 1; return false; }
    const segments = beforePause((await hear(piece.file)).map(segment => ({ ...segment, start_ms: piece.startMs + Math.round(segment.start * 1000) })), paused)
      .map(({ start_ms: _, ...segment }) => segment)
      // Text a hearing model makes up out of silence is left out before it is named or kept (isFalseText).
      .filter(segment => !isFalseText(segment.text));
    tally.pieces += 1;
    if (!segments.length) return false;
    const named = await name({ file: piece.file, segments, listening, voice_prints: prints, voice_sessions: session ? [session] : [], rules: input.rules, words: input.words, join_within_seconds: input.join_within_seconds });
    const rows = heardRows(named.speakers, { listening, device, startMs: piece.startMs });
    tally.turns += named.speakers.length;
    tally.left_out += named.speakers.length - rows.length;
    tally.heard.push(...rows);
    session = (named.records ?? []).find(each => each.kind === SESSION) ?? session;
    return false;
  };
  for await (const piece of pieces) {
    let stop;
    try {
      stop = await listenTo(piece);
    } finally {
      rmSync(piece.file, { force: true });
    }
    // What was said up to the end of this piece is heard (or let go).
    if (tally.transcriber === null || tally.transcriber === device) heardUntilMs = Math.max(heardUntilMs ?? 0, piece.endMs);
    if (stop) break;
  }
  return { ...tally, heard_until: heardUntilMs == null ? null : new Date(heardUntilMs).toISOString(), voice_session: session };
}

/** How long before `until` recording stops, so the last piece is finished in time: `finish_seconds` within 0 and 600, default 60. */
export function finishMs(asked) {
  const seconds = Number(asked ?? 60);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) throw new Error('finish_seconds is between 0 and 600.');
  return Math.round(seconds * 1000);
}

/**
 * `tool:hear-for-a-device`: hears a recording another of the person's devices made ({ file, at, device }) exactly as this
 * computer's own listening hears its pieces: every turn in it is named against the voices people enrolled and answered as
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
  try {
    return await hearPieces(input, steps, { listening, device, pieces: one() });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
