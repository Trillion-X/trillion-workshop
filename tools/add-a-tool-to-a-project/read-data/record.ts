// tools/add-a-tool-to-a-project/read-data/record.ts
//
// PURPOSE
//   Reads and writes a project's record of where each tool folder came from: `<project>/trillion/where-each-tool-comes-
//   from.json`, one line per folder under `trillion/`, keyed by the folder's name. A line says where the folder came from,
//   the commit and files it started from (so a later sync can merge three ways), the folders it needs beside it and the
//   identity of the whole set it runs with (closure_blake3).
//
// NON-NEGOTIABLE INVARIANTS
//   1. A write is a compare-and-set: it names the BLAKE3 of the record text it read, and is refused (RecordChanged) when the
//      live file is different. Inside one held lock the check, the folder moves and the record rename happen together.
//   2. The lock is one file made with O_EXCL beside the record; a lock left by a process that is gone is taken over.
//   3. The record is written to a temporary file in the same folder and renamed over the old one: never half-written.
//   4. Paths in a line's `files` are relative to the tool folder; no absolute file path is stored.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileDigest } from '../../content-identity/read-data/manifest.mjs';
import type { Hex64 } from './registry.ts';
import type { FileMap } from './fetch-folder.ts';

export const RECORD_FILE = 'where-each-tool-comes-from.json';
const LOCK_FILE = '.where-each-tool-comes-from.lock';
const WHAT = 'Where each tool folder in trillion/ came from and the exact files it started from, so sync can merge three ways. '
  + 'Written only by tool:add-a-tool-to-a-project and tool:keep-tool-copies-in-step.';

export type FromWhere = { registry: string; tool: string } | { repo: string; path: string; commit: string } | 'made-here';
export type ToolRecord = {
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

const ABSENT = 'absent';
const identityOfText = (text: string | null): string => text === null ? ABSENT : fileDigest(new TextEncoder().encode(text));
const liveText = (file: string): string | null => existsSync(file) ? readFileSync(file, 'utf8') : null;

/** The record (an empty one when the project has none yet) and the identity of the text it was read from. */
export function readProjectRecord(trillion: string): ReadRecord {
  const text = liveText(join(trillion, RECORD_FILE));
  if (text === null) return { expected: ABSENT, record: { _what: WHAT, tools: {} } };
  const record = JSON.parse(text) as RecordFile;
  if (record === null || typeof record !== 'object' || typeof record.tools !== 'object' || record.tools === null) {
    throw new Error(`${join(trillion, RECORD_FILE)} has no tools object.`);
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
function withLock<T>(trillion: string, work: () => T): T {
  const lock = join(trillion, LOCK_FILE);
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
export function writeProjectRecord(trillion: string, record: RecordFile, expected: string, place: () => void): void {
  withLock(trillion, () => {
    const file = join(trillion, RECORD_FILE);
    if (identityOfText(liveText(file)) !== expected) throw new RecordChanged(`${file} changed after this add read it.`);
    place();
    const temporary = join(trillion, `${RECORD_FILE}.${process.pid}.tmp`);
    writeFileSync(temporary, recordText(record));
    renameSync(temporary, file);
  });
}
