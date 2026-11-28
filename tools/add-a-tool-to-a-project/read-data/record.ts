// tools/add-a-tool-to-a-project/read-data/record.ts
//
// PURPOSE
//   Reads and writes a project's record of where each tool folder came from: the project's one where-each-tool-comes-
//   from.json, one line per copied folder, keyed by the folder's name. A line says where the copy lives in the project
//   (`at`), where it came from, the commit and files it started from (so a later sync can merge three ways), the folders it
//   needs beside it and the identity of the whole set it runs with (closure_blake3). The record sits wherever the project
//   keeps it, and each copy wherever its line's `at` says: no folder name is fixed (recordPlaceIn finds the record).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A write is a compare-and-set: it names the BLAKE3 of the record text it read, and is refused (RecordChanged) when the
//      live file is different. Inside one held lock the check, the folder moves and the record rename happen together.
//   2. The lock is one file made with O_EXCL beside the record; a lock left by a process that is gone is taken over.
//   3. The record is written to a temporary file in the same folder and renamed over the old one: never half-written.
//   4. Paths in a line's `files` are relative to the tool folder, and its `at` is relative to the project's top; no absolute
//      file path is stored, and neither climbs out (placeOf).
//   5. A project holds one record: two where-each-tool-comes-from.json files in a project are refused (TwoRecords), never
//      one picked.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, posix } from 'node:path';
import { fileDigest } from '../../content-identity/read-data/manifest.mjs';
import type { Hex64 } from './registry.ts';
import type { FileMap } from './fetch-folder.ts';

export const RECORD_FILE = 'where-each-tool-comes-from.json';
const LOCK_FILE = '.where-each-tool-comes-from.lock';
const WHAT = 'Where each copied tool folder of this project lives (at), where it came from and the exact files it started from, '
  + 'so sync can merge three ways. Written only by tool:add-a-tool-to-a-project and tool:keep-tool-copies-in-step.';

export type FromWhere = { registry: string; tool: string } | { repo: string; path: string; commit: string } | 'made-here';
export type ToolRecord = {
  /** The copy's folder, relative to the project's top (placeOf), e.g. "src/components/ui/ui". */
  at: string;
  from: FromWhere;
  synced: boolean;
  copied_at_commit?: string;
  copied_at_files_blake3?: Hex64;
  closure_blake3?: Hex64;
  needs_tools?: string[];
  files?: FileMap;
};
export type RecordFile = { _what: string; registry?: string; tools: Record<string, ToolRecord>; [other: string]: unknown };
export type ReadRecord = { expected: string; record: RecordFile };

/** Refused because the record changed between this run's read and its write. */
export class RecordChanged extends Error {}

/** Refused because a project holds more than one record, or a path to a place is not one inside the project. */
export class BadPlace extends Error {}

/**
 * A folder inside the project, relative to its top, as a line's `at` and an add's `into` name it: posix words with no
 * empty, `.` or `..` part, never absolute, never a backslash. '' is the project's top. Anything else is refused.
 */
export function placeOf(path: unknown, what: string): string {
  if (path === '' || path === '.') return '';
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.includes('\0')
    || !path.replace(/\/+$/, '').split('/').every(part => part !== '' && part !== '.' && part !== '..')) {
    throw new BadPlace(`${what} ${JSON.stringify(path)} is not a folder inside the project (no .., no leading /, no empty part).`);
  }
  return posix.normalize(path.replace(/\/+$/, ''));
}

/** The record's folder (relative to the project's top, '' for the top) among a project's file paths, or null when it has none. */
export function recordPlaceIn(paths: readonly string[]): string | null {
  const found = paths.filter(path => path === RECORD_FILE || path.endsWith(`/${RECORD_FILE}`));
  if (found.length > 1) throw new BadPlace(`The project holds ${found.length} records (${found.sort().join(', ')}); it keeps one.`);
  return found.length ? posix.dirname(found[0]).replace(/^\.$/, '') : null;
}

/** The record's folder in a project's working folder, from git's list of its files (tracked, and new ones not ignored). */
export function recordPlace(project: string): string | null {
  const done = spawnSync('git', ['-C', project, 'ls-files', '-z', '-c', '-o', '--exclude-standard'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 1 << 30 });
  if (done.error) throw done.error;
  if (done.status !== 0) throw new BadPlace(`${project} is not a git folder, so its record cannot be found: ${done.stderr.toString('utf8').trim()}`);
  return recordPlaceIn([...new Set(done.stdout.toString('utf8').split('\0').filter(Boolean))]);
}

/** The paths entries a project's TypeScript settings give so `trillion-workshop/tools/<name>/...` imports reach each copy. */
export function importMapOf(record: RecordFile): Record<string, string[]> {
  return Object.fromEntries(Object.entries(record.tools).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([name, line]) => [`trillion-workshop/tools/${name}/*`, [`./${line.at ? `${line.at}/` : ''}*`]]));
}

const ABSENT = 'absent';
const identityOfText = (text: string | null): string => text === null ? ABSENT : fileDigest(new TextEncoder().encode(text));
const liveText = (file: string): string | null => existsSync(file) ? readFileSync(file, 'utf8') : null;

/** The record (an empty one when the project has none yet) and the identity of the text it was read from. */
export function readProjectRecord(folder: string): ReadRecord {
  const text = liveText(join(folder, RECORD_FILE));
  if (text === null) return { expected: ABSENT, record: { _what: WHAT, tools: {} } };
  const record = JSON.parse(text) as RecordFile;
  if (record === null || typeof record !== 'object' || typeof record.tools !== 'object' || record.tools === null) {
    throw new Error(`${join(folder, RECORD_FILE)} has no tools object.`);
  }
  return { expected: identityOfText(text), record };
}

/** The record's text: keys of `tools` in byte order, two-space JSON, one closing newline. */
function recordText(record: RecordFile): string {
  const tools = Object.fromEntries(Object.entries(record.tools).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  return `${JSON.stringify({ ...record, _what: record._what ?? WHAT, tools }, null, 2)}\n`;
}

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Holds the record's lock while `work` runs; a lock whose maker is gone is taken over. */
function withLock<T>(folder: string, work: () => T): T {
  const lock = join(folder, LOCK_FILE);
  let handle: number | null = null;
  for (let attempt = 0; handle === null; attempt += 1) {
    try {
      handle = openSync(lock, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw new RecordChanged(`Another add holds ${lock}.`);
      // A lock whose maker has not yet written its process is held, never taken over.
      let holder: number;
      try { holder = Number(JSON.parse(readFileSync(lock, 'utf8')).pid); } catch { throw new RecordChanged(`Another add holds ${lock}.`); }
      if (!Number.isInteger(holder) || processAlive(holder)) throw new RecordChanged(`Another add (process ${holder}) holds ${lock}.`);
      unlinkSync(lock);
    }
  }
  try {
    writeSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    closeSync(handle);
    return work();
  } finally {
    unlinkSync(lock);
  }
}

/**
 * Under the lock: checks the live record still has the identity `expected`, runs `place` (the folder moves), then writes
 * `record` over it by rename. Refused with RecordChanged, with nothing placed and nothing written, when the record moved.
 */
export function writeProjectRecord(folder: string, record: RecordFile, expected: string, place: () => void): void {
  withLock(folder, () => {
    const file = join(folder, RECORD_FILE);
    if (identityOfText(liveText(file)) !== expected) throw new RecordChanged(`${file} changed after this add read it.`);
    place();
    const temporary = join(folder, `${RECORD_FILE}.${process.pid}.tmp`);
    writeFileSync(temporary, recordText(record));
    renameSync(temporary, file);
  });
}
