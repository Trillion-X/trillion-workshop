#!/usr/bin/env node
// computer/listen.mjs
//
// Purpose
//   Listens on this computer for the person's Trillion while they have it on: the microphone is recorded in pieces,
//   by one recorder kept open while listening is on,
//   each piece is heard on this computer (the first `hearing` row in computer-sources.json whose program is here), each
//   stretch of words is named by who said it (know-who.py, against the people enrolled on this computer), and what was
//   said goes to the account's one door (/mcp/api/inbound) as it is said: one message per speaker's turn, every turn
//   of one moment in the same conversation, so it is kept with its speaker, searchable by who said it, and handed to
//   the person's AIs through the same arrival road as a note or a memo. A moment ends after `moments.quiet_seconds` with
//   nothing said, or after `moments.most_seconds`; each turn is sent once the next voice starts or the moment ends.
//   The computer reader (read-this-computer.mjs) starts it while the listening row's switch file says on
//   (startListening), and it stops by itself once the switch says off.
//
//     node computer/listen.mjs --keep-listening            (account key on stdin) listens until the switch says off
//     node computer/listen.mjs --file <recording> [--at <ISO time>]
//                                                         hears one recording the same way, as if heard live from --at
//
// Non-negotiable invariants
//   1. It listens only while the person has it on: the switch file (row.listen.switch) is read as every piece finishes,
//      and saying one of `pause_when_said` turns it off. macOS shows its own microphone light the whole time.
//      It also stops once the app that started it is gone, since the microphone is that app's: the app's next reader
//      starts a new listener, and a recorder that writes nothing for its piece plus 30 seconds is killed.
//   1c. Pause is real: nothing said after the moment the person turned listening off is kept, however far behind the
//      hearing is. A piece recorded after it is let go unheard, and the words after it in the piece it fell in are dropped
//      before they are named, sent or cut into a kept sound (pausedAt, beforePause). A spoken stop is dated where the words ended.
//   1e. Recording rules a workspace opted into (row.listen.recording_rules, src/recording-rules.mjs) are asked again here, in the
//      capture owner: a piece recorded while they say blocked is let go unheard. With none, nothing is ever blocked.
//   1d. What listening sends off this Mac is told from the settings that decide it (leavesOf, row.listen.leaves), shown by the
//      listen tool, so the list never says a sound is kept when keep_sound is off.
//   1a. The microphone is opened once per listening and kept open (recordPieces): one recorder writes the pieces back
//      to back. Opening it again for every piece (2026-10-03 to 2026-10-07) made macOS's sound server build and tear
//      down seven audio contexts, a recording-light change and a microphone permission check every half minute, two
//      thirds of every context it made on 2026-10-07, while the person's speakers crackled. Nothing here opens or
//      changes sound output. A recorder never outlives its listener: one killed outright (an app quit, a crash) leaves
//      its recorder holding the microphone under launchd, so before opening it, recordPieces stops every other process
//      recording into its own folder (leftRecorders); three such recorders, up to 27 hours old, held it open on
//      2026-10-11 while coreaudiod grew to 35 GB and wrote over the live listener's pieces.
//   1b. Hearing and naming run in resident model programs (computer/resident.py, the rows' `resident`), loaded once,
//      never a new Python and model load per piece (measured 2026-10-07: 25.6 s for the first piece, then 0.9 s).
//   2. Who said it is decided on this computer; voice and face numbers never leave it (know-who.py). Only enrolled
//      people are named; anyone else is "Someone (voice-N)", the same N for the whole listening session.
//   3. Words from anyone but the person are sent as someone else's (from_person false), so what a stranger says in the
//      room is information to the AIs, never an instruction.
//   4. Which turns are kept is DATA the person controls (row.listen.rules, over each turn's facts: words, speaker,
//      name, text). The sound of every moment is kept too while row.listen.keep_sound.on: one compressed file per
//      moment in the person's Trillion (keep_sound.folder/<day>/), its words kept on it line by line with their places
//      in the file, who said each and the message each became, so any line can be cut out as a clip; how long it is
//      kept is keep_sound.keep_days (null: always).
//   5. Nothing is sent twice: each turn's source_id is its moment and place in it, and the one door keeps an item
//      once by its source.
//   5b. The turns of a moment go to the door in bounded requests ({ items }), each answered in order, keeping the
//       same conversation and original source identities across chunks (listen.sending.batch_size, at most 100).
//   5a. Nothing heard is dropped and nothing hammers: a turn the account refuses for a moment waits its own time
//      (Retry-After, else a doubling wait with jitter) and after a few tries lets the turns behind it pass; a turn
//      refused for good moves aside to rejected.json with its reason and the person is told once (listen.sending).
//      The person can list those turns, send them again (a refusal for a moment by default, any by name) or let them go for good
//      (the listen tool's `rejected` input, rejectedTurnsTool): the tool writes a request into listen.sending.requests_folder and the
//      sender, which owns the files, does it at the start of its next pass (applyRequests).
//   6. Devices, programs, timings, rules, routes and words are DATA (computer-sources.json); this file names none.
//   7. When Trillion on this Mac has just asked the person something out loud, it says so in row.listen.answers.file
//      ({ notice_id, spoke_from, spoke_until, answer_until }, milliseconds). The file holds a list of those windows,
//      one per notice spoken, newest last (macos/App/SpeakAloud.swift keeps the last few; an older app wrote the one
//      newest as a single object, and both shapes are read). Only one notice is spoken at a time, so windows never
//      overlap: the app cuts an earlier window where the next begins, and the reader sorts by spoke_from and cuts each
//      window's spoke_until and answer_until at the next window's spoke_from, so a notice that never reported finishing
//      (its provisional end is ten minutes ahead) cannot make later turns Trillion's own voice, in files already
//      written or by an older app. A turn heard while it spoke in ANY window (give or take
//      margin_seconds) is its own voice. It is never lost and never the person's: it is sent labelled
//      (`from_person: false`, `from` = listen.answers.own_voice_as, `spoke: { notice_id }`) so the account keeps it as
//      generated context with evidence naming the notice and opens no decision (src/inbound.mjs invariant 8). A turn begun after it spoke and before answer_until, by anyone not named as someone
//      else, goes as that notice's answer (`answers`), even a one-word "later" the keep rules would leave out. One
//      question takes one answer: the person's turns heard together go as that one answer, joined in order, and once
//      it has gone (answered.json beside the waiting turns names the question by notice and spoke_until) later turns in
//      the window are ordinary talk, so a room's conversation after an answer never becomes more answers.
//
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hearWith, hearingHere, hearingNow, hearingReasons, hearingState, resultsOver, runFound, toolCaller } from './keep-drive-files.mjs';
import { bearerControl, namespaceClient } from '../browse-and-upload-my-files/do-work/namespace-client.mjs';
import { loadChunking } from '../browse-and-upload-my-files/do-work/content-chunks.mjs';
import { fileSource, sendWholeFiles } from '../browse-and-upload-my-files/do-work/send-a-file-to-a-namespace.mjs';
import { askHere, askLocal, localModelSettings, refreshModelRecords } from './local-models.mjs';
import { meetingNotes, taskProposalsFrom } from './meeting-notes.mjs';
import { tickHybridClock } from '../src/hybrid-clock.mjs';
import { available } from '../listen-for-a-while/read-data/private-mode.mjs';
import { evaluate } from '../listen-for-a-while/read-data/recording-rules.mjs';
import { factsIn, privateModeIn, rulesIn } from './listening-rules.mjs';
import { isFalseText, jobState, livenessOf } from './meeting-ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expand = (place, home = os.homedir()) => String(place).replace(/^~(?=\/|$)/, home);
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.part`, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  renameSync(`${file}.part`, file);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const wordsIn = text => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;

export const rowOf = rows => rows.sources.find(source => source.listen) ?? null;
/** Whether the person has listening on: the switch file's `on`. */
export const isOn = listen => readJson(expand(listen.switch))?.on === true;
/** Turns listening on or off for this computer, saying who did it and when. */
export function setOn(listen, on, by = 'this computer', now = new Date()) {
  writeJson(expand(listen.switch), { on: Boolean(on), since: now.toISOString(), by });
  return { on: Boolean(on), since: now.toISOString(), by };
}

/**
 * When the person turned listening off, in ms, while the switch still says off (null otherwise). A spoken stop is dated
 * where the words ended, not when they were heard, so what was recorded after them in pieces already waiting to be heard
 * is not kept either (invariant 1c).
 */
export function pausedAt(listen) {
  const state = readJson(expand(listen.switch));
  return state?.on === false ? Date.parse(state.since) || null : null;
}
/** The stretches said before the pause (all of them when listening is not paused). */
export const beforePause = (stretches, at) => (at == null ? stretches : stretches.filter(stretch => stretch.start_ms < at));

/**
 * What listening sends off this Mac and what stays on it, worded from the same settings that decide it
 * (listen.leaves, DATA): each row shows only while all its `when` tests hold ({ setting: 'a.b', equals | not }),
 * so the list cannot say a sound is kept when keep_sound is off. Returns { leaves: [{ id, what, to }], stays: [{ id, what, to }] }.
 */
export function leavesOf(listen) {
  const at = path_ => path_.split('.').reduce((value, key) => value?.[key], listen);
  const shown = (listen.leaves ?? []).filter(row => (row.when ?? []).every(test => (Object.hasOwn(test, 'equals') ? at(test.setting) === test.equals : at(test.setting) !== test.not)));
  const words = row => ({ id: row.id, what: row.what, to: row.to });
  return { leaves: shown.filter(row => row.leaves).map(words), stays: shown.filter(row => !row.leaves).map(words) };
}

// ---- What was heard, as turns ----------------------------------------------------------------------------------------

/**
 * Stretches of words (each { start_ms, end_ms, text, voice, who, score }) as turns: consecutive stretches of the same
 * voice with at most join_within_seconds between them are one turn. Returns [{ start_ms, end_ms, text, voice, who, score }].
 */
export function turnsOf(stretches, joinWithinSeconds = 2) {
  const turns = [];
  for (const stretch of stretches) {
    const last = turns.at(-1);
    if (last && last.voice === stretch.voice && stretch.start_ms - last.end_ms <= joinWithinSeconds * 1000) {
      last.end_ms = stretch.end_ms;
      last.text = `${last.text} ${stretch.text}`.trim();
      // A turn is as sure of its voice as its least sure stretch; a stretch never measured (score null) makes it unsure.
      last.score = Number.isFinite(last.score) && Number.isFinite(stretch.score) ? Math.min(last.score, stretch.score) : null;
    } else turns.push({ ...stretch });
  }
  return turns;
}

/** One turn's facts, which the rules are written over: words, speaker (me, enrolled, unknown), name, text. */
export const factsOf = turn => ({
  words: wordsIn(turn.text),
  speaker: turn.who?.me ? 'me' : turn.who ? 'enrolled' : turn.unsure?.length ? 'unsure' : 'unknown',
  name: turn.who?.name ?? null,
  text: String(turn.text ?? '').toLowerCase(),
});

// A rule's test holds when every condition it names holds for the facts.
const holds = (test, facts) => Object.entries(test).every(([condition, value]) => {
  if (condition === 'fact') return true;
  const fact = facts[test.fact];
  if (condition === 'equals') return fact === value;
  if (condition === 'one_of') return value.includes(fact);
  if (condition === 'less_than') return typeof fact === 'number' && fact < value;
  if (condition === 'contains_any') return typeof fact === 'string' && value.some(words => fact.includes(String(words).toLowerCase()));
  return false;
});

/** The first rule whose `when` all hold decides; a turn no rule names is kept. Returns { keep, rule }. */
export function decide(rules = [], turn) {
  const facts = factsOf(turn);
  for (const rule of rules) {
    if (rule.on === false) continue;
    if ((rule.when ?? []).every(test => holds(test, facts))) return { keep: rule.keep !== false, rule: rule.id };
  }
  return { keep: true, rule: null };
}

/** Whether a turn said one of the words that turn listening off. */
export const turnsOff = (phrases = [], text = '') => phrases.some(words => String(text).toLowerCase().includes(String(words).toLowerCase()));

/**
 * Who a turn is from, as its message says: the enrolled person's name; when voices could be more than one person,
 * "Unsure (Dana or Morgan?)" so the people are asked, never decided silently; else "Someone (voice-N)".
 */
export function speakerOf(turn, words) {
  if (turn.who?.name) return turn.who.name;
  const names = (turn.unsure ?? []).map(person => person.name);
  if (names.length) return fill(words.unsure, { names: names.length > 1 ? `${names.slice(0, -1).join(', ')} ${words.or} ${names.at(-1)}` : names[0] });
  return fill(words.unknown, { voice: turn.voice ?? '' });
}

/** The one door's item for one turn of a moment (src/inbound.mjs receive). */
export function arrivalOf(turn, index, moment, listen, eventClock = null) {
  const at = new Date(turn.start_ms);
  const clock = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const me = turn.who?.me === true;
  return {
    route: listen.route,
    conversation_id: `${listen.route}:${moment.computer}:${moment.id}`,
    source_id: `${moment.id}#${index + 1}`,
    text: turn.text,
    at: at.toISOString(),
    ...(eventClock ? { clock: eventClock } : {}),
    title: fill(listen.words.title, { clock, day: at.toISOString().slice(0, 10) }),
    chat_first_minutes: 0,
    // Heard in a room, not written to an AI: the person's attention rules (src/attention.json) decide what it gets.
    heard: true,
    // How sure this computer is of the voice (know-who.py score, 0 to 1; null when a stretch was too short to measure):
    // Trillion acts on heard words only when the voice is the person's above the bar in their attention rules.
    // `voice` is the label an unnamed voice is kept apart by (voice-3), so a new voice is a person of its own whose
    // requests are theirs; `unsure` the people it could be when more than one (src/attention.json voice_new).
    voice: {
      me, named: Boolean(turn.who), ...(turn.who?.name ? { name: turn.who.name } : {}), score: Number.isFinite(turn.score) ? turn.score : null,
      ...(!turn.who && !turn.unsure?.length && turn.voice ? { voice: turn.voice } : {}),
      ...(turn.unsure?.length ? { unsure: turn.unsure.map(person => person.name) } : {}),
    },
    ...(me ? {} : { from_person: false, from: speakerOf(turn, listen.words) }),
  };
}

/**
 * The notes job of one listening: lines of a moment -> meeting notes, its typed state kept on `status` (jobState), and the action items
 * proposed as tasks for the person to review (taskProposalsFrom, `call` is the account's tool caller). A failed proposal never loses the notes.
 */
export function notesMaker({ settings, status, report, log, ask, call }) {
  return async lines => {
    status.notes = jobState('noting'); report();
    try {
      const made = await meetingNotes({ lines, notes: settings.notes, template: settings.notes.template ?? null, keeps: line => decide(settings.rules, line).keep, log, ask });
      const proposals = taskProposalsFrom(made, settings.notes, String(lines[0]?.source_id ?? '').replace(/#\d+$/, ''));
      if (proposals) await call(settings.notes.propose_tasks.tool, proposals).catch(error => log(`Listening: action items were not proposed: ${error.message}`));
      status.notes = made ? jobState('noted') : jobState('waiting'); report();
      return made;
    } catch (error) { status.notes = jobState('failed', String(error.message ?? error)); report(); throw error; }
  };
}

// ---- One listening session ---------------------------------------------------------------------------------------

/**
 * One session's moments. heard(piece) takes a piece's stretches (absolute ms, named) and the time the piece ended,
 * and returns the turns that are finished now: every turn of the open moment but its last, and the whole of a moment
 * that ended (quiet for quiet_seconds, or longer than most_seconds). end() finishes the open moment.
 */
export function moments(listen, computer, now = () => Date.now()) {
  let open = null;
  let sent = 0;
  const fresh = startMs => ({ id: new Date(startMs).toISOString().replace(/[:.]/g, '-'), computer, start_ms: startMs, stretches: [] });
  const ended = [];
  const finished = (moment, all) => {
    if (all) ended.push(moment);
    const turns = turnsOf(moment.stretches, listen.turns.join_within_seconds);
    const ready = all ? turns : turns.slice(0, -1);
    const out = ready.slice(sent).map((turn, offset) => ({ turn, index: sent + offset, moment }));
    sent = ready.length;
    return out;
  };
  return {
    heard(stretches, pieceEndMs = now()) {
      const out = [];
      for (const stretch of stretches) {
        if (open && (stretch.start_ms - (open.stretches.at(-1)?.end_ms ?? open.start_ms) >= listen.moments.quiet_seconds * 1000 || stretch.start_ms - open.start_ms >= listen.moments.most_seconds * 1000)) {
          out.push(...finished(open, true));
          open = null; sent = 0;
        }
        open ??= fresh(stretch.start_ms);
        open.stretches.push(stretch);
      }
      if (open && pieceEndMs - (open.stretches.at(-1)?.end_ms ?? open.start_ms) >= listen.moments.quiet_seconds * 1000) {
        out.push(...finished(open, true));
        open = null; sent = 0;
      } else if (open) out.push(...finished(open, false));
      return out;
    },
    end() { const out = open ? finished(open, true) : []; open = null; sent = 0; return out; },
    /** The moments that ended since this was last asked (their whole stretches, for keeping their sound). */
    ended() { return ended.splice(0); },
    /** When the moment still open started, or null. */
    openStart() { return open?.start_ms ?? null; },
  };
}

// ---- Programs on this computer -----------------------------------------------------------------------------------

/** The know-who program found on this computer (the first copy of its check that answers), or null. */
export const knowWhoHere = listen => hearingHere([{ ...listen.know_who, id: 'know-who' }]);

/** Runs know-who.py (through its resident when the row has one): (command, ...args) -> its JSON answer. */
export const knowWhoCaller = (found, listen) => (command, ...args) => runFound(found, {}, {
  more: [command, JSON.stringify({ voices: listen.know_who.voices, faces: listen.know_who.faces }), expand(listen.people), ...args],
  mostSeconds: listen.know_who.most_seconds ?? 600,
});

/** The program that records the microphone, found on this computer the way a hearing program is (capture.check and
 *  capture.search_path), since an app's child runs with a short PATH that holds none of the person's installed tools. */
export const captureHere = listen => hearingHere([{ ...listen.capture, id: 'capture' }]);

/**
 * Records the microphone once, piece after piece, with the found capture program: its `run` (DATA) opens the device
 * once and writes a piece of `seconds` into `folder` back to back, printing one line per finished piece,
 * `<file>,<start seconds>,<end seconds>` from the start of the recording. Opening the microphone again for every piece
 * made macOS's sound server build and tear down a recording (and the microphone light) every half minute.
 *
 *   next()  -> the next finished piece { file, startedMs, endedMs, seconds }, or null once the program has ended
 *              after stop(); throws when it ended by itself or wrote nothing for `seconds` plus `graceSeconds` (30;
 *              it is killed).
 *   stop()  -> asks the program to finish its piece and end; the pieces it finishes still come from next().
 *
 * Real time comes from the file system: the first piece's file is made as the sound starts, and every later piece
 * starts where the one before it ended in the sound, so pieces lie back to back with no gap.
 */
export function recordPieces(capture, folder, seconds, { start = spawn, made = file => statSync(file).birthtimeMs, graceSeconds = 30, left = leftRecorders } = {}) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  left(folder);
  const [first, ...args] = capture.run.map(part => fill(part, { device: capture.device, seconds, folder }));
  const program = capture.program && first === capture.check[0] ? capture.program : first;
  const child = start(program, args, { env: capture.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const finished = [];
  const waiting = [];
  let ended = null; let stopped = false; let anchor = null; let text = ''; let said = '';
  const hand = () => {
    while (waiting.length && (finished.length || ended)) {
      const { resolve, reject, timer } = waiting.shift();
      clearTimeout(timer);
      if (finished.length) resolve(finished.shift());
      else if (stopped && !ended.error) resolve(null);
      else reject(ended.error ?? new Error(said.trim().split('\n').pop() || `the recorder ended (${ended.code ?? ended.signal})`));
    }
  };
  child.stdout.on('data', chunk => {
    text += chunk;
    for (let at; (at = text.indexOf('\n')) >= 0;) {
      const line = text.slice(0, at).trim(); text = text.slice(at + 1);
      const [name, from, to] = line.split(',');
      if (!name || !Number.isFinite(Number(from)) || !Number.isFinite(Number(to))) continue;
      const file = path.resolve(folder, name);
      if (anchor === null) { try { anchor = made(file) - Number(from) * 1000; } catch { anchor = Date.now() - Number(to) * 1000; } }
      finished.push({ file, startedMs: Math.round(anchor + Number(from) * 1000), endedMs: Math.round(anchor + Number(to) * 1000), seconds: Number(to) - Number(from) });
    }
    hand();
  });
  child.stderr.on('data', chunk => { said = (said + chunk).slice(-4000); });
  child.on('error', error => { ended = { error }; hand(); });
  child.on('close', (code, signal) => { ended = ended ?? { code, signal }; hand(); });
  return {
    next: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); ended = { error: new Error(`the recorder wrote nothing for ${seconds + graceSeconds} seconds`) }; hand(); }, (seconds + graceSeconds) * 1000);
      waiting.push({ resolve, reject, timer });
      hand();
    }),
    stop() { stopped = true; if (!ended) child.kill('SIGINT'); },
  };
}

/**
 * Stops every process but this one recording into `folder` (invariant 1a): there is one listener per computer, so any
 * other is a recorder whose listener died and that still holds the microphone. Found by its command naming the folder;
 * answers the pids stopped. Fails open: when the process list cannot be read, nothing is stopped.
 */
export function leftRecorders(folder, { list = () => execFileSync('/bin/ps', ['-wwaxo', 'pid=,command='], { encoding: 'utf8' }), stop = pid => process.kill(pid, 'SIGKILL'), log = () => {} } = {}) {
  let rows;
  try { rows = list(); } catch { return []; }
  const mark = `${path.resolve(folder)}/`;
  const stopped = [];
  for (const line of String(rows).split('\n')) {
    const [, pid, command] = line.match(/^\s*(\d+)\s+(.*)$/) ?? [];
    if (!pid || Number(pid) === process.pid || !command.includes(mark)) continue;
    try { stop(Number(pid)); stopped.push(Number(pid)); log(`Listening: stopped a recorder left by an earlier listener (pid ${pid}).`); } catch {}
  }
  return stopped;
}

// An interrupted recorder may create a file before writing any sound. There are no bytes to hear or preserve;
// retaining it as a retry makes every launch ask the decoder and sound encoder to open that same empty file.
const hasSound = (file, log = () => {}) => {
  if (statSync(file).size !== 0) return true;
  rmSync(file);
  log('Listening: the recorder saved no sound in an empty piece; skipped it.');
  return false;
};

/** Saved pieces with bytes, oldest first. Empty interrupted captures are let go; every nonempty capture stays. */
export function savedPieces(pieces, log = () => {}) {
  return readdirSync(pieces).filter(name => /^\d+(\.again)?\.wav$/.test(name)).sort()
    .map(name => ({ file: path.join(pieces, name), startedMs: Number(name.split('.')[0]) }))
    .filter(piece => hasSound(piece.file, log));
}

/** Pieces a recorder that stopped by itself left half written in `folder` move into `pieces`, named by when their
 *  sound started, so they are heard with the pieces left from before. */
export function leftoverPieces(folder, pieces, made = file => statSync(file).birthtimeMs) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => /^\d+\.wav$/.test(name))
    .filter(name => hasSound(path.join(folder, name))).map(name => {
    const from = path.join(folder, name);
    const startedMs = Math.round(made(from));
    const file = path.join(pieces, `${startedMs}.wav`);
    renameSync(from, file);
    return { file, startedMs };
  }).sort((a, b) => a.startedMs - b.startedMs);
}

/**
 * Hears one recorded piece and names who said each stretch: [{ start_ms, end_ms, text, voice, who, score }].
 * `spoken` ({ language }) is the session's language: the language of the most recent piece whose words survived, handed
 * to the hearing so a quiet or noisy piece is heard in it instead of being guessed afresh (a silent piece guessed as
 * Korean is heard as Whisper's stock "see you in the next video", a voice nobody spoke). Left out, the language is detected.
 */
export async function stretchesOf(file, startedMs, { hearing, knowWho, session, spoken = null, preheard = null, afterHearing = () => {} }) {
  const heard = await (preheard ?? hearWith(hearing, file, { language: spoken?.language ?? '' }));
  afterHearing();
  const segments = (heard.segments ?? []).filter(segment => String(segment.text ?? '').trim());
  if (!segments.length) return [];
  if (spoken && heard.language) spoken.language = heard.language;
  const spans = `${file}.spans.json`;
  writeFileSync(spans, JSON.stringify(segments.map(({ start, end }) => ({ start, end }))));
  let named = [];
  try { named = knowWho ? await knowWho('voices', file, spans, session) : []; } finally { rmSync(spans, { force: true }); }
  return segments.map((segment, at) => ({
    start_ms: startedMs + Math.round(segment.start * 1000), end_ms: startedMs + Math.round(segment.end * 1000),
    text: segment.text.trim(), voice: named[at]?.voice ?? 'voice-1', who: named[at]?.who ?? null, unsure: named[at]?.unsure ?? [],
    score: Number.isFinite(named[at]?.score) ? named[at].score : null,
  }));
}

/** Keep saved pieces in order while hearing the following piece during speaker naming and sound cutting. */
export async function hearSavedPieces(pieces, { hear, process }) {
  let ahead = null;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    const heard = ahead ?? hear(piece);
    ahead = null;
    await process(piece, heard, () => {
      if (index + 1 >= pieces.length) return;
      ahead = hear(pieces[index + 1]);
      // The following piece can fail before its turn; its own ordered work handles that failure.
      ahead.catch(() => {});
    });
  }
}

/**
 * Whether an answer the account gave is worth sending again (listen.sending, DATA): no answer at all (the network), a
 * status listed or at least `retry_status_at_least` (a 5xx, a 429), or an error whose words say it was for a moment
 * (a store restarting answers 400 with words like "reset because its code was updated"). Anything else is permanent.
 */
export function retryable(answer, sending) {
  if (!answer) return true;
  if (answer.status >= sending.retry_status_at_least || sending.retry_statuses.includes(answer.status)) return true;
  const said = String(answer.body?.error ?? '').toLowerCase();
  return sending.retry_when_error_says.some(words => said.includes(words.toLowerCase()));
}

/**
 * The spoken windows in what the Mac app wrote (invariant 7): the list, or the one object an older app wrote, as a list,
 * oldest start first. Only one notice is spoken at a time, so a window ends where the next one starts: spoke_until and
 * answer_until are cut there. A notice whose playback never reported finishing (or one a newer notice replaced) is left
 * by the app with a provisional end ten minutes ahead; without this cut every turn heard in those minutes would be
 * taken for Trillion's own voice, the person's real words included.
 */
export function spokenWindows(written) {
  const rows = Array.isArray(written) ? written : written && typeof written === 'object' ? [written] : [];
  const windows = rows
    .filter(row => row?.notice_id && Number.isFinite(row.spoke_from) && Number.isFinite(row.spoke_until))
    .sort((a, b) => a.spoke_from - b.spoke_from);
  return windows.map((window, index) => {
    const next = windows[index + 1]?.spoke_from;
    if (!Number.isFinite(next)) return window;
    const cut = { ...window, spoke_until: Math.min(window.spoke_until, next) };
    if (Number.isFinite(window.answer_until)) cut.answer_until = Math.min(window.answer_until, next);
    return cut;
  });
}

/** The window of a notice Trillion was speaking while this turn was heard (give or take margin_seconds), else null. */
export function spokenWhile(turn, asked, answers) {
  const margin = (answers?.margin_seconds ?? 0) * 1000;
  const end = Number.isFinite(turn.end_ms) ? turn.end_ms : turn.start_ms;
  return spokenWindows(asked).find(window => turn.start_ms < window.spoke_until + margin && end > window.spoke_from - margin) ?? null;
}

/**
 * Whether a turn answers what Trillion just asked out loud (invariant 7): the notice id when it does, false when it is
 * Trillion's own voice (heard while it spoke in any window, give or take margin_seconds), null otherwise. `asked` is the
 * list of windows or the one object an older app wrote. The answer is to the newest question whose window it begins in.
 */
export function answerTo(turn, asked, answers) {
  if (spokenWhile(turn, asked, answers)) return false;
  // Someone named who is not the person is not answering for them.
  if (turn.who && turn.who.me !== true) return null;
  const window = spokenWindows(asked).filter(row => Number.isFinite(row.answer_until) && turn.start_ms >= row.spoke_until && turn.start_ms <= row.answer_until).at(-1);
  return window?.notice_id ?? null;
}

/**
 * How long to wait before trying one turn again after `tries` failures: the account's own Retry-After when it gave one,
 * otherwise doubling from `first_wait_seconds` up to `most_wait_seconds`, spread by `jitter` so many waiting turns (or
 * many Macs) do not all come back at the same second.
 */
export function waitBeforeAgain(tries, retryAfter, sending, random = Math.random) {
  const told = Number(retryAfter);
  const told_ms = Number.isFinite(told) && told >= 0 ? told * 1000 : (Date.parse(retryAfter ?? '') || 0) - Date.now();
  const base = told_ms > 0 ? told_ms : Math.min(sending.most_wait_seconds, sending.first_wait_seconds * 2 ** Math.max(0, tries - 1)) * 1000;
  return Math.round(base * (1 + sending.jitter * random()));
}

/**
 * Sends finished turns through the one door, after the rules: each kept turn is one item; a turn that says one of the
 * words that turn listening off turns it off. Kept turns wait in `waiting` (a file in the listener's state folder)
 * until the account takes them, oldest first, so turns heard while the account cannot be reached go once it can; the
 * door drops a repeat by its source_id, so sending one twice after a crash adds nothing. A turn the account refuses for
 * a moment (retryable) waits its own time before it is tried again (tries.json beside `waiting`, by source_id); after
 * `tries_before_next_goes_first` such failures the turns behind it go past it, so one stuck turn never holds the rest.
 * A turn the account refuses for good is moved aside to rejected.json with the reason, out of the queue, and the
 * person is told once (POST /tell/progress, ended as failed, keyed by the turn so it is told one time). Returns how
 * many were sent; throws the last moment's failure, after keeping the queue, so the listener logs it.
 */
export async function send(turns, { listen, account, log, status, waiting, classify = null, now = () => Date.now(), random = Math.random, onPersisted = () => {}, signal = null }) {
  const sending = listen.sending;
  const batchSize = Number.isInteger(sending.batch_size) && sending.batch_size > 0 ? Math.min(sending.batch_size, 100) : 100;
  const folder = path.dirname(waiting);
  const clockFile = path.join(folder, 'event-clock.json');
  const triesFile = path.join(folder, sending.tries_file);
  const rejectedFile = path.join(folder, sending.rejected_file);
  // What the person asked of the refused turns (listen tool, `rejected`) is done here, in the process that owns these files, before this pass reads its queue.
  if (requestFiles(folder, sending).length) await applyRequests({ folder, sending, account, now });
  const queue = readJson(waiting) ?? [];
  // The turns already waiting when this pass began: only these are held to the pass's pace (sending.pass); a turn heard during it always goes.
  const older = new Set(queue.map(item => item.source_id));
  const heldFile = path.join(folder, 'pass-sent.json');
  const heldSent = readJson(heldFile)?.sent ?? 0;
  // While the hold file is there ({ "most_turns": n }), only n of the waiting turns are ever sent; deleting it lifts the hold.
  const hold = sending.pass?.hold_file ? readJson(path.join(folder, sending.pass.hold_file)) : null;
  let allowance = hold ? Math.max(0, Number(hold.most_turns) - heldSent) : Number.isInteger(sending.pass?.turns_per_pass) ? sending.pass.turns_per_pass : Infinity;
  let sentOlder = 0;
  const ended = () => { if (signal?.aborted) throw new Error('this pass was ended after its deadline'); };
  let eventClockState = readJson(clockFile)?.clock ?? null;
  const queuedIds = new Set(queue.map(item => item.source_id));
  const tries = readJson(triesFile) ?? {};
  const asked = listen.answers ? spokenWindows(readJson(expand(listen.answers.file))) : [];
  // One question takes one answer (invariant 7): which question was last answered, and the answer being made now.
  const answeredFile = path.join(folder, 'answered.json');
  const questionOf = id => { const window = asked.findLast(row => row.notice_id === id); return window ? `${window.notice_id}@${window.spoke_until}` : null; };
  const answered = readJson(answeredFile)?.question ?? null;
  let question = null;
  let answer = null;
  for (const { turn, index, moment } of turns) {
    let answering = answerTo(turn, asked, listen.answers);
    if (answering === false) {
      // Trillion's own voice: kept as what it is, never dropped and never the person's (invariant 7).
      const sourceId = `${moment.id}#${index + 1}`;
      if (queuedIds.has(sourceId) || !String(turn.text ?? '').trim()) { if (!queuedIds.has(sourceId)) status.left_out += 1; continue; }
      eventClockState = tickHybridClock(eventClockState, now(), moment.computer);
      writeJson(clockFile, { clock: eventClockState });
      const own = arrivalOf(turn, index, moment, listen, eventClockState);
      Object.assign(own, { from_person: false, from: listen.answers.own_voice_as, spoke: { notice_id: spokenWhile(turn, asked, listen.answers).notice_id }, verdict: 'context' });
      queuedIds.add(own.source_id);
      queue.push(own);
      continue;
    }
    question = answering ? questionOf(answering) : null;
    if (answering && answer) { answer.text = `${answer.text} ${turn.text}`.trim(); continue; }
    if (answering && answered === question) answering = null;
    if (!answering && !decide(listen.rules, turn).keep) { status.left_out += 1; continue; }
    // Whether it asks for something is asked of the classifier on this computer, so the account opens work only for
    // requests, owned by whoever said them (src/attention.json); no answer sends no verdict.
    const sourceId = `${moment.id}#${index + 1}`;
    if (queuedIds.has(sourceId)) continue;
    eventClockState = tickHybridClock(eventClockState, now(), moment.computer);
    writeJson(clockFile, { clock: eventClockState });
    const item = arrivalOf(turn, index, moment, listen, eventClockState);
    // An answer is the notice's own work, so the classifier is not asked about it (invariant 7).
    if (answering) Object.assign(item, { answers: answering, verdict: 'context' });
    queuedIds.add(item.source_id);
    queue.push(item);
    if (answering) { answer = item; writeJson(answeredFile, { question }); }
  }
  // Keep new turns before slow classifier or account work, so old turns can go first.
  writeJson(waiting, queue);
  onPersisted();
  let count = 0;
  let failure = null;
  const left = [];
  let at = 0;
  // A turn the account will not take: moved aside with its reason and the person told once; it is never sent again.
  const refuse = async (item, answer, reason) => {
    delete tries[item.source_id];
    const rejected = readJson(rejectedFile) ?? [];
    writeJson(rejectedFile, [...rejected, { at: new Date(now()).toISOString(), reason, status: answer?.status ?? null, turn: item }].slice(-sending.rejected_most));
    status.rejected = (status.rejected ?? 0) + 1;
    status.last_rejected = { at: new Date(now()).toISOString(), source_id: item.source_id, reason };
    log(`Listening: ${reason} (moved aside, not sent again)`);
    const notice = sending.rejected_notice;
    await account('/tell/progress', { method: 'POST', body: {
      key: `${notice.key_prefix}${item.source_id}`, state: 'failed', title: notice.title,
      body: fill(notice.body, { reason, from: item.from ?? 'me', text: String(item.text ?? '').slice(0, notice.words_most) }),
    } }).catch(() => null);
  };
  try {
    // The turns of one moment go in bounded requests; the door answers each in order and the existing source IDs
    // keep the same conversation and retry identity across chunks.
    while (at < queue.length) {
      const moment = queue[at].conversation_id;
      let end = at;
      while (end < queue.length && end - at < batchSize && queue[end].conversation_id === moment) end += 1;
      const going = [];
      let stop = false;
      for (; at < end; at += 1) {
        const item = queue[at];
        const held = tries[item.source_id];
        // A turn still waiting out its time: the turns behind it wait too, unless it has failed often enough to let them pass.
        if (held && held.next_at > now()) {
          left.push(item);
          if (held.tries >= sending.tries_before_next_goes_first) continue;
          stop = true;
          break;
        }
        if (older.has(item.source_id)) {
          if (allowance <= 0) { left.push(item); continue; }
          allowance -= 1;
        }
        if (classify && !item.verdict) {
          const verdict = await classify?.(item.text).catch(() => null);
          ended();
          if (verdict) { delete item.classify_tries; item.verdict = verdict; }
          else {
            item.classify_tries = (item.classify_tries ?? 0) + 1;
            if (item.classify_tries < (sending.classify_tries ?? 0)) { left.push(item); continue; }
            delete item.classify_tries;
          }
        }
        going.push(item);
      }
      if (going.length) {
        let answer;
        try { answer = await account('/inbound', { method: 'POST', body: { items: going } }); ended(); }
        catch (error) { left.push(...going); throw error; }
        const answers = answer?.status === 200 && Array.isArray(answer.body?.items) ? answer.body.items : null;
        const bodyHasItems = answer?.body && Object.hasOwn(answer.body, 'items');
        // The only supported single-result shape is an explicit receipt for the one exact source
        // sent. A bare HTTP 200 (or an echoed receipt for another source) says nothing about what
        // the account kept, so it must remain retryable under the stable source_id.
        const singletonReceipt = going.length === 1 && answer?.status === 200 && !bodyHasItems
          && answer.body?.source_id === going[0].source_id
          && typeof answer.body?.message_id === 'string' && answer.body.message_id.length > 0
          && !Object.hasOwn(answer.body, 'error');
        // A whole-request retry means the door is unavailable to every turn, not that this one
        // turn is stuck. Keep later moments for another pass instead of sending the entire queue
        // into an overloaded account after earlier turns reached their skip-ahead threshold.
        const doorBackpressure = (!answers && !singletonReceipt && answer?.status === 200) || (!answers && retryable(answer, sending));
        for (const [index, item] of going.entries()) {
          // Each turn's own answer when the door took the moment (a turn it could not take says why, as a 400 would
          // for a turn sent alone), else the moment's answer.
          const receipt = answers?.[index];
          // A missing or malformed per-turn reply is not a refusal: the account may have kept the
          // turn before its response was cut off. Keep its source_id and retry idempotently.
          const hasMessageId = receipt && Object.hasOwn(receipt, 'message_id');
          const hasReceipt = typeof receipt?.message_id === 'string' && receipt.message_id.length > 0
            && !Object.hasOwn(receipt, 'error')
            && (!Object.hasOwn(receipt, 'source_id') || receipt.source_id === item.source_id);
          const hasRefusal = typeof receipt?.error === 'string' && receipt.error.length > 0 && !hasMessageId;
          const uncertain = { status: 503, retry_after: null, body: { error: 'the account did not confirm this turn' } };
          const reply = answers ? hasReceipt
            ? { status: 200, retry_after: null, body: receipt }
            : hasRefusal
              ? { status: 400, retry_after: null, body: receipt }
              : uncertain
            : singletonReceipt
              ? { status: 200, retry_after: null, body: answer.body }
              : answer?.status === 200
                ? uncertain
                : answer;
          if (reply?.status === 200) {
            delete tries[item.source_id];
            count += 1;
            if (older.has(item.source_id)) sentOlder += 1;
            status.sent += 1;
            status.last_sent = { at: new Date(now()).toISOString(), from: item.from ?? 'me', message_id: reply.body.message_id };
            continue;
          }
          const reason = reply ? `the account answered ${reply.status}: ${reply.body?.error ?? ''}` : 'the account could not be reached';
          // A whole moment refused as a request says nothing about this turn (a door not yet updated to take a moment
          // answers 400 for its shape): it waits and goes again, never moved aside for what no turn did.
          const judged = Boolean(answers) || reply?.status !== 400;
          if (judged && !retryable(reply, sending)) { await refuse(item, reply, reason); continue; }
          const tried = (tries[item.source_id]?.tries ?? 0) + 1;
          tries[item.source_id] = { tries: tried, next_at: now() + waitBeforeAgain(tried, reply?.retry_after, sending, random), reason };
          failure = reason;
          left.push(item);
          if (doorBackpressure || tried < sending.tries_before_next_goes_first) stop = true;
        }
      }
      if (stop) { left.push(...queue.slice(at === end ? end : at + 1)); at = queue.length; break; }
    }
  } catch (error) {
    // Whatever was not yet sent stays waiting, in order.
    left.push(...queue.slice(at));
    throw error;
  } finally {
    // A pass ended after its deadline writes nothing: the pass that took over owns these files.
    if (signal?.aborted) return count;
    if (hold && sentOlder) writeJson(heldFile, { sent: heldSent + sentOlder });
    const waitingIds = new Set(left.map(item => item.source_id));
    for (const id of Object.keys(tries)) if (!waitingIds.has(id)) delete tries[id];
    status.waiting = left.length;
    writeJson(waiting, left);
    writeJson(triesFile, tries);
  }
  if (failure) throw new Error(failure);
  return count;
}

// ---- Turns the account refused: listed, sent again, or let go ----------------------------------------------------------
// The sender owns waiting.json, tries.json and rejected.json, so a request to change them is a file in `requests` (the
// listen tool writes it) and the sender does it at the start of its next pass: one writer, nothing lost to a pass in
// progress (its request waits for the next), and a request done twice changes nothing (a turn moved is no longer in
// rejected.json, and one already waiting is not queued again).

/** The account's own words in a kept turn's reason ("the account answered 409: Resource quota: x"). */
const refusedWords = row => String(row.reason ?? '').replace(/^the account answered \d+: /, '');

/** Whether the account would refuse this kept turn for a moment only, by the sending rules in force now. */
export const refusedForAMoment = (row, sending) =>
  retryable(Number.isInteger(row.status) ? { status: row.status, body: { error: refusedWords(row) } } : null, sending);

/**
 * The kept turns a choice names. `source_ids` name them outright, permanent or not. Otherwise the filter does (`reason`
 * words, `status`, `since`, `until`), and a resend then takes only the turns the account refused for a moment, unless
 * `include_permanent` says otherwise. Turns the person let go are never chosen again.
 */
export function chosenRejected(rows, choice, sending, { resend = false, withDiscarded = false } = {}) {
  const ids = Array.isArray(choice?.source_ids) ? new Set(choice.source_ids.map(String)) : null;
  const words = choice?.reason ? String(choice.reason).toLowerCase() : null;
  const since = choice?.since ? Date.parse(choice.since) : null;
  const until = choice?.until ? Date.parse(choice.until) : null;
  return rows.filter(row => (withDiscarded || !row.discarded_at)
    && (!ids || ids.has(String(row.turn?.source_id)))
    && (!words || String(row.reason ?? '').toLowerCase().includes(words))
    && (choice?.status === undefined || choice.status === null || row.status === choice.status)
    && (since === null || Date.parse(row.at) >= since) && (until === null || Date.parse(row.at) <= until)
    && (!resend || ids || choice?.include_permanent === true || refusedForAMoment(row, sending)));
}

const requestFiles = (folder, sending) => {
  const place = path.join(folder, sending.requests_folder);
  try { return readdirSync(place).filter(name => name.endsWith('.json') && !name.endsWith('.done.json')).sort().map(name => path.join(place, name)); } catch { return []; }
};

/** Does the sender have a request waiting in `folder` (the listener's state folder)? */
export const hasRequests = (folder, sending) => requestFiles(folder, sending).length > 0;

/** Does what the person asked of the refused turns, in the order it was asked; each request leaves its result beside it. */
export async function applyRequests({ folder, sending, account, now = () => Date.now() }) {
  const place = path.join(folder, sending.requests_folder);
  // Results the tool has not collected for a while go.
  try { for (const name of readdirSync(place)) if (name.endsWith('.done.json') && now() - statSync(path.join(place, name)).mtimeMs > sending.done_kept_seconds * 1000) rmSync(path.join(place, name), { force: true }); } catch { /* none yet */ }
  const waiting = path.join(folder, 'waiting.json'), triesFile = path.join(folder, sending.tries_file), rejectedFile = path.join(folder, sending.rejected_file);
  for (const file of requestFiles(folder, sending)) {
    const request = readJson(file);
    if (!request || !['resend', 'discard'].includes(request.action)) { rmSync(file, { force: true }); continue; }
    const rows = readJson(rejectedFile) ?? [];
    const chosen = chosenRejected(rows, request.choice, sending, { resend: request.action === 'resend' });
    const ids = new Set(chosen.map(row => row.turn.source_id));
    let result;
    if (request.action === 'resend') {
      const queue = readJson(waiting) ?? [];
      const queued = new Set(queue.map(item => item.source_id));
      const again = chosen.map(row => ({ ...row.turn })).filter(turn => !queued.has(turn.source_id));
      for (const turn of again) delete turn.classify_tries;
      // The queue first, then the file the turns leave: a stop between them repeats this and finds the turns waiting.
      writeJson(waiting, [...again, ...queue]);
      const tries = readJson(triesFile) ?? {};
      if ([...ids].some(id => id in tries)) { for (const id of ids) delete tries[id]; writeJson(triesFile, tries); }
      writeJson(rejectedFile, rows.filter(row => !ids.has(row.turn?.source_id)));
      result = { action: 'resend', moved: again.map(turn => turn.source_id), already_waiting: [...ids].filter(id => queued.has(id)) };
    } else {
      const at = new Date(now()).toISOString();
      writeJson(rejectedFile, rows.map(row => (ids.has(row.turn?.source_id) ? { ...row, discarded_at: at } : row)));
      result = { action: 'discard', discarded: [...ids] };
    }
    writeJson(file.replace(/\.json$/, '.done.json'), { at: new Date(now()).toISOString(), result });
    rmSync(file, { force: true });
    const notice = request.action === 'resend' ? sending.resent_notice : sending.discarded_notice;
    for (const row of chosen) {
      await account('/tell/progress', { method: 'POST', body: {
        key: `${sending.rejected_notice.key_prefix}${row.turn.source_id}`, state: 'done', title: notice.title,
        body: fill(notice.body, { from: row.turn.from ?? 'me', text: String(row.turn.text ?? '').slice(0, sending.rejected_notice.words_most) }),
      } }).catch(() => null);
    }
  }
}

const summaryOf = (row, sending) => ({ source_id: row.turn?.source_id, at: row.at, from: row.turn?.from ?? 'me', text: row.turn?.text ?? '', reason: row.reason, status: row.status ?? null,
  for_a_moment: refusedForAMoment(row, sending), ...(row.discarded_at ? { discarded_at: row.discarded_at } : {}) });

/**
 * The listen tool's `rejected` input: { action: list | resend | discard, source_ids?, reason?, status?, since?, until?,
 * include_permanent?, all?, include_discarded?, wait_ms? }. `list` reads rejected.json. `resend` and `discard` write a request
 * for the sender and wait a moment for its result (the listener must be running; otherwise the request waits for it).
 */
export async function rejectedTurnsTool(listen, input, { now = () => Date.now(), sleep = ms => new Promise(done => setTimeout(done, ms)), listening = false } = {}) {
  const sending = listen.sending, words = sending.words;
  const folder = expand(listen.state);
  const action = input?.action;
  if (!['list', 'resend', 'discard'].includes(action)) throw Object.assign(new Error('Say list, resend or discard.'), { status: 400 });
  for (const field of ['since', 'until']) if (input[field] !== undefined && !Number.isFinite(Date.parse(input[field]))) throw Object.assign(new Error(`${field} is a time like 2026-10-20T03:00:00-07:00.`), { status: 400 });
  const rows = readJson(path.join(folder, sending.rejected_file)) ?? [];
  const choice = { source_ids: input.source_ids, reason: input.reason, status: input.status, since: input.since, until: input.until, include_permanent: input.include_permanent === true };
  if (action === 'list') {
    const shown = chosenRejected(rows, choice, sending, { withDiscarded: input.include_discarded === true })
      .slice(-Math.min(sending.list_most, Number.isInteger(input.most) && input.most > 0 ? input.most : sending.list_most));
    return { action, count: shown.length, turns: shown.map(row => summaryOf(row, sending)), said: shown.length ? fill(words.listed, { count: shown.length }) : words.nothing };
  }
  const named = Array.isArray(input.source_ids) || input.reason !== undefined || input.status !== undefined || input.since !== undefined || input.until !== undefined;
  if (action === 'discard' && !named && input.all !== true) throw Object.assign(new Error(words.needs_choice), { status: 400 });
  const chosen = chosenRejected(rows, choice, sending, { resend: action === 'resend' });
  if (!chosen.length) return { action, requested: 0, turns: [], said: words.nothing };
  const id = `${now()}-${randomUUID().slice(0, 8)}`;
  const place = path.join(folder, sending.requests_folder);
  writeJson(path.join(place, `${id}.json`), { action, choice, asked_at: new Date(now()).toISOString() });
  const done = path.join(place, `${id}.done.json`);
  const limit = now() + (Number.isFinite(input.wait_ms) ? input.wait_ms : sending.request_wait_ms);
  let applied = null;
  while (now() < limit && !(applied = readJson(done))) await sleep(250);
  if (applied) rmSync(done, { force: true });
  return { action, requested: chosen.length, turns: chosen.map(row => summaryOf(row, sending)), applied: applied?.result ?? null, listening,
    said: `${fill(action === 'resend' ? words.resend_requested : words.discard_requested, { count: chosen.length })}${listening ? '' : ` ${words.listener_off}`}` };
}

/** Keep heard turns before trying the account; one sender drains them while hearing continues. */
export function turnOutbox({ file, waiting, deliver, report = () => {}, settled = () => {}, log = () => {}, retryMs = 30_000, deadlineMs = null, watch = null }) {
  let running = null;
  let timer = null;
  let addedWhileRunning = false;
  let closed = false;
  const idOf = row => `${row.moment.id}#${row.index + 1}`;
  const pending = () => (readJson(file) ?? []).length + (readJson(waiting) ?? []).length;
  const drain = () => {
    if (closed) return Promise.resolve();
    if (running) { addedWhileRunning = true; return running; }
    if (timer) { clearTimeout(timer); timer = null; }
    // One pass at a time. A pass still running after deadlineMs is ended and recorded, and the next one starts: what it
    // was waiting on cannot hold every queued turn (6,323 waited with nothing sent, 2026-10-22).
    const controller = new AbortController();
    let deadline = null;
    const pass = (async () => {
      const batch = readJson(file) ?? [];
      try {
        await deliver(batch, () => {
          const persisted = new Set(batch.map(idOf));
          writeJson(file, (readJson(file) ?? []).filter(row => !persisted.has(idOf(row))));
        }, controller.signal);
        if (!controller.signal.aborted) settled(null);
      } catch (error) { if (!controller.signal.aborted) { const reason = String(error.message ?? error); settled(reason); log(reason); } }
    })();
    const late = deadlineMs ? new Promise(done => { deadline = setTimeout(() => done('late'), deadlineMs); }) : new Promise(() => {});
    running = Promise.race([pass, late]).then(outcome => {
      if (outcome === 'late') {
        controller.abort();
        const reason = `the sender's pass did not finish in ${Math.round(deadlineMs / 1000)} seconds and was ended`;
        settled(reason); log(reason);
      }
      report(pending());
    }).finally(() => {
      clearTimeout(deadline);
      running = null;
      if (closed) return;
      if (addedWhileRunning) { addedWhileRunning = false; queueMicrotask(drain); }
      else if (pending()) timer = setTimeout(() => { timer = null; drain(); }, retryMs);
    });
    return running;
  };
  // A request the person made of the refused turns is done by the next pass; with nothing else waiting, this starts one.
  const watcher = watch ? setInterval(() => { if (!closed && !running && hasRequests(watch.folder, watch.sending)) drain(); }, watch.seconds * 1000) : null;
  watcher?.unref?.();
  return {
    add(turns) {
      if (closed) throw new Error('the turn sender has stopped');
      if (turns.length) {
        const held = readJson(file) ?? [];
        const seen = new Set(held.map(idOf));
        for (const row of turns) if (!seen.has(idOf(row))) { held.push(row); seen.add(idOf(row)); }
        writeJson(file, held);
        report(pending());
      }
      return drain();
    },
    drain,
    close() { closed = true; if (timer) clearTimeout(timer); timer = null; if (watcher) clearInterval(watcher); },
  };
}

/** A spoken stop takes effect on this Mac when heard, even if an older account send is still busy. */
export function keepHeardTurns(turns, { listen, outbox, log = () => {} }) {
  if (turns.some(({ turn }) => turn.who?.me && turnsOff(listen.pause_when_said, turn.text)) && isOn(listen)) {
    const said = turns.find(({ turn }) => turn.who?.me && turnsOff(listen.pause_when_said, turn.text)).turn;
    setOn(listen, false, 'said out loud', new Date(Math.min(said.end_ms, Date.now())));
    log('Listening: turned off by what was said.');
  }
  return outbox.add(turns);
}

/**
 * text -> 'act' | 'context' | null: the account's own classifier question (GET /attention classify, read once and again
 * after a failure) asked of the classifier on this computer (local-models.json classify rows); null when neither answers.
 */
export function classifierOf(account, ask = input => askLocal(input, localModelSettings()), { wait_ms = null } = {}) {
  let question = null;
  // A question or a model that has not answered in wait_ms is no answer (null): the sender goes on with the next turn. One that never
  // answered held the whole queue, with 6,323 turns waiting and nothing sent for hours (2026-10-22).
  const within = promise => (wait_ms ? new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), wait_ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  }) : promise);
  return async text => {
    question ??= within(account('/attention').then(answer => (answer?.status === 200 ? answer.body.classify ?? null : null))).catch(() => null);
    const asked = await question;
    if (!asked) { question = null; return null; }
    const reply = await within(ask({ state: asked.state.replace('{text}', text), questions: { verdict: { type: 'noul', instructions: asked.question, criteria: asked.means } } }));
    const probability = Number(reply?.answers?.verdict?.noul);
    return Number.isFinite(probability) ? (probability >= asked.act_at ? 'act' : 'context') : null;
  };
}

const accountCaller = (origin, key) => async (route, { method = 'GET', body = null } = {}) => {
  try {
    const answer = await fetch(`${origin.replace(/\/$/, '')}/mcp/api${route}`, { method, headers: { authorization: `Bearer ${key}`, ...(body === null ? {} : { 'content-type': 'application/json' }) }, body: body === null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    return { status: answer.status, retry_after: answer.headers.get('retry-after'), body: await answer.json().catch(() => ({})) };
  } catch { return null; }
};

const SESSION = /^session-(\d+)\.json$/;
const sessionsIn = state => (existsSync(state) ? readdirSync(state) : []).filter(name => SESSION.test(name))
  .map(name => ({ file: path.join(state, name), started: Number(SESSION.exec(name)[1]) })).sort((a, b) => a.started - b.started);

/**
 * The session file a listener keeps its unknown voices in. A listener started again soon after the last one stopped
 * (an app update, the Mac waking) goes on with that session, so "Someone (voice-2)" is still voice-2 after the
 * restart; `moments.same_session_within_seconds` (DATA) is how soon. A recording given by file is a session of its own.
 */
export function sessionFile(state, settings, now) {
  const within = (settings.moments?.same_session_within_seconds ?? 0) * 1000;
  const last = now === null ? null : sessionsIn(state).at(-1);
  if (last && within > 0 && now - statSync(last.file).mtimeMs <= within) return last.file;
  return path.join(state, `session-${now ?? Date.now()}.json`);
}

/** The session a turn heard at `at` belongs to: the last one started at or before it. */
export const sessionAt = (state, at) => sessionsIn(state).filter(session => session.started <= Date.parse(at)).at(-1) ?? null;

/** The folder a device's listening keeps its own session, queue and status in: one per device, so voices keep their
 *  numbers across that device's pieces and its queue never races this Mac's own microphone. */
export const deviceState = (state, device) => path.join(state, 'devices', String(device).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'device');

// ---- The sound, kept ---------------------------------------------------------------------------------------------

/** The local day and time of `ms`, as names a person reads: { date: '2026-10-05', time: '14-03-22' }. */
const localNames = ms => {
  const at = new Date(ms);
  const two = value => String(value).padStart(2, '0');
  return { date: `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`, time: `${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}` };
};

/**
 * Where a moment of real time falls in the sound of pieces laid end to end: each piece holds `seconds` of sound from
 * its start_ms (end_ms - start_ms when it does not say), and the moments between pieces (a recorder starting again)
 * hold none, so a time in such a gap falls on the next piece's first sound. Returns seconds from the first piece.
 */
export function soundTime(pieces, ms) {
  let before = 0;
  for (const piece of pieces) {
    const length = Number.isFinite(piece.seconds) ? piece.seconds * 1000 : piece.end_ms - piece.start_ms;
    if (ms < piece.start_ms + length) return (before + Math.max(0, ms - piece.start_ms)) / 1000;
    before += length;
  }
  return before / 1000;
}

const lengthOf = piece => (Number.isFinite(piece.seconds) ? piece.seconds * 1000 : piece.end_ms - piece.start_ms);

/**
 * What one moment's sound file is kept with: its name in the person's Trillion and its words, each line with its place
 * in the file (seconds from the file's start), who said it and the message it arrived as, so any line can be cut out
 * of the file as a clip (search answers a line's start and end). `lines` are [{ start_ms, end_ms, text, speaker,
 * source_id }]; `place(ms)` is where a moment falls in the file, in seconds.
 */
export function keptSound({ keep, device, conversationId, fromMs, toMs, lines, place }) {
  const { date, time } = localNames(fromMs);
  const seconds = ms => Math.max(0, Math.round(place(ms) * 100) / 100);
  return {
    name: `${keep.folder}/${date}/${fill(keep.name, { time, device, date })}`,
    transcript: {
      text: lines.map(line => line.text).join(' '),
      segments: lines.map(line => ({ start: seconds(line.start_ms), end: seconds(Math.min(line.end_ms, toMs)), text: line.text, speaker: line.speaker, source_id: line.source_id })),
      heard_whole: true,
      moment: { conversation_id: conversationId, device, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    },
  };
}

/** Cuts `seconds` of sound from `from` seconds into pieces laid end to end (soundTime) into one compressed file with
 *  the encoder found on this computer (keep_sound.encode, DATA); seconds Infinity runs to the end. */
export async function cutSound(encoder, pieces, from, seconds, file) {
  const list = `${file}.pieces.txt`;
  writeFileSync(list, pieces.map(piece => `file '${piece.file.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    await new Promise((resolve, reject) => {
      const [first, ...args] = encoder.run.map(part => fill(part, { list, from: Math.max(0, from).toFixed(2), seconds: (Number.isFinite(seconds) ? seconds : 86_400).toFixed(2), file }));
      const program = encoder.program && first === encoder.check[0] ? encoder.program : first;
      execFile(program, args, { env: encoder.env, timeout: 600_000 }, (error, _out, stderr) => (error ? reject(new Error(String(stderr).trim().split('\n').pop() || error.message)) : resolve()));
    });
  } finally { rmSync(list, { force: true }); }
  return file;
}

/**
 * Keeps the sound of every moment heard (keep_sound, DATA): when a moment ends, its stretch of the pieces is cut into
 * one compressed file under keep_sound.folder/<day>/, kept in the person's Trillion with the tool's own app (so the
 * voice-memo rule never takes it for a recording the person made), with its words and their places (keptSound). A cut
 * waits in `<state>/sound` until it is kept, so being offline loses no sound; a piece is let go only once no moment can
 * still need it. Pieces are { file, start_ms, end_ms, seconds?, own }. `send({ file, name, transcript })` keeps one cut
 * and resolves once it is kept. `notes(lines)` (meeting-notes.mjs) answers the notes result to keep with a moment, or null.
 */
export function soundKeeper({ keep, route, join, state, device, encoder, words, send, sendMany = null, notes = null, log = () => {} }) {
  const folder = path.join(state, 'sound');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const held = [];
  const margin = (keep.margin_seconds ?? 0) * 1000;
  const waiting = () => readdirSync(folder).filter(name => name.endsWith('.json')).sort();
  let draining = null;
  return {
    /** A piece heard; `own` says the listener made it and may let it go. */
    add(piece) { held.push(piece); },
    /** A piece that could not be heard: its sound is kept anyway, with no words. */
    async unheard(file, startMs) {
      const { date, time } = localNames(startMs);
      const cut = path.join(folder, `${path.basename(file).replace(/\..*$/, '')}.${keep.extension}`);
      await cutSound(encoder, [{ file }], 0, Number.POSITIVE_INFINITY, cut);
      writeJson(`${cut}.json`, { file: cut, name: `${keep.folder}/${date}/${fill(keep.name, { time, device, date })}`, transcript: null, at: new Date(startMs).toISOString() });
    },
    /** Cuts each ended moment before letting go of pieces; uploads cannot hold up hearing. */
    async moments(ended, openStartMs) {
      for (const moment of ended) {
        const lines = turnsOf(moment.stretches, join).map((turn, index) => ({ ...turn, speaker: speakerOf(turn, words), source_id: `${moment.id}#${index + 1}` }));
        if (!lines.length) continue;
        const pieces = held.filter(piece => piece.start_ms + lengthOf(piece) > lines[0].start_ms - margin && piece.start_ms < lines.at(-1).end_ms + margin);
        if (!pieces.length) continue;
        const fromMs = Math.max(lines[0].start_ms - margin, pieces[0].start_ms);
        const toMs = Math.min(lines.at(-1).end_ms + margin, pieces.at(-1).start_ms + lengthOf(pieces.at(-1)));
        const from = soundTime(pieces, fromMs);
        const kept = keptSound({ keep, device, conversationId: `${route}:${moment.computer}:${moment.id}`, fromMs, toMs, lines, place: ms => soundTime(pieces, ms) - from });
        const file = path.join(folder, `${moment.id}.${keep.extension}`);
        try {
          await cutSound(encoder, pieces, from, soundTime(pieces, toMs) - from, file);
          // Meeting notes (listen.notes, DATA) ride with the words as one more result; no notes never holds the sound back.
          const made = notes ? await notes(lines).catch(error => { log(`Listening: no notes for ${moment.id}: ${error.message}`); return null; }) : null;
          writeJson(`${file}.json`, { file, ...kept, ...(made ? { notes: made } : {}) });
        } catch (error) { log(`Listening: the sound of ${moment.id} could not be cut: ${error.message}`); }
      }
      const needed = openStartMs === null ? Number.POSITIVE_INFINITY : openStartMs - margin;
      while (held.length && held[0].start_ms + lengthOf(held[0]) <= needed) { const piece = held.shift(); if (piece.own) rmSync(piece.file, { force: true }); }
      return waiting().length;
    },
    /** One uploader drains persisted cuts; a failed cut stays for the next attempt. */
    drain(onProgress = () => {}) {
      if (draining) return draining;
      draining = (async () => {
        for (;;) {
          if (sendMany) {
            const cuts = waiting().slice(0, 16).map(name => ({ name, cut: readJson(path.join(folder, name)) }));
            if (!cuts.length) break;
            const ready = cuts.filter(({ name, cut }) => {
              if (cut && existsSync(cut.file)) return true;
              rmSync(path.join(folder, name), { force: true });
              return false;
            });
            if (!ready.length) { onProgress(waiting().length); continue; }
            try {
              const answers = await sendMany(ready.map(({ cut }) => cut));
              if (!Array.isArray(answers) || answers.length !== ready.length) throw new Error('The sound sender did not answer every cut.');
              for (let index = 0; index < ready.length; index += 1) {
                if (!answers[index]?.kept) continue;
                rmSync(ready[index].cut.file, { force: true });
                rmSync(path.join(folder, ready[index].name), { force: true });
              }
              onProgress(waiting().length);
              const refused = answers.find(answer => !answer?.kept);
              if (refused) { log(`Listening: sound waits: ${refused.reason ?? 'the service refused its words'}`); break; }
            } catch (error) { log(`Listening: sound waits: ${error.message}`); break; }
            continue;
          }
          const name = waiting()[0];
          if (!name) break;
          const cut = readJson(path.join(folder, name));
          if (!cut || !existsSync(cut.file)) { rmSync(path.join(folder, name), { force: true }); onProgress(waiting().length); continue; }
          try { await send(cut); rmSync(cut.file, { force: true }); rmSync(path.join(folder, name), { force: true }); onProgress(waiting().length); }
          catch (error) { log(`Listening: the sound of ${path.basename(cut.file)} waits: ${error.message}`); break; }
        }
        return waiting().length;
      })().finally(() => { draining = null; });
      return draining;
    },
  };
}

/**
 * Sends cut sounds in two steps that each survive a failure of the next: the file is uploaded (its identity is saved on the cut at once,
 * `save(cut)`), then its words and notes are kept against that identity (`keepResults`). A cut that already has its identity (the upload
 * went through and the words did not) is not uploaded again. Returns the per-cut answers of `keepResults`.
 */
export async function sendCuts(cuts, { upload, keepResults, save }) {
  if (!cuts.length) return [];
  const fresh = cuts.filter(cut => typeof cut.identity !== 'string');
  if (fresh.length) {
    const identities = await upload(fresh);
    fresh.forEach((cut, index) => { cut.identity = identities[index]; save(cut); });
  }
  return keepResults(cuts);
}

/** Sends one cut sound into the person's Trillion and keeps its words on it: { file, name, transcript } -> identity. */
export function soundSender({ origin, key, keep }) {
  const control = bearerControl({ origin, authorization: async () => `Bearer ${key}` });
  const client = namespaceClient({ origin, control });
  let chunking = null;
  const upload = async cuts => {
    chunking ??= await loadChunking();
    const sources = [];
    let answers;
    try {
      for (const cut of cuts) sources.push(await fileSource(cut.file));
      answers = await sendWholeFiles({ client, chunking, files: cuts.map((cut, index) => ({
        source: sources[index], name: cut.name, mediaType: keep.media_type,
        modifiedAtMs: Date.parse(cut.transcript?.moment.to ?? cut.at), app: keep.app,
      })) });
    } finally { await Promise.allSettled(sources.map(source => source.close())); }
    if (!Array.isArray(answers) || answers.length !== cuts.length || answers.some(answer => typeof answer?.identity !== 'string')) {
      throw new Error('The sound sender did not confirm every file.');
    }
    return answers.map(answer => answer.identity);
  };
  const keepResults = async cuts => {
    // A cut's results: its words, then its meeting notes when it has them; each is confirmed one by one.
    const withWords = cuts.flatMap((cut, index) => [
      ...(cut.transcript ? [{ cut, index, kind: 'transcript', value: cut.transcript, produced_by: keep.produced_by }] : []),
      ...(cut.notes ? [{ cut, index, kind: cut.notes.kind, value: cut.notes.value, produced_by: cut.notes.produced_by }] : []),
    ]);
    if (!withWords.length) return cuts.map(cut => ({ kept: true, identity: cut.identity }));
    const { status, body } = await control('/namespace/results', { method: 'POST', body: { results: withWords.map(({ cut, kind, value, produced_by }) => ({
      identity: cut.identity, kind, value, produced_by,
    })) } });
    if (status !== 200) throw new Error(`the transcripts could not be kept (${status}): ${body?.error ?? ''}`);
    if (!Number.isInteger(body?.recorded) || !Number.isInteger(body?.unchanged) || !Array.isArray(body?.refused) ||
      body.recorded + body.unchanged + body.refused.length !== withWords.length ||
      body.refused.some(item => !Number.isInteger(item?.index) || item.index < 0 || item.index >= withWords.length || typeof item.reason !== 'string') ||
      new Set(body.refused.map(item => item.index)).size !== body.refused.length) {
      throw new Error('The transcript sender did not confirm every result.');
    }
    const refused = new Map((body?.refused ?? []).map(item => [withWords[item.index]?.index, item.reason]));
    return cuts.map((cut, index) => ({ identity: cut.identity, kept: !refused.has(index), reason: refused.get(index) }));
  };
  const many = cuts => sendCuts(cuts, { upload, keepResults, save: cut => writeJson(`${cut.file}.json`, cut) });
  const one = async cut => {
    const answer = (await many([cut]))[0];
    if (!answer.kept) throw new Error(`the transcript could not be kept: ${answer.reason}`);
    return answer.identity;
  };
  one.many = many;
  return one;
}

/** The day folders past keep_sound.keep_days (null keeps every day): their names, given the folders under keep.folder. */
export const daysPast = (keep, folders, now = Date.now()) => {
  if (!Number.isFinite(keep.keep_days)) return [];
  const last = localNames(now - keep.keep_days * 86_400_000).date;
  return folders.map(entry => (typeof entry === 'string' ? entry : entry?.name ?? '')).map(name => name.replace(/\/$/, '').split('/').pop())
    .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name) && name < last).map(name => `${keep.folder}/${name}`);
};

/**
 * Listens until the switch says off (or, with `file`, hears that one recording). The microphone is recorded piece
 * after piece with no gap between them while the pieces before are heard; each piece is heard, named and sent in turn.
 * With `device`, `file` is a piece another device recorded (a phone, a watch, a browser): it is heard here with the
 * same hearing, the same enrolled voices and the same classifier, in that device's own session (deviceState).
 */
export async function listen({ row, key, origin, file = null, fileAt = null, device = null, log = line => process.stderr.write(`${line}\n`) }) {
  const { listen: settings } = row;
  const state = device ? deviceState(expand(settings.state), device) : expand(settings.state);
  const pieces = path.join(state, 'pieces');
  mkdirSync(pieces, { recursive: true, mode: 0o700 });
  const rows = JSON.parse(readFileSync(path.join(HERE, 'computer-sources.json'), 'utf8'));
  const hearing = hearingHere(rows.hearing ?? []);
  if (!hearing) throw new Error([settings.words.no_hearing, ...hearingReasons(rows.hearing ?? [])].join(' '));
  // Naming is looked for again at each piece until it is found, so words still arrive (unnamed) while it is missing
  // and get names from the piece after it appears; status.naming says which.
  let knowWho = null;
  const naming = () => {
    if (!knowWho) { const found = knowWhoHere(settings); if (found) knowWho = knowWhoCaller(found, settings); else if (status.naming !== false) log(settings.words.no_know_who); }
    status.naming = Boolean(knowWho);
    return knowWho;
  };
  const computer = device ?? readJson(path.join(os.homedir(), '.trillion', 'computer-sources', 'computer.json'))?.id ?? os.hostname();
  mkdirSync(state, { recursive: true, mode: 0o700 });
  // A device's pieces go on in one session while they keep coming (same_session_within_seconds), like this Mac's own.
  const session = sessionFile(state, settings, file && !device ? null : Date.now());
  // The language this session's words are in, carried from piece to piece (stretchesOf); a file heard alone detects its own.
  const spoken = { language: null };
  const account = accountCaller(origin, key);
  // The model rows are the ones the Marketplace publishes now, read through this account (computer/local-models.mjs).
  const askModel = askHere({ origin, key });
  const classify = classifierOf(account, input => askModel(input), { wait_ms: settings.sending.classify_wait_ms });
  const status = { listening: true, since: new Date().toISOString(), naming: null, pieces: 0, sent: 0, left_out: 0, waiting: 0, sound_waiting: 0, last_sent: null, error: null, notes: jobState('waiting') };
  // The heartbeat is what makes a listening that died read as finished (livenessOf).
  // Which program hears and its one-time preparation (keep-drive-files.mjs hearingState), started here when it is due.
  const report = () => { status.heartbeat_ms = Date.now(); status.hearing = hearingState(hearing); writeJson(path.join(state, 'status.json'), status); };
  const waiting = path.join(state, 'waiting.json');
  const said = moments(settings, computer);
  const outbox = turnOutbox({ file: path.join(state, 'turns-to-send.json'), waiting,
    deliver: (turns, onPersisted, signal) => send(turns, { listen: settings, account, log, status, waiting, classify, onPersisted, signal }),
    retryMs: settings.sending.pass.gap_seconds * 1000,
    deadlineMs: settings.sending.pass.deadline_seconds * 1000,
    report: count => { status.waiting = count; report(); },
    settled: error => { status.send_error = error; report(); },
    log: error => log(`Listening: ${error}`),
    watch: { folder: state, sending: settings.sending, seconds: settings.sending.requests_poll_seconds },
  });
  outbox.drain();
  // Every moment's sound is kept, cut from the pieces into one compressed file with its words (keep_sound, DATA);
  // with keep_sound off a heard piece is simply let go.
  // Private mode is opt-in (row.listen.private_mode.on, src/private-mode.mjs): what it takes away is off here, in the owner.
  const keep = settings.keep_sound?.on && available(privateModeIn(settings), 'sound') ? settings.keep_sound : null;
  const encoder = keep ? hearingHere([{ ...keep.encode, id: 'encode' }]) : null;
  if (keep && !encoder) throw new Error(settings.words.no_encoder);
  const sendSound = keep ? soundSender({ origin, key, keep }) : null;
  const notes = settings.notes?.on === false || !settings.notes || !available(privateModeIn(settings), 'notes') ? null : notesMaker({
    settings, status, report, log, // The notes job is the one the Marketplace publishes now: the rows are read afresh through this account first, when due.
    ask: async input => { await refreshModelRecords({ origin, key }); return askLocal(input, localModelSettings(), { priority: -1 }); }, call: toolCaller(origin, key),
  });
  const sound = keep ? soundKeeper({ keep, route: settings.route, join: settings.turns.join_within_seconds, state, device: computer.replace(/\.local$/, ''), encoder, words: settings.words, send: sendSound, sendMany: sendSound.many, notes, log }) : null;
  let drainingSound = null;
  const drainSound = () => {
    if (!sound || drainingSound) return drainingSound;
    drainingSound = sound.drain(count => { status.sound_waiting = count; report(); })
      .then(count => { status.sound_waiting = count; report(); })
      .catch(error => { log(`Listening: sound waits: ${error.message}`); })
      .finally(() => { drainingSound = null; });
    return drainingSound;
  };
  const keepSound = async () => { if (sound) { status.sound_waiting = await sound.moments(said.ended(), said.openStart()); drainSound(); } };
  // A heard piece goes to the sound keeper (or is let go); one that could not be heard stays in `pieces` and is
  // heard when listening next starts, once, as `<start>.again.wav`, so a crash or a failed hearing loses no sound
  // and a piece that cannot be heard at all does not come back forever.
  const work = async (piece, startedMs, endedMs, { preheard = null, afterHearing = () => {}, seconds = settings.capture.piece_seconds } = {}) => {
    if (!file && !hasSound(piece, log)) { report(); return; }
    // The workspace's own opt-in recording rules, asked again here in the capture owner (src/recording-rules.mjs; no rules: allowed).
    if (!file) {
      const verdict = evaluate(rulesIn(settings), factsIn(settings, computer));
      if (verdict.state === 'blocked') { status.blocked = verdict.why; rmSync(piece, { force: true }); report(); return; }
      if (status.blocked) { status.blocked = null; }
    }
    // Recorded after the person paused listening: let go unheard (invariant 1c).
    if (!file && startedMs >= (pausedAt(settings) ?? Infinity)) { rmSync(piece, { force: true }); report(); return; }
    let heard = false;
    try {
      // Text a hearing model makes up out of silence is left out before it is named, sent or kept (isFalseText).
      const stretches = beforePause(await stretchesOf(piece, startedMs, { hearing, knowWho: naming(), session, spoken: file ? null : spoken, preheard, afterHearing }), file ? null : pausedAt(settings))
        .filter(stretch => !isFalseText(stretch.text));
      heard = true;
      status.pieces += 1;
      sound?.add({ file: piece, start_ms: startedMs, end_ms: endedMs, ...(file ? {} : { seconds }), own: !file });
      keepHeardTurns(said.heard(stretches, endedMs), { listen: settings, outbox, log });
      await keepSound();
      status.error = null;
    } catch (error) { status.error = String(error.message ?? error); log(`Listening: ${status.error}`); }
    finally {
      if (!file && !sound && (heard || piece.endsWith('.again.wav'))) rmSync(piece, { force: true });
      // A piece that could not be heard a second time is still sound: kept without words.
      else if (!file && !heard && piece.endsWith('.again.wav')) await sound.unheard(piece, startedMs).then(() => rmSync(piece, { force: true }), error => log(`Listening: ${error.message}`));
      else if (!file && !heard) renameSync(piece, piece.replace(/\.wav$/, '.again.wav'));
      report();
    }
  };
  report();
  if (file) {
    await work(file, fileAt ? Date.parse(fileAt) : Date.now(), Number.POSITIVE_INFINITY);
    keepHeardTurns(said.end(), { listen: settings, outbox, log });
    await outbox.drain();
    await keepSound();
    await drainingSound;
    outbox.close();
    status.listening = false; report();
    return status;
  }
  // Pieces left from before are heard first, in turn, on the same hearing line as the new ones, and the microphone starts
  // at once beside them: a store that does not answer delays words, never the recording (on 2026-10-05 the listener
  // waited on 123 leftover pieces against a busy account and recorded nothing for three hours).
  let hearingTurn = Promise.resolve();
  const recording = path.join(pieces, 'recording');
  leftoverPieces(recording, pieces);
  const saved = savedPieces(pieces, log);
  hearingTurn = hearSavedPieces(saved, {
    hear: piece => hearWith(hearing, piece.file, { language: spoken.language ?? '' }),
    process: (piece, preheard, afterHearing) => work(piece.file, piece.startedMs,
      piece.startedMs + settings.capture.piece_seconds * 1000, { preheard, afterHearing }),
  });
  const capture = captureHere(settings);
  if (!capture) throw new Error(settings.words.no_capture);
  // Days of sound past keep_sound.keep_days go to Recently Deleted when listening starts (null keeps every day).
  if (keep && Number.isFinite(keep.keep_days)) {
    const call = toolCaller(origin, key);
    call('list_files', { folder: keep.folder }).then(listed => {
      const past = daysPast(keep, listed?.folders ?? []);
      return past.length ? call('delete_file', { names_or_identities: past }) : null;
    }).catch(error => log(`Listening: older sound was not cleared: ${error.message}`));
  }
  // The microphone belongs to the app that started this listener: once that app is gone (this process is handed to
  // another parent), recording only fails or hangs, so it stops and the app's next reader starts a listener of its own.
  // The microphone is opened once and kept open while listening is on; each finished piece joins the hearing line.
  const startedBy = process.ppid;
  const keepOn = () => isOn(settings) && process.ppid === startedBy;
  while (keepOn()) {
    const recorder = recordPieces(capture, recording, settings.capture.piece_seconds);
    try {
      for (let piece; (piece = await recorder.next());) {
        const named = path.join(pieces, `${piece.startedMs}.wav`);
        renameSync(piece.file, named);
        hearingTurn = hearingTurn.then(() => work(named, piece.startedMs, piece.endedMs, { seconds: piece.seconds }));
        if (!keepOn()) recorder.stop();
      }
    } catch (error) {
      recorder.stop();
      status.error = String(error.message ?? error); report(); log(`Listening: ${status.error}`);
      for (const piece of leftoverPieces(recording, pieces)) { hearingTurn = hearingTurn.then(() => work(piece.file, piece.startedMs, piece.startedMs + settings.capture.piece_seconds * 1000)); }
      await new Promise(done => setTimeout(done, 10_000));
    }
  }
  await hearingTurn;
  keepHeardTurns(said.end(), { listen: settings, outbox, log });
  await outbox.drain();
  await keepSound().catch(() => {});
  await drainingSound;
  if (status.sound_waiting) await drainSound();
  outbox.close();
  status.listening = false;
  report();
  return status;
}

// ---- Started by the computer reader ------------------------------------------------------------------------------

/**
 * The reader's listener: look() starts one listener child (this file, --keep-listening, on this program's runtime so
 * macOS asks for the microphone for the same app) while the switch says on and none is running. The child stops
 * itself once the switch says off.
 */
const HERE_FILE = fileURLToPath(import.meta.url);

/** The listener running on this computer (listener.pid): 'none', 'mine' (this copy of this file) or 'another'. */
export const listenerHere = (running, isAlive, here = HERE_FILE) => {
  const pid = Number(running?.pid);
  if (!pid || !isAlive(pid)) return 'none';
  return running.runs === here ? 'mine' : 'another';
};

export function startListening({ rows, key, origin, log = () => {} }) {
  const row = rowOf(rows);
  return {
    look() {
      if (!row || !key || !isOn(row.listen)) return false;
      const state = expand(row.listen.state);
      const pidFile = path.join(state, 'listener.pid');
      const running = readJson(pidFile);
      const pid = Number(running?.pid);
      // One listener per computer, and it is this reader's own: a listener another program started (the helper, while
      // the app was being replaced) runs that program's copy of this file, so the reader holding the reading stops it
      // and starts its own.
      const now = listenerHere(running, alive);
      if (now === 'mine') return false;
      if (now === 'another') {
        try { process.kill(pid); } catch { /* already gone */ }
        log('Listening: replaced the listener another program started.');
      }
      mkdirSync(state, { recursive: true, mode: 0o700 });
      const out = openSync(path.join(state, 'listener.log'), 'a', 0o600);
      const child = spawn(process.execPath, ['--no-warnings', HERE_FILE, '--keep-listening'], { env: { ...process.env, TRILLION_ORIGIN: origin }, stdio: ['pipe', out, out] });
      closeSync(out);
      writeJson(pidFile, { pid: child.pid, since: new Date().toISOString(), runs: HERE_FILE });
      child.on('error', error => log(`Listening: ${error.message}`));
      child.stdin.end(key);
      log('Listening on this computer.');
      return true;
    },
  };
}

// ---- Tools on this Mac (computer/mac-tools.json) -----------------------------------------------------------------

const settingsHere = () => rowOf(JSON.parse(readFileSync(path.join(HERE, 'computer-sources.json'), 'utf8'))).listen;
// A file the tool is given: a path on this Mac, or a file in the person's Trillion (read once into the state folder).
async function localFile(input, context, listen) {
  if (input.path) return { file: expand(input.path), fetched: false };
  if (!input.file) throw Object.assign(new Error(listen.words.needs_file), { status: 400 });
  const found = await toolCaller(context.origin, context.key)('find_file', { name_or_identity: input.file, seconds: 600 });
  const answer = await fetch(found.url, { signal: AbortSignal.timeout(600_000) });
  if (!answer.ok) throw new Error(`reading ${input.file}: ${answer.status}`);
  const folder = path.join(expand(listen.state), 'files');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${Date.now()}-${path.basename(found.names?.[0] ?? found.name ?? 'file')}`);
  writeFileSync(file, Buffer.from(await answer.arrayBuffer()), { mode: 0o600 });
  return { file, fetched: true, identity: found.identity ?? input.file };
}
const knowWhoOrSay = listen => {
  const found = knowWhoHere(listen);
  if (!found) throw new Error(listen.words.no_know_who);
  return knowWhoCaller(found, listen);
};

export const listeningTools = {
  /** Turns listening on or off, or says whether it is on: { on? } -> { on, since, by, status }. */
  async listen(input) {
    const listen = settingsHere();
    if (input.rejected) {
      const status = readJson(path.join(expand(listen.state), 'status.json'));
      return rejectedTurnsTool(listen, input.rejected, { listening: Boolean((readJson(expand(listen.switch)) ?? { on: false }).on) && livenessOf(status).live });
    }
    const now = typeof input.on === 'boolean' ? setOn(listen, input.on, 'an AI, when the person asked') : readJson(expand(listen.switch)) ?? { on: false };
    const status = readJson(path.join(expand(listen.state), 'status.json'));
    // Whether it is really listening is read from the heartbeat's age now, not from what the last report said (livenessOf).
    const rows = JSON.parse(readFileSync(path.join(HERE, 'computer-sources.json'), 'utf8'));
    return { ...now, status, live: livenessOf(status), notes: status?.notes ?? jobState('waiting'), said: now.on ? listen.words.on : listen.words.off, hearing: hearingNow(rows.hearing ?? []), ...leavesOf(listen) };
  },
  /** The people this Mac can name, without their voice or face numbers. */
  async people() {
    const listen = settingsHere();
    return { people: await knowWhoOrSay(listen)('people') };
  },
  /** Enrolls someone by a recording of their voice or a picture of their face, or names a voice heard while listening. */
  async enroll(input, context) {
    const listen = settingsHere();
    if (!String(input.name ?? '').trim() || !['voice', 'face'].includes(input.kind) || !String(input.consent ?? '').trim()) throw Object.assign(new Error(listen.words.enroll_needs), { status: 400 });
    const knowWho = knowWhoOrSay(listen);
    if (input.heard_voice) {
      // The listening the voice was heard in: the one named, else the one running when `heard_at` was said, else the last.
      const state = expand(listen.state);
      const found = input.session ? { file: path.join(state, path.basename(input.session)), started: Number(SESSION.exec(path.basename(input.session))?.[1]) }
        : input.heard_at ? sessionAt(state, input.heard_at) : sessionsIn(state).at(-1);
      if (!found) throw Object.assign(new Error(listen.words.no_session), { status: 404 });
      const person = await knowWho('enroll', input.name, 'voice', '-', input.consent, ...(input.me ? ['--me'] : []), '--from-unknown', input.heard_voice, found.file);
      // What that voice already said in that listening is kept under the name from now on (src/messages.mjs nameSpeaker).
      // A voice the listener merged with others was heard under each of their labels; every one is named.
      const named = context.key ? await Promise.all((person.heard_as ?? [input.heard_voice]).map(voice => toolCaller(context.origin, context.key)('name_speaker', {
        app: listen.route, speaker: fill(listen.words.unknown, { voice }), name: person.name,
        since: new Date(found.started).toISOString(), until: new Date(statSync(found.file).mtimeMs + 60_000).toISOString(),
        evidence: fill(listen.words.named_by_voice, { voice, consent: input.consent }),
      }).catch(error => ({ voice, error: String(error.message ?? error) })))) : null;
      return { ...person, named };
    }
    const { file, fetched } = await localFile(input, context, listen);
    try { return await knowWho('enroll', input.name, input.kind, file, input.consent, ...(input.me ? ['--me'] : [])); }
    finally { if (fetched) rmSync(file, { force: true }); }
  },
  /** Hears a piece another device recorded ({ file | path, at, device }): every turn in it goes to the one door as its
   *  speaker's, named against the people this Mac knows, exactly as this Mac's own listening sends them. */
  async hear(input, context) {
    const listen_ = settingsHere();
    if (!String(input.device ?? '').trim()) throw Object.assign(new Error(listen_.words.hear_needs_device), { status: 400 });
    const { file, fetched } = await localFile(input, context, listen_);
    try {
      const rows = JSON.parse(readFileSync(path.join(HERE, 'computer-sources.json'), 'utf8'));
      const status = await listen({ row: rowOf(rows), key: context.key, origin: context.origin, file, fileAt: input.at ?? null, device: String(input.device).trim() });
      // Heard: each moment's sound is kept as its own file with its words (keep_sound), so the device's piece is let go
      // once every cut of it is kept; while a cut still waits, or with keep_sound off, the piece stays where it is.
      const cutsKept = listen_.keep_sound?.on && status.sound_waiting === 0;
      const forget = input.file && !status.error && cutsKept && context.key
        ? await toolCaller(context.origin, context.key)('delete_file', { names_or_identities: [input.file] }).then(() => true, () => false) : false;
      return { sent: status.sent, left_out: status.left_out, waiting: status.waiting, naming: status.naming, error: status.error, sound_waiting: status.sound_waiting, piece_let_go: forget };
    } finally { if (fetched) rmSync(file, { force: true }); }
  },
  /** Hears a recording into timed words on this Mac ({ file | path }), with the first hearing program here, so a
   *  recording made anywhere is heard free by the person's awake Mac instead of a speech model Trillion pays for:
   *  { text, segments, language, heard_whole, produced_by }. Trillion keeps it beside the file (src/account-transcription.mjs). */
  async transcribe(input, context) {
    const listen = settingsHere();
    const rows = JSON.parse(readFileSync(path.join(HERE, 'computer-sources.json'), 'utf8'));
    const hearing = hearingHere(rows.hearing ?? []);
    if (!hearing) throw new Error(listen.words.no_hearing);
    const { file, fetched } = await localFile(input, context, listen);
    try { return { ...(await hearWith(hearing, file, { language: input.language ?? '', prompt: input.prompt ?? '' })), heard_whole: true }; }
    finally { if (fetched) rmSync(file, { force: true }); }
  },
  /** Who is in a recording or a picture: speakers of each stretch of words (a voice that could be more than one person
   *  says so, as its message does: speakerOf), or faces; kept on the Trillion file too. */
  async who(input, context) {
    const listen = settingsHere();
    const knowWho = knowWhoOrSay(listen);
    const { file, fetched, identity } = await localFile(input, context, listen);
    try {
      const picture = /\.(jpe?g|png|heic|webp|gif|bmp|tiff?)$/i.test(file);
      if (picture || input.faces) return { faces: await knowWho('faces', file) };
      const rows = JSON.parse(readFileSync(path.join(HERE, 'computer-sources.json'), 'utf8'));
      const hearing = hearingHere(rows.hearing ?? []);
      if (!hearing) throw new Error(listen.words.no_hearing);
      const stretches = await stretchesOf(file, 0, { hearing, knowWho, session: null });
      const speakers = turnsOf(stretches, listen.turns.join_within_seconds).map(turn => ({ start: turn.start_ms / 1000, end: turn.end_ms / 1000, who: speakerOf(turn, listen.words), me: turn.who?.me === true, ...(turn.unsure?.length ? { unsure: turn.unsure.map(person => person.name) } : {}), text: turn.text }));
      if (identity) await toolCaller(context.origin, context.key)('record_file_results', { results: [{ identity, kind: 'speakers', value: { speakers }, produced_by: 'know-who on this Mac' }] });
      return { speakers };
    } finally { if (fetched) rmSync(file, { force: true }); }
  },
};

async function keyFromStdin() { let text = ''; for await (const chunk of process.stdin) text += chunk; return text.trim(); }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
  const rows = JSON.parse(readFileSync(path.join(HERE, 'computer-sources.json'), 'utf8'));
  const row = rowOf(rows);
  const key = await keyFromStdin();
  const origin = process.env.TRILLION_ORIGIN ?? rows.origin;
  const pidFile = path.join(expand(row.listen.state), 'listener.pid');
  if (process.argv.includes('--keep-listening')) {
    const end = () => { const held = readJson(pidFile); if (held?.pid === process.pid) rmSync(pidFile, { force: true }); process.exit(0); };
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, end);
    writeJson(pidFile, { pid: process.pid, since: new Date().toISOString(), runs: HERE_FILE });
    await listen({ row, key, origin });
    end();
  } else if (option('--file')) {
    process.stdout.write(`${JSON.stringify(await listen({ row, key, origin, file: path.resolve(option('--file')), fileAt: option('--at') }))}\n`);
  }
}
