#!/usr/bin/env node
// computer/keep-drive-files.mjs
//
// Purpose
//   Keeps every file on one plugged-in drive in the person's Trillion files, by itself: the computer reader
//   (read-this-computer.mjs) starts one keeper per drive its `keep` row allows (computer-sources.json, the drives row),
//   and the keeper sends each new or changed file through the shared chunked sender
//   (parts/live-namespace/do-work/send-a-file-to-a-namespace.mjs) under `<folder>/<path on the drive>`, where folder is
//   the row's `keep.folder` with {drive} filled (/Recordings/<drive name>). Each recording (an audio or video file, by
//   src/file-type.mjs) is heard on this computer by the first `hearing` row whose program is here, beside its upload:
//   the hearing starts the moment the file's identity is measured (at disk speed, while its chunks are still going up),
//   its words are kept as the file's transcript, and the upload's finish waits for them, so the arrival rule's
//   transcribe-file finds the words already there and tool:keep-a-voice-memo hands the recording to the person's AIs.
//
//     node computer/keep-drive-files.mjs --drive "/Volumes/<name>" --state <folder>   (account key on stdin)
//
// Non-negotiable invariants
//   1. The ledger (<state>/saved.jsonl) names every file finished by its path, size, modified time and BLAKE3 content
//      identity. Metadata only selects candidates; a bounded, rotating set is read and hashed before it can count as
//      unchanged. A file the service already holds (the same bytes under any name) is only named, never sent again.
//   2. One keeper per drive: <state>/keeper.lock names the running process; another start leaves it alone.
//   3. A drive unplugged part way stops the run as `waiting-for-the-drive`; the next time it is plugged in the reader
//      starts a keeper again and it goes on from the ledger, and chunks already sent are skipped.
//   4. Progress is one file (<state>/progress.json, written whole and renamed into place), which
//      computer/report-progress.json turns into one live card in the person's Trillion. The person's Pause, Resume and
//      Stop on that card write or remove <state>/control.json, honoured before every file.
//   5. The account key stays in this process's memory and is sent only in the Authorization header.
//   6. Hearing never stops an upload: a hearing program that fails or is missing leaves the recording to the hosted
//      hearing after it arrives; the failure is counted in progress, never thrown.
//   8. Each recording is also seen here at capture (see-a-recording.mjs, the first `seeing` row whose program is here):
//      its still is kept as the file's `preview` result about a second after its identity is measured, then its strip of
//      frames and waveform, before the upload finishes, so no browser and no hosted run decodes it again. Seeing never
//      stops an upload either: a failure is counted and the file arrives without a preview, as before.
//   7. Which drives, which folder, which files are passed over, which programs hear and how fast are DATA
//      (computer-sources.json, and src/side-files.json for the files a device writes beside a recording); this file
//      names none of them.
//
import { execFile, execFileSync, spawn } from 'node:child_process';
import { closeSync, promises as fs, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hearingHere, hearingReasons } from '../computer-programs/read-data/program-here.mjs';
import { makeHashCodeHexFromChunks } from '../content-identity/read-data/identity.mjs';
export { hearingHere, hearingReasons };
import { bearerControl, namespaceClient } from '../browse-and-upload-my-files/do-work/namespace-client.mjs';
import { loadChunking } from '../browse-and-upload-my-files/do-work/content-chunks.mjs';
import { NamespaceRefused, WHOLE_FILE_BYTES, byteBudget, fileSource, sendFile, sendWholeFiles } from '../browse-and-upload-my-files/do-work/send-a-file-to-a-namespace.mjs';
import { filesUnder, mediaTypeOf } from '../browse-and-upload-my-files/do-work/send-a-folder-to-a-namespace.mjs';
import { fileType } from './file-type.mjs';
import { sideFiles } from './side-files.mjs';
import { seeWith, seenAlready } from './see-a-recording.mjs';
import { observeVisual, captionWith, genericVisualTitle } from './observe-visual.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The places and their rules are rows of the Workshop tool that reads them (trillion-workshop package).
const PLACE_ROWS = fileURLToPath(new URL('../bring-in-new-items-from-this-computer/computer/computer-sources.json', import.meta.url));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const expand = (place, home = os.homedir()) => place.replace(/^~(?=\/|$)/, home);
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const isRecording = type => /^(audio|video)\//i.test(type ?? '');
// A call the busy service turned away is asked again after each of these waits.
const AGAIN_AFTER_MS = [15_000, 30_000, 60_000];
async function again(work, waits = AGAIN_AFTER_MS) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await work(); }
    catch (error) { if (attempt >= waits.length) throw error; await pause(waits[attempt]); }
  }
}

/** What macOS says about the disk a folder is on (diskutil info), as plain JSON; {} when it cannot say. */
export function diskFacts(mount, read = target => JSON.parse(execFileSync('/bin/sh', ['-c', '/usr/sbin/diskutil info -plist "$0" | /usr/bin/plutil -convert json -o - -', target], { encoding: 'utf8', timeout: 15_000 }))) {
  try { return read(mount); } catch { return {}; }
}

/** Whether every `when` test of a keep row holds for a disk's facts: { fact, equals } or { fact, not }. */
export const allowed = (when = [], facts = {}) => when.every(test => (Object.hasOwn(test, 'equals') ? facts[test.fact] === test.equals : facts[test.fact] !== test.not));

/** The words a found program's `run` (or another template of it) says, filled: [command, ...args]. The checked
 *  program's own copy runs when the template starts with the checked program's name. */
const commandOf = (row, template, values) => {
  const [first, ...args] = template.map(part => fill(part, { here: HERE, ...values }));
  return [row.program && first === row.check?.[0] ? row.program : first, ...args];
};

/** One JSON line to the resident on `socket` and its one-line answer. */
const askOnce = (socket, request, timeout) => new Promise((resolve, reject) => {
  const connection = net.createConnection(socket);
  let data = '';
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    connection.destroy();
    if (error) reject(error); else resolve(value);
  };
  connection.setTimeout(timeout, () => finish(new Error('the model program took too long')));
  connection.on('connect', () => connection.write(`${JSON.stringify(request)}\n`));
  connection.on('data', chunk => {
    data += chunk;
    if (!data.endsWith('\n')) return;
    try { finish(null, JSON.parse(data)); } catch { finish(new Error('the model program answered without words')); }
  });
  const ended = () => finish(new Error('the model program closed before its answer was complete'));
  connection.once('end', ended);
  connection.once('close', ended);
  connection.once('error', error => finish(error));
});

/**
 * The answer of the resident model program on `resident.socket` (computer/resident.py) to one request, starting it
 * with `start` ([command, ...args]) when nothing answers there, so a model is loaded once and kept while it is used
 * instead of once per request. `resident`: { socket, idle_seconds, start_seconds, most_seconds }.
 */
export async function askResident(resident, start, request, { env = process.env, connect = askOnce } = {}) {
  const socket = expand(resident.socket);
  const tryOnce = () => connect(socket, request, resident.most_seconds * 1000);
  try { return await tryOnce(); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
  spawn(start[0], start.slice(1), { env, detached: true, stdio: 'ignore' }).unref();
  for (const until = Date.now() + resident.start_seconds * 1000; Date.now() < until;) {
    await pause(500);
    try { return await tryOnce(); }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  }
  throw new Error('the model program did not start in time');
}

/**
 * Runs a found program row with `values` filled into its `run` and `more` words after it: through its resident
 * (row.resident, DATA) when it has one, which answers { argv } with { ok, value }, else as one process whose last line
 * of output is its JSON answer.
 */
export async function runFound(row, values, { more = [], mostSeconds = row.most_seconds ?? 3600, connect } = {}) {
  const [command, ...filled] = commandOf(row, row.run, values);
  const args = [...filled, ...more];
  if (row.resident) {
    const resident = { most_seconds: mostSeconds, ...row.resident };
    const start = commandOf(row, row.resident.run, { socket: expand(resident.socket), idle_seconds: resident.idle_seconds });
    const answer = await askResident(resident, start, { argv: args }, { env: row.env, connect });
    if (!answer?.ok) throw new Error(answer?.error || 'the model program did not answer');
    return answer.value;
  }
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: row.env, maxBuffer: 256 * 1024 * 1024, timeout: mostSeconds * 1000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr).trim().split('\n').pop() || error.message));
      try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); } catch { reject(new Error('the program did not answer with words')); }
    });
  });
}

// Whether a hearing row takes this hearing: a row with `languages` hears only those (an unknown language it finds
// itself), and a row with `prompt: false` cannot be steered by words that may come up.
const takes = (row, { language, prompt }) => (!prompt || row.prompt !== false) && (!language || !row.languages || row.languages.includes(language));

// A row's one-time preparation as its program last wrote it (row.prepare.progress, DATA), or null.
const preparationOf = row => { try { return JSON.parse(readFileSync(expand(row.prepare.progress), 'utf8')); } catch { return null; } };
const PREPARING = ['starting', 'fetching', 'unpacking'];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Whether a hearing row can hear now: one with nothing to prepare always; one with `prepare` once its preparation says ready for its model. */
export const preparedHere = row => { if (!row?.prepare) return true; const now = preparationOf(row); return now?.state === 'ready' && now.model === row.model; };

/**
 * A hearing row's one-time preparation (row.prepare, DATA: `label`, `run` with {model} {progress} {label}, `progress`
 * file, `again_after_seconds`), started in the background unless it is ready, still running, or failed less than
 * again_after_seconds ago. Answers its progress ({ model, label, state, done, total, percent, error? }), or null for a
 * row with nothing to prepare. Started ahead of the first recording (read-this-computer.mjs each look, listen.mjs at
 * the start), so the person's first hearing never waits for a fetch: until it is ready, hearWith hears with the next row.
 */
export function prepareHearing(row, { start = (command, args, env) => { const child = spawn(command, args, { env, detached: true, stdio: 'ignore' }); child.unref(); return child.pid; }, now = Date.now } = {}) {
  if (!row?.prepare) return null;
  const was = preparationOf(row);
  if (was?.model === row.model) {
    if (was.state === 'ready') return was;
    if (PREPARING.includes(was.state) && alive(was.pid)) return was;
    if (was.state === 'failed' && now() - Date.parse(was.updated_at) < row.prepare.again_after_seconds * 1000) return was;
  }
  const progress = expand(row.prepare.progress);
  mkdirSync(path.dirname(progress), { recursive: true, mode: 0o700 });
  const [command, ...args] = commandOf(row, row.prepare.run, { model: row.model, progress, label: row.prepare.label });
  const value = { model: row.model, label: row.prepare.label, state: 'starting', done: 0, total: 0, percent: 0, pid: start(command, args, row.env), started_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString() };
  writeFileSync(progress, JSON.stringify(value));
  return value;
}

/**
 * Which hearing program hears on this computer now ({ by, passed_over, preparing? }): the first hearing row here, or
 * the row after it while the first is still being prepared (starting that preparation when it is due), with one plain
 * sentence per row passed over and why (program-here.mjs hearingReasons).
 */
export function hearingNow(rows, options = {}) {
  const found = hearingHere(rows ?? [], options);
  return found ? hearingState(found, options) : { by: null, passed_over: hearingReasons(rows ?? [], options) };
}

/** hearingNow for a row hearingHere already found, so a caller that looks often runs no program check again. */
export function hearingState(found, options = {}) {
  const preparing = prepareHearing(found, options);
  const hears = preparedHere(found) ? found : found.next();
  return { by: hears?.label ?? null, passed_over: found.passed_over ?? [], ...(preparing ? { preparing } : {}) };
}

/**
 * Hears one recording with a hearing row: the transcript value it prints ({ text, segments, language, heard_whole }),
 * with `produced_by`, the row that heard it. `language` is the language already heard in the same listening session
 * ({language} in the row's run), so a quiet or noisy piece is not guessed afresh as another language; empty, the program
 * detects it, as for a recording dropped in. `prompt` ({prompt}) is words that may come up (computer/dictation.mjs
 * biasPrompt), empty for none. The hearing goes to the next hearing row here (row.next(), program-here.mjs) when this
 * row does not take it (`takes`), when it is not prepared yet (its preparation is started, prepareHearing), when its
 * program answers { passed_on, language } (a language it does not hear), or when its program fails; with no next row,
 * that is the answer.
 */
export async function hearWith(row, recording, { language = '', prompt = '' } = {}) {
  const asked = { language: language ?? '', prompt: prompt ?? '' };
  const next = row.next?.() ?? null;
  if (!takes(row, asked)) {
    if (!next) throw new Error(`${row.label ?? row.id} does not hear ${asked.prompt ? 'with words that may come up' : `the language ${asked.language}`}, and this computer has no other hearing program.`);
    return hearWith(next, recording, asked);
  }
  if (!preparedHere(row)) {
    const preparing = prepareHearing(row);
    if (!next) throw new Error(`${preparing.label}: ${preparing.state === 'failed' ? `it failed (${preparing.error}) and is tried again later` : `${preparing.percent ?? 0}% done`}, and this computer has no other hearing program.`);
    return hearWith(next, recording, asked);
  }
  let value;
  try { value = await runFound(row, { file: recording, model: row.model ?? '', ...asked }); }
  catch (error) {
    if (!next) throw error;
    process.stderr.write(`Hearing: ${row.label ?? row.id} could not hear ${path.basename(recording)} (${error.message}); ${next.label ?? next.id} hears it.\n`);
    return hearWith(next, recording, asked);
  }
  if (value?.passed_on) {
    if (!next) throw new Error(`${row.label ?? row.id} does not hear the language ${value.language || 'of this recording'}, and this computer has no other hearing program.`);
    return hearWith(next, recording, { ...asked, language: value.language ?? '' });
  }
  return { ...value, produced_by: row.produced_by };
}

// Supply every raw byte to the shared identity owner with one bounded buffer.
// The synchronous hash consumes each view before this buffer is reused.
function* localRecordingBytes(file) {
  const descriptor = openSync(file, 'r');
  const buffer = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (!bytes) return;
      yield buffer.subarray(0, bytes);
    }
  } finally { closeSync(descriptor); }
}

/** Read one local recording through an explicitly selected existing provider,
 * without uploading it, opening a microphone, reading an account key or keeping
 * account results. Offline requests use a fresh direct provider process so an
 * already-running resident cannot evade the offline environment contract. */
export async function hearLocalFile(recording, { hearingId, offline = false, language = '',
  rows = JSON.parse(readFileSync(PLACE_ROWS, 'utf8')),
  find = hearingHere, hear = hearWith } = {}) {
  const file = path.resolve(recording);
  if (!statSync(file).isFile()) throw new Error('Local hearing needs a regular recording file.');
  if (offline && !hearingId) throw new Error('Offline local hearing needs an explicit configured hearing id.');
  const selected = hearingId ? (rows.hearing ?? []).filter(row => row.id === hearingId) : rows.hearing ?? [];
  if (!selected.length) throw new Error('The requested hearing id is not configured on this computer.');
  const found = find(selected);
  if (!found) throw new Error('No installed program satisfies the selected hearing provider.');
  if (offline && found.prepare) throw new Error('Offline local hearing cannot enter a provider preparation path.');
  const provider = offline ? { ...found, resident: undefined,
    env: { ...found.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, next: () => null } : found;
  const before = makeHashCodeHexFromChunks(localRecordingBytes(file));
  const value = await hear(provider, file, { language, prompt: '' });
  const after = makeHashCodeHexFromChunks(localRecordingBytes(file));
  if (before !== after) throw new Error('The local recording changed while it was heard; this transcript is unqualified.');
  return { ...value, hearing: { id: provider.id, model: provider.model, program: provider.program,
    offline, resident_used: Boolean(provider.resident), source_bytes_blake3: before,
    expected_words_prompt_supplied: false, offline_environment: offline ? { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } : null } };
}

// A transcript kept already that the hosted transcribe-file would reuse: heard whole, or carrying word timings.
const kept = value => value?.heard_whole === true || (Array.isArray(value?.segments) && value.segments.some(segment => segment?.words?.length));

/** One Trillion tool call over the account's MCP door ({ result } or throws), for the tools no plain route offers. */
export function toolCaller(origin, key, fetchImpl = fetch) {
  let session = null;
  const rpc = async (method, params, id) => {
    const answer = await fetchImpl(`${origin.replace(/\/$/, '')}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, 'user-agent': 'Trillion drive keeper', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id ? { id } : {}) }), signal: AbortSignal.timeout(90_000) });
    session = answer.headers.get('mcp-session-id') ?? session;
    const text = (await answer.text()).trim();
    if (!text) return null;
    return text.startsWith('{') ? JSON.parse(text) : text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).pop();
  };
  return async (name, args) => {
    if (!session) { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Trillion drive keeper', version: '1' } }, 1); await rpc('notifications/initialized', {}); }
    const answer = await rpc('tools/call', { name, arguments: args }, 2);
    const text = answer?.result?.content?.[0]?.text;
    if (answer?.error || answer?.result?.isError) throw new Error(text ?? answer?.error?.message ?? 'the tool call failed');
    return text ? JSON.parse(text) : null;
  };
}

// One JSON row per line, keyed by `key`.
async function readLedger(file) {
  const rows = new Map();
  try { for (const line of (await fs.readFile(file, 'utf8')).split('\n')) if (line.trim()) { try { const row = JSON.parse(line); rows.set(row.path, row); } catch {} } }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return rows;
}

async function takeLock(file) {
  try {
    const handle = await fs.open(file, 'wx');
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = Number(await fs.readFile(file, 'utf8').catch(() => '0'));
    try { if (holder && holder !== process.pid) { process.kill(holder, 0); return false; } } catch {}
    await fs.unlink(file).catch(() => {});
    return takeLock(file);
  }
}

/** Whether a keeper holds this state folder now (its lock names a live process). */
export function keeping(stateDir) {
  try { const holder = Number(readFileSync(path.join(stateDir, 'keeper.lock'), 'utf8')); process.kill(holder, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

class Stop extends Error { constructor(state) { super(state); this.state = state; } }

/** A persistent per-source byte ceiling. A stopped transfer resumes through the sender's content chunks next hour. */
export function hourlyWriteBudget(file, maximum, { clock = Date.now, read = file => fs.readFile(file, 'utf8'), write = (file, value) => fs.writeFile(file, value), rename = fs.rename } = {}) {
  let turn = Promise.resolve();
  const hourOf = () => Math.floor(clock() / 3_600_000);
  const state = async () => {
    const held = await read(file).then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
    return held?.hour === hourOf() ? held : { hour: hourOf(), bytes: 0 };
  };
  return {
    async ready() { return (await state()).bytes < maximum; },
    async available() { return Math.max(0, maximum - (await state()).bytes); },
    reserve(bytes) {
      const next = turn.then(async () => {
        const held = await state();
        if (held.bytes + bytes > maximum) throw new Stop('hourly-budget');
        held.bytes += bytes;
        const part = `${file}.${process.pid}.part`;
        await write(part, JSON.stringify(held));
        await rename(part, file);
        return held;
      });
      turn = next.catch(() => {});
      return next;
    },
  };
}

// A larger hourly allowance must not make one pass probe thousands of remote folders
// before it can upload anything. The next look resumes at the next newest files.
export const candidatesThisLook = (queue, keep) => keep.hourly_files
  ? queue.slice(0, Math.min(256, Math.max(20, Number(keep.hourly_files) * 4))) : queue;

// What a drive holds that is not a recording and not worth keeping (a tool's temporary pieces, a download that never
// finished) is named by the drives row's keep.skip rows (DATA, each { path, why }): `path` is a pattern over the path on
// the drive, where `*` and `?` stay within one folder name and `**` spans folders. A new tool is one more row. A file a
// device writes beside a recording (a camera's proxy copy or thumbnail) is a row of src/side-files.json instead, which
// also knows its original: it is passed over while its original is on the drive (sideFileHere).
// Returns (path on the drive) -> true when some row matches it.
export function skipRule(rows = []) {
  const patterns = rows.map(row => new RegExp(`^${String(typeof row === 'string' ? row : row.path)
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map(part => ({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[part] ?? part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('')}$`, 'i'));
  return inside => patterns.some(pattern => pattern.test(inside));
}

// Whether `inside` is a side file (src/side-files.json) the drive need not send: one that is never kept, or one whose
// original is on the same drive. A proxy recorded on a card of its own is the only copy and is sent.
export async function sideFileHere(root, inside, rules = sideFiles()) {
  const side = rules.sideOf(inside);
  if (!side) return false;
  if (side.drop === 'always') return true;
  for (const original of side.originals) if (await fs.access(path.join(root, original)).then(() => true, () => false)) return true;
  return false;
}

/**
 * One run over one drive. Everything outside this process is passed in, so a test can hand it its own namespace:
 *   client      namespace-client.mjs client, signed in        chunking   content-chunks bindings
 *   root        where the drive is mounted                     drive      the drive's name ({drive} in the folder)
 *   keep        the drives row's `keep` block                  stateDir   the drive's own folder for ledger and progress
 *   results     { read(identity) -> transcript value | null, put(identity, value, produced_by) }
 *   previews    the same for the file's `preview` result (resultsOver(control, 'preview')), or null to see nothing
 *   seeing      a seeing row from hearingHere over the `seeing` rows, or null   see   (row, file, exec, onStill) -> preview
 *   handOn      (identity) -> state: hands a heard recording to the person's AIs (tool:keep-a-voice-memo)
 *   hearing     a hearing row from hearingHere, or null        hear       (row, file) -> transcript value
 *   againAfterMs waits before asking the busy service again (15 s, 30 s, 60 s)
 *   startedAt   when this keeper started; a later look that finds nothing new writes nothing, so the drive's card
 *               stays one card for as long as the drive is plugged in
 * Returns the final progress, or null when a later look found nothing new.
 */
export async function keepDrive({ client, chunking, root, drive, keep, stateDir, results, handOn, hearing = null, hear = hearWith, previews = null, seeing = null, see = seeWith, visuals = null, observe = observeVisual, captionRow = null, mediaType = mediaTypeOf, openFile = fileSource, startedAt = null, againAfterMs = AGAIN_AFTER_MS, log = () => {} }) {
  const folder = fill(keep.folder, { drive }).replace(/\/+$/, '');
  const ledgerFile = path.join(stateDir, 'saved.jsonl');
  const ledger = await readLedger(ledgerFile);
  const budget = byteBudget(Number(keep.bytes_in_flight ?? 160 * 1024 ** 2));
  const hourly = keep.hourly_write_bytes ? hourlyWriteBudget(path.join(stateDir, 'hourly.json'), Number(keep.hourly_write_bytes)) : null;
  const hourlyFiles = keep.hourly_files ? hourlyWriteBudget(path.join(stateDir, 'hourly-files.json'), Number(keep.hourly_files)) : null;
  const fileSlots = Math.max(1, Number(keep.parallel_files ?? 2));
  const chunkSlots = Math.max(1, Number(keep.parallel_chunks ?? 12));
  const skipped = skipRule(keep.skip);
  const sides = sideFiles();
  const progress = {
    pid: process.pid, drive, folder, started_at: startedAt ?? new Date().toISOString(), state: 'measuring', hearing: hearing?.id ?? null,
    files_total: 0, files_done: 0, files_new: 0, bytes_total: 0, bytes_done: 0, bytes_sent: 0, already_there: 0,
    recordings: 0, heard: 0, words_kept: 0, handed_on: 0, not_heard: 0, seen: 0, not_seen: 0, visually_observed: 0, not_observed: 0, sending: [], errors: [], updated_at: null,
  };
  let writing = Promise.resolve();
  const writeProgress = () => (writing = writing.then(async () => {
    progress.updated_at = new Date().toISOString();
    const part = path.join(stateDir, `progress.${process.pid}.json`);
    await fs.writeFile(part, JSON.stringify(progress, null, 1));
    await fs.rename(part, path.join(stateDir, 'progress.json'));
  }));
  const fail = (name, error) => {
    progress.errors = [...progress.errors, { name, error: String(error?.message ?? error).slice(0, 300), at: new Date().toISOString() }].slice(-50);
    log(`${name}: ${error?.message ?? error}`);
  };
  const stillThere = async () => { try { await fs.access(root); } catch { throw new Stop('waiting-for-the-drive'); } };
  // The person's Pause, Resume and Stop on the drive's card (report-progress.json actions write control.json).
  const checkpoint = async () => {
    for (;;) {
      let control = null;
      try { control = JSON.parse(await fs.readFile(path.join(stateDir, 'control.json'), 'utf8')); } catch {}
      if (control?.action === 'stop') throw new Stop('stopped');
      if (control?.action !== 'pause' || (control.resume_at && Date.parse(control.resume_at) <= Date.now())) {
        if (progress.state === 'paused') { progress.state = 'keeping'; await writeProgress(); }
        return;
      }
      if (progress.state !== 'paused') { progress.state = 'paused'; await writeProgress(); }
      await pause(2000);
    }
  };
  const beforeSend = async bytes => { await checkpoint(); if (hourly) await hourly.reserve(bytes); };

  // What the drive holds now, newest first, so what was just recorded reaches the AIs first.
  const found = [];
  try {
    for await (const inside of filesUnder(root, '', skipped)) {
      if (skipped(inside) || await sideFileHere(root, inside, sides)) continue;
      const stat = await fs.stat(path.join(root, inside)).catch(() => null);
      if (!stat?.size) continue;
      found.push({ path: inside, size: stat.size, mtime_ms: Math.round(stat.mtimeMs) });
    }
  } catch (error) {
    // Unplugged while it was being looked over: say so and wait for it to come back.
    try { await stillThere(); } catch (gone) { progress.state = gone.state; await writeProgress(); return progress; }
    throw error;
  }
  found.sort((left, right) => right.mtime_ms - left.mtime_ms);
  const sameMetadata = (row, file) => row && row.size === file.size && row.mtime_ms === file.mtime_ms;
  progress.files_total = found.length;
  progress.bytes_total = found.reduce((sum, file) => sum + file.size, 0);
  const requestedRecheck = Number(keep.content_recheck_seconds ?? 900);
  const hashFreshMs = (Number.isFinite(requestedRecheck) && requestedRecheck > 0 ? requestedRecheck : 900) * 1000;
  const contentFailureCooldownMs = 60_000;
  const queue = [...found].filter(file => {
    const row = ledger.get(file.path);
    if (sameMetadata(row, file) && Date.now() - Date.parse(row.content_check_failed_at ?? 0) < contentFailureCooldownMs) return false;
    const retrying = row?.recording && (row.heard === 'failed' || row.seen === 'failed' || (!row.handed && row.words !== false));
    const visualRetrying = visuals && /^(image|video)\//i.test(fileType(null, [file.path]) ?? '')
      && (row?.visual === undefined || row?.visual === 'failed' || captionRow && ['here', 'no text', 'needs-caption'].includes(row?.visual));
    return !sameMetadata(row, file) || !row.identity || retrying || visualRetrying || Date.now() - Date.parse(row.content_checked_at ?? 0) >= hashFreshMs;
  }).sort((left, right) =>
    (Date.parse(ledger.get(left.path)?.content_checked_at ?? '') || 0) - (Date.parse(ledger.get(right.path)?.content_checked_at ?? '') || 0)
    || right.mtime_ms - left.mtime_ms);
  // Folder imports have an hourly file allowance. Bound content reads to a small rotating window
  // so a folder with hundreds of thousands of files starts sending now and later looks advance.
  const fileCandidates = candidatesThisLook(queue, keep);
  const requestedHashBytes = Number(keep.content_check_bytes_per_look ?? 256 * 1024 ** 2);
  const hashByteLimit = Number.isFinite(requestedHashBytes) && requestedHashBytes > 0 ? requestedHashBytes : 256 * 1024 ** 2;
  let hashBytes = 0;
  const candidates = fileCandidates.filter(file => {
    if (file.size > WHOLE_FILE_BYTES && hashBytes === 0) { hashBytes = file.size; return true; }
    if (hashBytes === 0 && file.size > hashByteLimit) { hashBytes = file.size; return true; }
    if (hashBytes + file.size > hashByteLimit) return false;
    hashBytes += file.size;
    return true;
  });
  const verifiedUnchanged = [];
  // Recordings kept earlier whose hearing failed, or whose words never reached the AIs, are finished on this look.
  const hasUnfinished = file => { const row = ledger.get(file.path); return sameMetadata(row, file) && ((row.recording && (row.heard === 'failed' || row.seen === 'failed' || (!row.handed && row.words !== false))) || (visuals && /^(image|video)\//i.test(fileType(null, [file.path]) ?? '') && (row.visual === undefined || row.visual === 'failed' || captionRow && ['here', 'no text', 'needs-caption'].includes(row.visual)))); };
  const unfinished = found.filter(hasUnfinished);
  if (startedAt && !queue.length && !unfinished.length) return null;
  progress.files_new = found.filter(file => !sameMetadata(ledger.get(file.path), file)).length;
  progress.state = 'keeping';
  await writeProgress();

  const saved = async (file, answer, extra = {}) => {
    const row = { path: file.path, size: file.size, mtime_ms: file.mtime_ms, identity: answer.identity, content_checked_at: new Date().toISOString(), name: `${folder}/${file.path}`, sent: answer.state, ...extra, at: new Date().toISOString() };
    await fs.appendFile(ledgerFile, `${JSON.stringify(row)}\n`);
    ledger.set(file.path, row);
    verifiedUnchanged.push({ ...file, ...row });
    progress.files_done += 1;
    progress.bytes_done += file.size;
    if (answer.state === 'already-there' || (answer.chunks && answer.chunks === answer.chunks_already_held)) progress.already_there += 1;
  };

  // Hearing runs one recording at a time (it uses the whole chip); uploads keep going beside it.
  let hearingTurn = Promise.resolve();
  const heardFor = async (file, identity) => {
    const existing = await results.read(identity).catch(() => null);
    if (kept(existing)) return { heard: 'already', words: (existing.text ?? '').trim().length > 0 };
    if (!hearing) { progress.not_heard += 1; return { heard: 'left to the service' }; }
    const turn = hearingTurn.then(async () => {
      const { produced_by: producedBy, ...value } = await hear(hearing, path.join(root, file.path));
      await again(() => results.put(identity, { ...value, heard_whole: true }, producedBy ?? hearing.produced_by), againAfterMs);
      progress.heard += 1;
      if ((value.text ?? '').trim()) progress.words_kept += 1;
      await writeProgress();
      return { heard: 'here', words: (value.text ?? '').trim().length > 0 };
    });
    hearingTurn = turn.catch(() => {});
    try { return await turn; }
    catch (error) { progress.not_heard += 1; fail(`hearing ${file.path}`, error); return { heard: 'failed' }; }
  };

  // Seeing runs one recording at a time too (it decodes the file); its still is kept the moment it is made.
  let seeingTurn = Promise.resolve();
  const seenFor = async (file, identity, type) => {
    if (!seeing || !previews) return null;
    const video = /^video\//i.test(type ?? '');
    const existing = await previews.read(identity).catch(() => null);
    if (seenAlready(existing, video)) return 'already';
    const turn = seeingTurn.then(async () => {
      const keepIt = value => again(() => previews.put(identity, value, seeing.produced_by), againAfterMs);
      const value = await see(seeing, path.join(root, file.path), undefined, keepIt);
      // A file with no picture and no sound in it (a broken or empty recording) is not seen again on every look.
      if (!value) { progress.not_seen += 1; return 'nothing to see'; }
      await keepIt(value);
      progress.seen += 1;
      await writeProgress();
      return 'here';
    });
    seeingTurn = turn.catch(() => {});
    try { return await turn; }
    catch (error) { progress.not_seen += 1; fail(`seeing ${file.path}`, error); return 'failed'; }
  };

  const observedFor = async (file, identity, type) => {
    if (!visuals || !/^(image|video)\//i.test(type ?? '')) return null;
    try {
      const prior = await visuals.read(identity).catch(() => null);
      if (prior?.frames?.length && (!captionRow || prior.caption_version === 1 || !genericVisualTitle(prior.title, captionRow))) return captionRow ? 'captioned' : 'already';
      const value = await observe(path.join(root, file.path), type);
      if (!value) { progress.not_observed += 1; return captionRow ? 'needs-caption' : 'no text'; }
      await again(() => visuals.put(identity, value, 'Vision OCR on this Mac'), againAfterMs);
      progress.visually_observed += 1;
      await writeProgress();
      return captionRow ? genericVisualTitle(value.title, captionRow) ? 'needs-caption' : 'captioned' : 'here';
    } catch (error) { progress.not_observed += 1; fail(`observing ${file.path}`, error); return 'failed'; }
  };

  const handOnce = async (file, identity) => {
    const handed = await again(() => handOn(identity), againAfterMs).catch(error => { fail(`handing on ${file.path}`, error); return null; });
    if (handed) progress.handed_on += 1;
    return handed;
  };

  // Remote names are hints only; after hashing current bytes, a direct one-name lookup can safely reuse an exact identity.
  const heldAtIdentity = async (file, identity) => {
    if (!client.file) return false;
    const name = `${folder}/${file.path}`;
    let entry;
    try { entry = await again(() => client.file(name), againAfterMs); }
    catch (error) { fail(`checking ${name}`, error); return false; }
    return entry?.identity === identity;
  };
  const keepAlreadyHeld = async (file, identity, type) => {
    const recording = isRecording(type);
    if (recording) progress.recordings += 1;
    const [heard, seen, visual] = recording
      ? await Promise.all([heardFor(file, identity), seenFor(file, identity, type), observedFor(file, identity, type)])
      : [null, null, await observedFor(file, identity, type)];
    const handed = recording && heard?.words ? await handOnce(file, identity) : null;
    await saved(file, { state: 'already-there', identity }, recording
      ? { recording: true, heard: heard?.heard ?? null, words: Boolean(heard?.words), handed, seen, visual }
      : { visual });
  };

  const sendOne = async file => {
    if (hourlyFiles) await hourlyFiles.reserve(1);
    const full = path.join(root, file.path);
    const type = fileType(await mediaType(full), [file.path]);
    const recording = isRecording(type);
    if (recording) progress.recordings += 1;
    const item = { name: `${folder}/${file.path}`, byte_length: file.size, bytes_sent: 0 };
    progress.sending = [...progress.sending, item];
    const source = await openFile(full);
    let heard = null, seen = null, visual = null;
    try {
      const answer = await sendFile({
        client, source, identity: file.identity ?? null, chunking, parallel: chunkSlots, budget, name: item.name, modifiedAtMs: file.mtime_ms, mediaType: type,
        beforeSend,
        // Bytes in flight are written at most every two seconds, so the card moves during one long recording.
        onChunk: ({ bytes }) => { item.bytes_sent += bytes; progress.bytes_sent += bytes; if (Date.now() - Date.parse(progress.updated_at ?? 0) > 2000) writeProgress(); },
        // Heard while the chunks go up; the finish waits, so the words are there before the file counts as arrived.
        // Seen beside the hearing: the still is kept about a second after the identity, while chunks still go up.
        onIdentity: recording ? async ({ identity }) => { [heard, seen, visual] = await Promise.all([heardFor(file, identity), seenFor(file, identity, type), observedFor(file, identity, type)]); } : undefined,
      });
      const prior = ledger.get(file.path);
      if (sameMetadata(prior, file) && prior.identity && prior.identity !== answer.identity) progress.files_new += 1;
      // A recording the service already held never arrives again, so it is handed on here; the hand-off is keyed by
      // the recording, so one the arrival rule also hands on is still one job.
      if (recording && answer.state === 'already-there') [heard, seen, visual] = await Promise.all([heardFor(file, answer.identity), seenFor(file, answer.identity, type), observedFor(file, answer.identity, type)]);
      if (!recording) visual = await observedFor(file, answer.identity, type);
      const handed = recording && heard?.words ? await handOnce(file, answer.identity) : null;
      await saved(file, answer, recording ? { recording: true, heard: heard?.heard ?? null, words: Boolean(heard?.words), handed, seen, visual } : { visual });
    } finally {
      await source.close();
      progress.sending = progress.sending.filter(entry => entry !== item);
    }
  };

  // Small files that are not recordings go many to a request.
  const sendSmall = async batch => {
    if (hourlyFiles) await hourlyFiles.reserve(batch.length);
    const files = await Promise.all(batch.map(async file => ({ file, source: await openFile(path.join(root, file.path)), identity: file.identity ?? null, name: `${folder}/${file.path}`, modifiedAtMs: file.mtime_ms, mediaType: fileType(await mediaType(path.join(root, file.path)), [file.path]) })));
    try {
      const answers = await sendWholeFiles({ client, files, chunking, beforeSend, onFiles: (count, bytes) => { progress.bytes_sent += bytes; } });
      for (const [index, answer] of answers.entries()) {
        const file = batch[index];
        const visual = await observedFor(file, answer.identity, files[index].mediaType);
        await saved(file, answer, { visual });
      }
    } catch (error) {
      for (const [index, answer] of (error.answers ?? []).entries()) await saved(batch[index], answer);
      throw error;
    } finally { await Promise.all(files.map(entry => entry.source.close())); }
  };

  const big = [], small = [];
  try {
    for (const candidate of candidates) {
      await checkpoint();
      let source = null, identity;
      const hasher = new chunking.Identity();
      try {
        source = await openFile(path.join(root, candidate.path));
        for (let offset = 0; offset < source.size; offset += 8 * 1024 * 1024) hasher.update(await source.readAt(offset, Math.min(8 * 1024 * 1024, source.size - offset)));
        identity = `1f:${hasher.hex()}`;
      } catch (error) {
        await stillThere();
        const prior = ledger.get(candidate.path) ?? { path: candidate.path, size: candidate.size, mtime_ms: candidate.mtime_ms };
        const failedCheck = { ...prior, content_check_failed_at: new Date().toISOString() };
        await fs.appendFile(ledgerFile, `${JSON.stringify(failedCheck)}\n`).catch(() => {});
        ledger.set(candidate.path, failedCheck);
        fail(candidate.path, error); continue;
      } finally { hasher.free(); await source?.close(); }
      const file = { ...candidate, identity };
      const prior = ledger.get(file.path);
      if (sameMetadata(prior, file) && prior.identity === identity) {
        const checked = { ...prior, content_checked_at: new Date().toISOString() };
        await fs.appendFile(ledgerFile, `${JSON.stringify(checked)}\n`);
        ledger.set(file.path, checked);
        progress.files_done += 1; progress.bytes_done += file.size;
        if (hasUnfinished(file)) verifiedUnchanged.push({ ...file, ...prior });
        continue;
      }
      if (sameMetadata(prior, file)) progress.files_new += 1;
      const type = fileType(null, [file.path]);
      if (await heldAtIdentity(file, identity)) { await keepAlreadyHeld(file, identity, type); continue; }
      if (file.size > WHOLE_FILE_BYTES || isRecording(type)) big.push(file);
      else small.push(file);
    }
    await writeProgress();
    for (let start = 0; start < small.length;) {
      await checkpoint();
      let end = start, bytes = 0;
      const filesLeft = hourlyFiles ? await hourlyFiles.available() : 256;
      if (filesLeft < 1) throw new Stop('hourly-budget');
      while (end < small.length && end - start < Math.min(256, filesLeft) && bytes + small[end].size <= 32 * 1024 * 1024) bytes += small[end++].size;
      if (end === start) end += 1;
      try { await sendSmall(small.slice(start, end)); }
      catch (error) { if (error instanceof NamespaceRefused || error instanceof Stop) throw error; await stillThere(); fail(small[start].path, error); }
      start = end;
      await writeProgress();
    }
    let next = 0;
    await Promise.all(Array.from({ length: fileSlots }, async () => {
      while (next < big.length) {
        const file = big[next++];
        await checkpoint();
        try { await sendOne(file); }
        catch (error) {
          if (error instanceof NamespaceRefused || error instanceof Stop) throw error;
          await stillThere();
          fail(file.path, error);
        }
        await writeProgress();
      }
    }));
    for (const file of verifiedUnchanged.filter(hasUnfinished)) {
      await checkpoint();
      const row = ledger.get(file.path);
      if (row.visual === 'captioned' && !row.recording) continue;
      const heard = row.heard === 'failed' || row.words === undefined ? await heardFor(file, row.identity) : { heard: row.heard, words: row.words };
      const handed = row.handed ?? (heard?.words ? await handOnce(file, row.identity) : null);
      const seen = row.seen === 'failed' ? await seenFor(file, row.identity, fileType(null, [file.path])) : row.seen;
      const visual = row.visual === undefined || row.visual === 'failed' || captionRow && ['here', 'no text', 'needs-caption'].includes(row.visual) ? await observedFor(file, row.identity, fileType(null, [file.path])) : row.visual;
      const finished = { ...row, heard: heard?.heard ?? row.heard, words: Boolean(heard?.words), handed, seen, visual, at: new Date().toISOString() };
      await fs.appendFile(ledgerFile, `${JSON.stringify(finished)}\n`);
      ledger.set(file.path, finished);
      await writeProgress();
    }
    progress.state = progress.files_done >= progress.files_total ? 'finished' : 'incomplete';
  } catch (error) {
    if (error instanceof Stop) progress.state = error.state;
    else if (error instanceof NamespaceRefused) { progress.state = 'refused'; fail('your files', error); }
    else throw error;
  } finally {
    progress.sending = [];
    await writeProgress();
  }
  return progress;
}

/**
 * Starts a keeper for every drive the `keep` row allows that has none running: the reader calls look() on each tick.
 * A drive is each entry of the row's look folder (less `skip` and hidden names) whose disk facts pass `keep.when`; its
 * state folder is `keep.state` with {id} filled from the disk's `keep.id_fact`, so a renamed drive keeps its ledger.
 * The keeper runs on this program's own runtime, so macOS asks for the same switches as for the reader.
 */
export function startKeepers({ rows, key, origin, home = os.homedir(), facts = diskFacts, start = null, fetchImpl = fetch, isFolder = root => statSync(root).isDirectory(), makeState = stateDir => mkdirSync(stateDir, { recursive: true, mode: 0o700 }), log = () => {} }) {
  const row = rows.sources.find(source => source.keep && source.look?.each);
  const folders = rows.imports ?? [];
  const decided = new Map();
  // A keeper starts only once the account has taken this key, so a reader that cannot reach its account (signed out,
  // offline, or a test's unreachable address) starts none.
  let signedIn = false, asking = null;
  const askAccount = () => (asking ??= fetchImpl(`${String(origin).replace(/\/$/, '')}/mcp/api/namespace/summary`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) })
    .then(answer => { signedIn = answer.status === 200; }, () => {}).finally(() => { asking = null; }));
  // The keeper's own lines go to keeper.log in its state folder.
  const launch = start ?? ((root, stateDir, sourceId = null) => {
    const out = openSync(path.join(stateDir, 'keeper.log'), 'a', 0o600);
    const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), '--drive', root, '--state', stateDir, ...(sourceId ? ['--source-id', sourceId] : [])], { env: { ...process.env, TRILLION_ORIGIN: origin }, stdio: ['pipe', out, out] });
    closeSync(out);
    child.on('error', error => log(`Keeping ${path.basename(root)}: ${error.message}`));
    child.stdin.end(key);
  });
  const roomThisHour = (stateDir, keep) => [
    ['hourly.json', keep.hourly_write_bytes], ['hourly-files.json', keep.hourly_files],
  ].every(([file, maximum]) => {
    if (!maximum) return true;
    try {
      const held = JSON.parse(readFileSync(path.join(stateDir, file), 'utf8'));
      return held.hour !== Math.floor(Date.now() / 3_600_000) || held.bytes < maximum;
    } catch { return true; }
  });
  return {
    look() {
      if (!key) return [];
      if (!signedIn) { askAccount(); return []; }
      const started = [];
      for (const source of folders) {
        const root = expand(source.root, home);
        const stateDir = expand(source.keep.state, home);
        try { if (!isFolder(root)) continue; } catch { continue; }
        if (keeping(stateDir) || !roomThisHour(stateDir, source.keep)) continue;
        makeState(stateDir);
        launch(root, stateDir, source.id);
        started.push(source.id);
        log(`Keeping ${source.id} originals in your files.`);
      }
      if (!row) return started;
      const folder = expand(row.look.entries, home);
      let names = [];
      try { names = readdirSync(folder).filter(name => !name.startsWith('.') && !(row.look.skip ?? []).includes(name)); } catch { return started; }
      for (const name of names) {
        const root = path.join(folder, name);
        if (!decided.has(root)) {
          const disk = facts(root);
          decided.set(root, allowed(row.keep.when, disk) && disk[row.keep.id_fact] ? expand(fill(row.keep.state, { id: disk[row.keep.id_fact] }), home) : null);
        }
        const stateDir = decided.get(root);
        if (!stateDir || keeping(stateDir)) continue;
        makeState(stateDir);
        launch(root, stateDir, null);
        started.push(name);
        log(`Keeping ${name} in your files.`);
      }
      // A drive unplugged is decided again when it comes back (it may be another drive under the same name).
      for (const root of decided.keys()) if (!names.includes(path.basename(root))) decided.delete(root);
      return started;
    },
  };
}

/** The account's results of one kind (transcript, preview) for this keeper: read and put over the plain results routes. */
export const resultsOver = (control, kind = 'transcript') => ({
  async read(identity) {
    const { status, body } = await control(`/namespace/results/${encodeURIComponent(identity)}?kind=${encodeURIComponent(kind)}`);
    if (status !== 200) return null;
    return (body?.results ?? [])[0]?.value ?? null;
  },
  async put(identity, value, producedBy) {
    const { status, body } = await control('/namespace/results', { method: 'POST', body: { results: [{ identity, kind, value, produced_by: producedBy }] } });
    if (status !== 200 || body?.refused?.length) throw new Error(`the ${kind} could not be kept (${status}): ${body?.refused?.[0]?.reason ?? body?.error ?? ''}`);
  },
});

async function main() {
  const argv = process.argv.slice(2);
  const option = name => { const at = argv.indexOf(name); if (at < 0) throw new Error(`${name} is required`); return argv[at + 1]; };
  if (argv.includes('--hear-file')) {
    const result = await hearLocalFile(option('--hear-file'), {
      hearingId: argv.includes('--hearing-id') ? option('--hearing-id') : undefined,
      offline: argv.includes('--offline'), language: argv.includes('--language') ? option('--language') : '',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const root = option('--drive'), stateDir = option('--state');
  const sourceAt = argv.indexOf('--source-id');
  const sourceId = sourceAt >= 0 ? argv[sourceAt + 1] : null;
  const rows = JSON.parse(readFileSync(PLACE_ROWS, 'utf8'));
  const row = sourceId ? rows.imports?.find(source => source.id === sourceId && path.resolve(expand(source.root)) === path.resolve(root)) : rows.sources.find(source => source.keep && source.look?.each);
  if (!row) throw new Error('No configured source owns this folder.');
  const origin = process.env.TRILLION_ORIGIN ?? rows.origin;
  let key = '';
  for await (const chunk of process.stdin) key += chunk;
  key = key.trim();
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDir, 'keeper.lock');
  if (!(await takeLock(lock))) return;
  process.on('exit', () => { try { unlinkSync(lock); } catch {} });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0));
  // The keeper ends with the program that started it, as the reader does.
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 5_000).unref();
  const control = bearerControl({ origin, authorization: async () => `Bearer ${key}` });
  const callTool = toolCaller(origin, key);
  const look = {
    client: namespaceClient({ origin, control }), chunking: await loadChunking(), root, drive: path.basename(root), keep: row.keep, stateDir,
    results: resultsOver(control), hearing: hearingHere(rows.hearing ?? []),
    previews: resultsOver(control, 'preview'), seeing: hearingHere(rows.seeing ?? []),
    visuals: sourceId ? resultsOver(control, 'visual-observation') : null,
    captionRow: rows.visual_caption,
    observe: (file, type) => observeVisual(file, type, { captionRow: rows.visual_caption,
      caption: rows.visual_caption ? (pixels, words) => captionWith(rows.visual_caption, pixels, words) : null }),
    handOn: row.keep.hand_on_tool ? async identity => (await callTool('run_tool', { tool_id: row.keep.hand_on_tool, input: { identity }, request_key: `voice-memo:${identity}`, wait_seconds: 30 }))?.state ?? null : async () => null,
    log: line => process.stderr.write(`${line}\n`),
  };
  // One keeper for as long as the drive is plugged in: it looks again every `look_again_seconds` for what was added.
  let startedAt = null;
  for (;;) {
    const progress = await keepDrive({ ...look, keep: sourceId ? { ...row.keep, skip: [...(rows.imports_skip ?? []), ...(row.keep.skip ?? [])] } : row.keep, startedAt });
    startedAt ??= progress?.started_at ?? new Date().toISOString();
    if (progress) process.stdout.write(`${JSON.stringify({ state: progress.state, files_done: progress.files_done, files_total: progress.files_total, heard: progress.heard, handed_on: progress.handed_on })}\n`);
    if (['waiting-for-the-drive', 'stopped', 'refused'].includes(progress?.state)) return;
    const wait = progress?.state === 'hourly-budget' ? Math.max(1000, (Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000 - Date.now()) : Number(row.keep.look_again_seconds ?? 300) * 1000;
    await pause(wait);
    try { await fs.access(root); } catch { return; }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
