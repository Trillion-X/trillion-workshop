// computer/own-writes.mjs
//
// Purpose
//   A file Trillion's own work writes into a folder this Mac is also reading for new things (computer/read-new-items.mjs
//   folder places) would come back as something the person made, and start the next round of the same work. A writer
//   notes the path here when it finishes; the folder read passes over a path noted within the DATA's time.
//
// Non-negotiable invariants
//   1. The time a note lasts and the most paths kept are DATA (computer/own-writes.json); nothing here names a folder.
//   2. A note is for one real path (resolved from the folder's real location) and ends by itself; a path noted again
//      lasts from the later time.
//   3. The notes live in one file in the computer's shared folder (~/.trillion/computer-sources), because the folder
//      read runs in a fresh child process; the file is replaced whole (written beside it, then renamed), so a read
//      never sees half of it.
//   4. A file that cannot be read or written means nothing is suppressed; a change is then read as new, never lost.
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ownWriteSettings = () => JSON.parse(readFileSync(join(HERE, 'own-writes.json'), 'utf8'));
const fileOf = (settings, home) => join(home, '.trillion', 'computer-sources', settings.file);
const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };
const read = file => { try { const value = JSON.parse(readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };

/** Notes that Trillion's own work wrote `path` now. */
export function noteOwnWrite(path, { now = Date.now(), settings = ownWriteSettings(), home = homedir() } = {}) {
  const file = fileOf(settings, home);
  const kept = Object.fromEntries(Object.entries(read(file)).filter(([, until]) => until > now));
  kept[real(path)] = now + settings.ttl_seconds * 1000;
  const newest = Object.entries(kept).sort((a, b) => b[1] - a[1]).slice(0, settings.most_paths);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const beside = `${file}.${process.pid}.tmp`;
    writeFileSync(beside, JSON.stringify(Object.fromEntries(newest)), { mode: 0o600 });
    renameSync(beside, file);
  } catch { /* nothing is suppressed when the note cannot be kept */ }
}

/** Whether Trillion's own work wrote `path` within the time. */
export function isOwnWrite(path, { now = Date.now(), settings = ownWriteSettings(), home = homedir() } = {}) {
  return (read(fileOf(settings, home))[real(path)] ?? 0) > now;
}
