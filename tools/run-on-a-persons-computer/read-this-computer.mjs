#!/usr/bin/env node
// computer/read-this-computer.mjs
//
// Purpose
//   Reads this computer for the person's Trillion by itself: it finds every place listed in computer-sources.json
//   (computer-sources.mjs) and tells the account what it found, and it sends what is new in each place that has a
//   `read` block (read-new-items.mjs) to the account's one door, so Connections shows every place and each turns
//   Connected once its first item arrives. It is the one runner for every program that reads a computer: the helper
//   starts it as one of its handlers (harness/wake-sessions.json `handlers`), and the Trillion Mac app imports it and starts it with its own account
//   caller and file keeper.
//     node computer/read-this-computer.mjs --once    one look and one read, then stop (key on stdin, from
//                                                   the program that starts it)
//     node computer/read-this-computer.mjs --keep-reading
//                                                   reads until SIGTERM or until the program that started it is gone;
//                                                   how the Trillion Mac app runs it as its own child on the runtime
//                                                   inside the app, so macOS lists the app for the Full Disk Access
//                                                   switch, never `node`
//
// Non-negotiable invariants
//   1. One reader per computer: the program whose live process id is in ~/.trillion/computer-sources/reading.lock
//      reads; any other program on the same computer leaves the reading alone and asks again on its next tick, so
//      nothing is read or sent twice when the helper and the Mac app both run. A reader whose runtime is inside an
//      app named earlier in computer-sources.json `readers_first` (programOf) asks a reader not named there (or named
//      later) to hand the reading over; the holder hands it over only between reads, so two programs never read at once.
//      Before that order, what each program can open counts: a program that can open more of the places a switch
//      guards (reachOf, measured on every tick) is handed the reading, so a program macOS has not switched on never
//      keeps the reading from one it has.
//   2. One record and one progress per computer: every program on it keeps its progress in the same folder
//      (~/.trillion/computer-sources: what was sent from each place, and the computer's id in computer.json), so the
//      program that reads next goes on where the last one stopped and Connections shows the computer once. A program
//      that kept its progress somewhere before hands it over once (adoptFrom), when the shared folder has none yet.
//   3. The account key stays in this process's memory and is sent only in the Authorization header.
//   4. Places, stores, switches and how often to look are DATA (computer-sources.json); this file names none of them.
//   5. What is read never leaves except to the person's own account, as read-new-items.mjs and computer-sources.mjs
//      allow (only new items, pictures as previews, from browsers only service names).
//   6. The microphone is listened to only while the person has listening on (listen.mjs, the listening row's switch);
//      the listener runs as this program's child, so macOS asks for the microphone for the same app.
//   7. The pieces this reader hosts (drive keepers, the listener, the browser offer) start only if the
//      programs the account installed allow them (installedGate, from ~/.trillion/installed-programs.json that the
//      helper writes, computer/program-host.mjs); with no such file, or none installed, they all run as before.
//
import { bearerControl, namespaceClient } from '../browse-and-upload-my-files/do-work/namespace-client.mjs';
import { loadChunking } from '../browse-and-upload-my-files/do-work/content-chunks.mjs';
import { fileSource, sendFile } from '../browse-and-upload-my-files/do-work/send-a-file-to-a-namespace.mjs';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computerSources } from '../bring-in-new-items-from-this-computer/computer/computer-sources.mjs';
import { readNewItems } from '../bring-in-new-items-from-this-computer/computer/read-new-items.mjs';
import { isRead, liveInputs, readersWith, serviceReader, toolRunner } from '../bring-in-new-items-from-this-computer/computer/inputs.mjs';
import { openRecordsDoorAt } from '../records-door/read-data/records-door.mjs';
import { listsOverDoor } from '../records-door/read-data/lists-door.mjs';
import { hearWith, hearingHere, hearingState, resultsOver, startKeepers } from './keep-drive-files.mjs';
import { observeVisual, captionWith } from './observe-visual.mjs';
import { startListening } from './listen.mjs';
import { followPresence } from './follow-presence.mjs';
import { offerInBrowsers } from './offer-in-browsers.mjs';
import { endWithTheApp } from './end-with-the-app.mjs';
import { installedPrograms, readerGates } from './program-host.mjs';
import { pacedEvery } from './pace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// The places and their rules are rows of the Workshop tool that reads them (trillion-workshop package).
const PLACE_ROWS = fileURLToPath(new URL('../bring-in-new-items-from-this-computer/computer/computer-sources.json', import.meta.url));
export const rowsOf = () => JSON.parse(readFileSync(PLACE_ROWS, 'utf8'));
export const sharedFolder = (home = homedir()) => join(home, '.trillion', 'computer-sources');
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.${process.pid}.part`, JSON.stringify(value, null, 1), { mode: 0o600 });
  renameSync(`${path}.${process.pid}.part`, path);
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** The program macOS lists for a reader on this runtime: the app whose bundle carries the runtime, else the runtime. */
export const programOf = (execPath = process.execPath) => execPath.match(/\/([^/]+)\.app\/Contents\//)?.[1] ?? basename(execPath);

const rankOf = (program, first) => { const at = first.indexOf(program); return at < 0 ? first.length : at; };
// A reader outranks another when it can open more of the places a switch guards; between readers that open as many,
// the one named earlier in readers_first does.
const outranks = (mine, theirs, first) => mine.reach !== theirs.reach ? mine.reach > theirs.reach : rankOf(mine.program, first) < rankOf(theirs.program, first);

/** Whether this process can open one place now: a folder it can list, or a file it can open to read. */
const canOpen = place => {
  try {
    if (statSync(place).isDirectory()) readdirSync(place);
    else closeSync(openSync(place, 'r'));
    return true;
  } catch { return false; }
};

/** How many of the places a switch guards (a row with `gate`) this process can open now, measured, never assumed. */
export const reachOf = (rows, home = homedir()) => rows.sources.filter(row => row.gate && row.read?.store)
  .filter(row => canOpen(row.read.store.replace(/^~(?=\/)/, home))).length;

/**
 * Takes or keeps the computer's one reading lock; true while this process holds it. program is the name this process
 * reads under; first lists the programs that take the reading over (computer-sources.json readers_first); busy says
 * this process is in the middle of a read, so it keeps the reading until the read is done.
 */
export function holdReading(file, pid = process.pid, { program = null, first = [], busy = false, reach = 0 } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = readJson(file) ?? {};
  const held = Number(lock.pid);
  const since = new Date().toISOString();
  if (held === pid) {
    const next = Number(lock.wanted_by);
    if (!next || next === pid || !alive(next) || busy) {
      // The holder's reach is what others are measured against, so a switch turned on or off since counts at once.
      if ((lock.reach ?? 0) !== reach) writeJson(file, { ...lock, reach });
      return true;
    }
    writeJson(file, { pid: next, program: lock.wanted_program ?? null, reach: lock.wanted_reach ?? 0, since });
    return false;
  }
  if (held && alive(held)) {
    const asked = Number(lock.wanted_by);
    if (outranks({ program, reach }, { program: lock.program ?? null, reach: lock.reach ?? 0 }, first) && !(asked && asked !== pid && alive(asked))) writeJson(file, { ...lock, wanted_by: pid, wanted_program: program, wanted_reach: reach });
    return false;
  }
  writeJson(file, { pid, program, reach, since });
  return Number(readJson(file)?.pid) === pid;
}
export const releaseReading = (file, pid = process.pid) => { if (Number(readJson(file)?.pid) === pid) rmSync(file, { force: true }); };

/** The computer's one id: kept once in the shared folder, seeded from an earlier record when there is one. */
export function computerIdOf(file, seed = null) {
  const kept = readJson(file)?.computer_id;
  if (kept) return kept;
  const id = seed ?? randomUUID();
  writeJson(file, { computer_id: id });
  return id;
}

/** One request to the person's account (<origin>/mcp/api<route>): { status, body }, or null when it cannot be reached. */
export const accountCaller = (origin, key, fetchImpl = fetch) => async (route, { method = 'GET', body = null } = {}) => {
  try {
    const answer = await fetchImpl(`${origin.replace(/\/$/, '')}/mcp/api${route}`, { method, headers: { authorization: `Bearer ${key}`, ...(body === null ? {} : { 'content-type': 'application/json' }) }, body: body === null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  } catch { return null; }
};

/** The person's own records door, reached at the account's one address with their key: { lists, run }. */
export function accountDoor({ origin, key, fetchImpl = fetch }) {
  const door = openRecordsDoorAt({ url: `${origin.replace(/\/$/, '')}/mcp`, resource: '@own-records', capability: key, fetchImpl });
  return { lists: listsOverDoor(door), run: toolRunner(door) };
}

/** Keeps one small file in the person's files under `folder` (POST /namespace/write): { id, name }. */
const WHOLE_REQUEST_FILE_BYTES = 12 * 1024 * 1024;
export const fileKeeper = (account, folder, { origin = null, key = null } = {}) => async file => {
  // A request carries at most 16 MiB, so a file whose base64 would not fit is sent in chunks through the shared sender.
  if (origin && key && statSync(file.path).size > WHOLE_REQUEST_FILE_BYTES) {
    const source = await fileSource(file.path);
    try {
      const control = bearerControl({ origin, authorization: async () => `Bearer ${key}` });
      const sent = await sendFile({ client: namespaceClient({ origin, control }), source, chunking: await loadChunking(), name: `${file.folder ?? folder}/${file.name}`, mediaType: file.media_type ?? null });
      return { id: sent.identity, name: file.name };
    } finally { await source.close(); }
  }
  const answer = await account('/namespace/write', { method: 'POST', body: { name: `${file.folder ?? folder}/${file.name}`, content_base64: readFileSync(file.path).toString('base64'), ...(file.media_type ? { media_type: file.media_type } : {}) } });
  if (answer?.status !== 200) throw new Error(answer ? `the account answered ${answer.status}: ${answer.body?.error ?? ''}`.trim() : 'the account could not be reached');
  return { id: answer.body.identity, name: file.name };
};

/** Hands a program's earlier progress to the shared folder once, only for files the shared folder does not have. */
export function adoptProgress(from, to, files = ['written-elsewhere.json', 'computer-sources.json']) {
  if (!from || from === to) return [];
  mkdirSync(to, { recursive: true, mode: 0o700 });
  return files.filter(name => existsSync(join(from, name)) && !existsSync(join(to, name))).map(name => { copyFileSync(join(from, name), join(to, name)); return name; });
}

/**
 * Starts reading this computer. account (route, {method, body}) -> {status, body} | null, or key and origin to make
 * one; keep(file) -> {id, name}, or made from account; stateFolder holds the computer's progress (the shared folder
 * unless a proof gives its own); adoptFrom is where this program kept its progress before; program is the name macOS
 * lists for this program's switch. hear and keepWords hear a recording on this computer and keep its words beside its
 * file (read-new-items.mjs); by default the first `hearing` row that runs here, looked for once, when first needed. see and
 * keepSeen read a picture on this computer (Apple Vision and the `visual_caption` model, never the account) and keep what
 * was seen beside its kept file; a file's `folder`, when it names one, replaces files_folder for that file.
 * Returns { tick, look, once, status, search, stop }.
 */
/**
 * Whether a piece this reader hosts (keepers, listener, offer) may run: the saved set of installed programs
 * (computer/program-host.mjs, written by the helper from what the account installed) names the program that piece is
 * (computer/mac-tools.json programs.reader.gates). With no saved set, the legacy set, or a file that cannot be read,
 * every piece runs, as it always did.
 */
export function installedGate({ settings = null, home = homedir(), read = readFileSync } = {}) {
  let rows = settings;
  try { rows ??= JSON.parse(read(join(HERE, 'mac-tools.json'), 'utf8')); } catch { return () => true; }
  const file = join(home, rows.program_host?.file ?? '.trillion/installed-programs.json');
  const gates = readerGates(rows);
  return piece => { const list = installedPrograms(file, read); return list === null || !gates[piece] || list.includes(gates[piece]); };
}
// A piece that is on at the start is made then; one that is off is made when it is first on, and a piece already
// running is not stopped here (only the helper stops programs).
const gatedPiece = (on, make, idle) => { let made = on() ? make() : null; return { look: (...args) => (on() ? (made ??= make()).look(...args) : idle) }; };
const hearingOnce = rows => { let row; return () => (row === undefined ? (row = hearingHere(rows.hearing ?? [])) : row); };
export function startReading({ rows = rowsOf(), key = null, origin, account = accountCaller(origin, key), keep = fileKeeper(account, rows.files_folder, { origin, key }), hearing = hearingOnce(rows), hear = async recording => { const row = hearing(); return row ? hearWith(row, recording) : null; }, keepWords = origin && key ? (identity, { produced_by: producedBy, ...value }) => resultsOver(bearerControl({ origin, authorization: async () => `Bearer ${key}` })).put(identity, value, producedBy ?? hearing()?.produced_by ?? 'this computer') : null, see = (picture, type, { caption = true, caption_timeout_seconds: timeout } = {}) => observeVisual(picture, type, { captionRow: rows.visual_caption, captionAlways: true, caption: rows.visual_caption && caption ? (pixels, words) => captionWith(timeout ? { ...rows.visual_caption, timeout_seconds: timeout } : rows.visual_caption, pixels, words) : null }), keepSeen = origin && key ? (identity, value) => resultsOver(bearerControl({ origin, authorization: async () => `Bearer ${key}` }), 'visual-observation').put(identity, value, 'Vision OCR on this Mac') : null, shared = sharedFolder(), stateFolder = shared, adoptFrom = null, program = programOf(), timers = true, log = line => process.stderr.write(`${line}\n`), doorOf = origin && key ? accountDoor({ origin, key }) : null, inputs = doorOf ? liveInputs({ lists: doorOf.lists, rows, cacheFile: join(stateFolder, 'inputs-cache.json'), log }) : null, readers = doorOf ? readersWith({ tool: serviceReader(doorOf.run) }) : undefined, look, gate = installedGate(), keepers = timers ? gatedPiece(() => gate('keepers'), () => startKeepers({ rows, key, origin, log }), []) : { look: () => [] }, listener = timers ? gatedPiece(() => gate('listener'), () => startListening({ rows, key, origin, log }), false) : { look: () => false }, offer = timers ? () => (gate('offer') ? offerInBrowsers({ stateFile: join(shared, 'offered-in-browsers.json'), log }) : []) : () => [] } = {}) {
  const lock = join(shared, 'reading.lock');
  // The places are the rows of the account's list `inputs` (inputs.mjs); the file's rows are only where the list starts.
  if (inputs) rows = { ...rows, sources: inputs.sources };
  adoptProgress(adoptFrom, stateFolder);
  const seed = readJson(join(stateFolder, 'computer-sources.json'))?.computer_id ?? null;
  const reading = readNewItems({ carriers: inputs ? inputs.carriers : rows.sources.filter(isRead).map(row => row.read), account, keep, stateFile: join(stateFolder, 'written-elsewhere.json'), workdir: join(stateFolder, 'written-elsewhere-previews'), hear, keepWords, see, keepSeen, longText: rows.long_text ?? null, ...(rows.turned_away ? { turnedAway: rows.turned_away } : {}), ...(rows.item_trouble ? { itemTrouble: rows.item_trouble } : {}), ...(rows.inputs?.warn_after_hours ? { warnAfterHours: rows.inputs.warn_after_hours } : {}), log, ...(readers ? { readers } : {}) });
  const finding = computerSources({ rows, account, stateFile: join(stateFolder, 'computer-sources.json'), workdir: join(stateFolder, 'computer-sources-work'), computerId: computerIdOf(join(shared, 'computer.json'), seed), program, carriers: () => reading.status(), connectionsUrl: origin ? `${origin.replace(/\/$/, '')}/connections` : null, log, ...(look ? { look } : {}) });
  let elsewhere = false;
  let busy = 0;
  const mine = () => {
    const held = holdReading(lock, process.pid, { program: programOf(), first: rows.readers_first ?? [], busy: busy > 0, reach: reachOf(rows) });
    if (held !== !elsewhere) { elsewhere = !held; log(held ? 'This computer: reading its places.' : 'This computer: another Trillion program is reading its places.'); }
    return held;
  };
  // A native messaging host follows its extension: written where a browser holds it, taken away where it no longer does.
  const follow = () => (timers && gate('offer') ? followPresence({ stateFile: join(stateFolder, 'followed-presence.json'), log }) : []);
  const whileBusy = async work => { busy += 1; try { return await work(); } finally { busy -= 1; } };
  // Each tick also starts a keeper for a drive plugged in since (keep-drive-files.mjs), and the listener while the
  // person has listening on (listen.mjs), only while this program reads, and only in a reader that keeps reading (a
  // one-look run starts neither).
  // Each tick also starts the first hearing program's one-time preparation when it is due (keep-drive-files.mjs
  // prepareHearing), so a Mac that can hear with it is ready before its first recording.
  const prepared = () => { const row = timers ? hearing() : null; if (!row) return null; try { return hearingState(row); } catch (error) { log(`Hearing: ${error.message}`); return null; } };
  const tick = async () => { if (mine()) { if (inputs) await inputs.refresh(); keepers.look(); listener.look(); prepared(); await whileBusy(() => reading.tick()); } };
  // Each look also puts Trillion's browser extensions where the browsers installed here will offer them
  // (offer-in-browsers.mjs), once per browser.
  const lookNow = async () => (mine() ? whileBusy(async () => { if (inputs) await inputs.refresh(); offer(); follow(); return finding.look(); }) : null);
  const handles = [], paced = [];
  if (timers) {
    handles.push(setTimeout(tick, 5_000), setTimeout(lookNow, 15_000));
    for (const handle of handles) handle.unref?.();
    // Both repeating looks keep their base pace from computer-sources.json and follow the computer's power and idleness
    // (pace.mjs): the same reader looks less often on a battery nobody is using.
    paced.push(pacedEvery(tick, rows.read_every_seconds, rows.pace), pacedEvery(lookNow, rows.every_seconds, rows.pace));
  }
  return {
    tick, look: lookNow,
    async once() { await tick(); return lookNow(); },
    status: () => ({ reading_here: !elsewhere, places: reading.status(), found: finding.status(), hearing: prepared() }),
    search: (...args) => reading.search(...args),
    stop() { for (const handle of handles) clearTimeout(handle); for (const pace of paced) pace.stop(); releaseReading(lock); },
  };
}

// As one of the helper's handlers (harness/wake-sessions.json `handlers`): it takes no events, and start({ key, origin, log })
// runs it beside the helper's connection for as long as the helper runs.
export const wants = () => false;
export const handle = () => null;
export const start = ({ key, origin, log }) => startReading({ key, origin, log });

async function keyFromStdin() { let text = ''; for await (const chunk of process.stdin) text += chunk; return text.trim(); }

const keepReading = process.argv.includes('--keep-reading');
if (process.argv[1] === fileURLToPath(import.meta.url) && (keepReading || process.argv.includes('--once'))) {
  const rows = rowsOf();
  const key = await keyFromStdin();
  // Started by the app: ends with it (computer/end-with-the-app.mjs).
  if (keepReading) endWithTheApp();
  const option = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
  const given = Object.fromEntries([['stateFolder', option('--state')], ['shared', option('--shared')]].filter(([, value]) => value));
  const reader = startReading({ key, rows, origin: process.env.TRILLION_ORIGIN ?? rows.origin, timers: keepReading, ...given });
  if (keepReading) {
    // Reads until it is told to stop or the program that started it is gone (its parent becomes another process),
    // and gives the reading lock back either way. The check below is also what keeps this process running.
    const parent = process.ppid;
    const end = () => { reader.stop(); process.exit(0); };
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, end);
    setInterval(() => { if (process.ppid !== parent) end(); }, 5_000);
  } else {
    await reader.once();
    process.stdout.write(`${JSON.stringify(reader.status())}\n`);
    reader.stop();
  }
}
