// tools/work-on-connected-drives/read-data/file-transfer.mjs
//
// Purpose: copy or move files and folders the person chose to one or more folders on connected drives, checked by
// content, pausable and stoppable at any moment.
//
// Two halves in one file:
//   - the worker, runTransfer({ stateDir }), run inside the tool's own run (the engine ends a run's every process when
//     it ends, so nothing is left running behind it):
//     <state>/job.json is the request { id, sources, destinations, mode: "copy" | "move", created_at }.
//     1. The first start plans it into <state>/plan.json: every file under every source, and for each source and
//        destination the name it gets there (its own name, or "<name> 2", "<name> 3" ... when that name is taken; a
//        folder source keeps its structure under its own name). A restart reuses the plan, so names never shift.
//     2. Each file is read once and written to every destination under "<name>.partial"; the BLAKE3 of the source's
//        bytes is taken while reading, each written copy is read back and must have the same BLAKE3, and only then is
//        the partial renamed to its name (with the source's modification time). A finished file is appended to
//        <state>/done.jsonl, so a stopped transfer continues from the next file.
//     3. mode "move": only after every copy of everything is verified, each source goes to the Trash (/usr/bin/trash,
//        recoverable). A move to one folder on the same drive is a rename and copies nothing.
//     Progress is rewritten atomically to <state>/progress.json:
//       { state, files_done, files_total, bytes_done, bytes_total, current, errors, updated_at }
//     state: planning | running | paused | stopped | finished | failed. <state>/worker.pid holds the running pid.
//     Between every chunk and every file it passes work-control.mjs's checkpoint: a pause holds there, a stop removes
//     the partial files, closes everything and exits.
//   - createTransfers({ folder }): the run's side. start() checks the request and runs the worker in <folder>/<id>
//     until it ends; list() reads every transfer's request, progress and whether its worker runs; restart(id) runs a
//     stopped one again.
//
// Invariants:
// - A source is never removed unless every one of its copies was verified by content.
// - Nothing is written under its final name before it is verified.
// - Identities are BLAKE3 (never SHA-256).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { blake3 } from '@noble/hashes/blake3.js';
import { WorkStopped, createCheckpoint, isAlive, readPid } from './work-control.mjs';
import { driveOf } from '../../connected-drives/read-data/drive-folder.mjs';

const CHUNK_BYTES = 8 * 1024 * 1024;
const PROGRESS_EVERY_MS = 500;
const MODES = new Set(['copy', 'move']);
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

async function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.partial`;
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2));
  await fsp.rename(temporary, file);
}

/** "<name> 2", "<name> 3" ... before the extension of a file, after the whole name of a folder; the first free one. */
export async function freeName(folder, name, isFolder, taken = new Set()) {
  const dot = isFolder ? -1 : name.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let copy = 1; ; copy += 1) {
    const candidate = copy === 1 ? name : `${stem} ${copy}${extension}`;
    if (taken.has(path.join(folder, candidate))) continue;
    try { await fsp.lstat(path.join(folder, candidate)); } catch { return candidate; }
  }
}

async function filesUnder(root) {
  const files = [], folders = [];
  const visit = async (folder, relative) => {
    for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name), inside = path.join(relative, entry.name);
      if (entry.isDirectory()) { folders.push(inside); await visit(full, inside); }
      else if (entry.isFile()) files.push({ source: full, relative: inside, bytes: (await fsp.lstat(full)).size });
    }
  };
  await visit(root, '');
  return { files, folders };
}

export async function planTransfer(job) {
  const taken = new Set();
  const items = [];
  for (const source of job.sources) {
    const stat = await fsp.lstat(source);
    const isFolder = stat.isDirectory();
    const under = isFolder ? await filesUnder(source) : { files: [{ source, relative: '', bytes: stat.size }], folders: [] };
    const targets = [];
    for (const destination of job.destinations) {
      const name = await freeName(destination, path.basename(source), isFolder, taken);
      taken.add(path.join(destination, name));
      targets.push(path.join(destination, name));
    }
    const rename = job.mode === 'move' && job.destinations.length === 1 && (await fsp.stat(job.destinations[0])).dev === stat.dev;
    items.push({ source, is_folder: isFolder, targets, rename, folders: under.folders, files: under.files });
  }
  return { items };
}

const hashFile = async file => {
  const hash = blake3.create();
  for await (const chunk of fs.createReadStream(file, { highWaterMark: CHUNK_BYTES })) hash.update(chunk);
  return Buffer.from(hash.digest()).toString('hex');
};

const moveToTrash = file => new Promise((resolve, reject) => execFile('/usr/bin/trash', [file], error => error ? reject(new Error(`${path.basename(file)} could not be moved to the Trash.`)) : resolve()));

export async function runTransfer({ stateDir, pollMs = 500, trash = moveToTrash }) {
  const job = readJson(path.join(stateDir, 'job.json'));
  if (!job) throw new Error('This transfer has no request.');
  // What the transfer is, in words its progress card reads (computer/report-progress.json drive-transfer row), and the
  // worker's pid, so a card whose worker died says it stopped.
  const what = job.sources.length === 1 ? path.basename(job.sources[0]) : `${job.sources.length} items`;
  const progress = { state: 'planning', mode: job.mode, doing: job.mode === 'move' ? 'Moving' : 'Copying', what, to: job.destinations.map(folder => path.basename(folder)).join(', '), pid: process.pid, files_done: 0, files_total: 0, bytes_done: 0, bytes_total: 0, current: null, errors: [], updated_at: null };
  let writtenAt = 0;
  const write = async (force = false) => {
    if (!force && Date.now() - writtenAt < PROGRESS_EVERY_MS) return;
    writtenAt = Date.now();
    progress.updated_at = new Date().toISOString();
    await writeAtomic(path.join(stateDir, 'progress.json'), progress);
  };
  const pass = createCheckpoint(stateDir, { pollMs, onState: async state => { progress.state = state; await write(true); } });
  await write(true);
  const planFile = path.join(stateDir, 'plan.json');
  let plan = readJson(planFile);
  if (!plan) { plan = await planTransfer(job); await writeAtomic(planFile, plan); }
  const doneFile = path.join(stateDir, 'done.jsonl');
  const done = new Set((fs.existsSync(doneFile) ? fs.readFileSync(doneFile, 'utf8') : '').split('\n').filter(Boolean));
  const copies = plan.items.flatMap((item, index) => item.rename ? [] : item.files.map(file => ({ ...file, key: `${index}:${file.relative}`, targets: item.targets.map(target => path.join(target, file.relative)) })));
  progress.files_total = copies.length + plan.items.filter(item => item.rename).length;
  progress.bytes_total = copies.reduce((sum, file) => sum + file.bytes * file.targets.length, 0);
  for (const file of copies) if (done.has(file.key)) { progress.files_done += 1; progress.bytes_done += file.bytes * file.targets.length; }
  progress.state = 'running';
  await write(true);
  const partials = new Set();
  try {
    for (const item of plan.items) {
      await pass();
      if (item.rename) {
        if (!done.has(item.source)) {
          await fsp.rename(item.source, item.targets[0]);
          await fsp.appendFile(doneFile, `${item.source}\n`); done.add(item.source);
        }
        progress.files_done += 1;
        continue;
      }
      for (const target of item.targets) {
        if (item.is_folder) for (const folder of ['', ...item.folders]) await fsp.mkdir(path.join(target, folder), { recursive: true });
      }
    }
    for (const file of copies) {
      if (done.has(file.key)) continue;
      await pass();
      progress.current = file.source;
      const handles = [];
      const source = await fsp.open(file.source, 'r');
      const hash = blake3.create();
      try {
        for (const target of file.targets) { const partial = `${target}.partial`; partials.add(partial); handles.push(await fsp.open(partial, 'w')); }
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        for (let offset = 0; ;) {
          await pass();
          const { bytesRead } = await source.read(buffer, 0, CHUNK_BYTES, offset);
          if (!bytesRead) break;
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          await Promise.all(handles.map(handle => handle.write(chunk, 0, bytesRead)));
          offset += bytesRead;
          progress.bytes_done += bytesRead * handles.length;
          await write();
        }
      } finally {
        await source.close();
        await Promise.all(handles.map(handle => handle.close()));
      }
      const expected = Buffer.from(hash.digest()).toString('hex');
      const stat = await fsp.stat(file.source);
      for (const target of file.targets) {
        const partial = `${target}.partial`;
        if (await hashFile(partial) !== expected) {
          await fsp.rm(partial, { force: true }); partials.delete(partial);
          throw new Error(`The copy of ${path.basename(file.source)} did not match the original, so it was not kept.`);
        }
        await fsp.utimes(partial, stat.atime, stat.mtime);
        await fsp.rename(partial, target); partials.delete(partial);
      }
      await fsp.appendFile(doneFile, `${file.key}\n`); done.add(file.key);
      progress.files_done += 1;
      await write();
    }
    progress.current = null;
    if (job.mode === 'move') for (const item of plan.items) if (!item.rename) { await pass(); await trash(item.source); }
    progress.state = 'finished';
  } catch (error) {
    for (const partial of partials) await fsp.rm(partial, { force: true });
    if (error instanceof WorkStopped) progress.state = 'stopped';
    else { progress.state = 'failed'; progress.errors.push({ error: error.message, at: new Date().toISOString() }); }
  }
  progress.current = null;
  await write(true);
  return progress;
}

// ---- the server's side ----------------------------------------------------------------------------------------------

export function createTransfers({ folder, runWorker = runHere }) {
  const stateOf = id => path.join(folder, id);

  async function validate({ sources, destinations, mode, devices }) {
    if (!MODES.has(mode)) throw Object.assign(new Error('Choose copy or move.'), { status: 400 });
    if (!Array.isArray(sources) || !sources.length || !Array.isArray(destinations) || !destinations.length) throw Object.assign(new Error('Choose what to copy and where it goes.'), { status: 400 });
    const realSources = [], realDestinations = [];
    for (const source of sources) {
      const found = await driveOf(source, devices);
      if (!found) throw Object.assign(new Error(`${path.basename(String(source))} is not on a connected drive.`), { status: 403 });
      realSources.push(found.real);
    }
    for (const destination of destinations) {
      const found = await driveOf(destination, devices);
      if (!found) throw Object.assign(new Error(`${path.basename(String(destination))} is not a folder on a connected drive.`), { status: 403 });
      if (!(await fsp.stat(found.real)).isDirectory()) throw Object.assign(new Error(`${path.basename(found.real)} is a file, not a folder.`), { status: 400 });
      realDestinations.push(found.real);
    }
    for (const source of realSources) for (const destination of realDestinations) {
      if (destination === source || destination.startsWith(source + path.sep)) throw Object.assign(new Error('A folder cannot be copied into itself.'), { status: 400 });
      if (mode === 'move' && path.dirname(source) === destination) throw Object.assign(new Error(`${path.basename(source)} is already in that folder.`), { status: 400 });
    }
    return { sources: realSources, destinations: realDestinations, mode };
  }

  async function preview(input) {
    const checked = await validate(input);
    return { ready: true, ...checked };
  }

  async function start(input) {
    const { sources: realSources, destinations: realDestinations, mode } = await validate(input);
    const id = crypto.randomUUID();
    await fsp.mkdir(stateOf(id), { recursive: true });
    await writeAtomic(path.join(stateOf(id), 'job.json'), { id, sources: realSources, destinations: realDestinations, mode, created_at: new Date().toISOString() });
    return { id, ...(await runWorker(stateOf(id))) };
  }

  function list() {
    let ids = [];
    try { ids = fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch {}
    return ids.map(id => {
      const stateDir = stateOf(id), job = readJson(path.join(stateDir, 'job.json'));
      if (!job) return null;
      return { id, stateDir, job, progress: readJson(path.join(stateDir, 'progress.json')), running: isAlive(readPid(stateDir, 'worker.pid')) };
    }).filter(Boolean);
  }

  async function restart(id) {
    const transfer = list().find(row => row.id === id);
    if (!transfer || transfer.running || ['finished'].includes(transfer.progress?.state)) return false;
    await runWorker(transfer.stateDir);
    return true;
  }

  return { start, preview, list, restart };
}

// The worker inside this run, its pid kept in <state>/worker.pid while it works so list() reads it as running.
async function runHere(stateDir) {
  const pidFile = path.join(stateDir, 'worker.pid');
  await fsp.writeFile(pidFile, String(process.pid));
  try { return await runTransfer({ stateDir }); } finally { await fsp.rm(pidFile, { force: true }); }
}
