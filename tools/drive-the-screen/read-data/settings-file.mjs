// tools/drive-the-screen/read-data/settings-file.mjs (moved from Trillion-X/trillion computer/settings-file.mjs)
//
// Purpose: the one way this Mac's programs read and write a settings file the person may have edited. A file that cannot
// be understood is not the same as no file: the program runs on defaults, but it refuses to write until the file is
// fixed or moved aside, so defaults never silently replace what the person had.
//
// Non-negotiable invariants
//   1. `readSettingsFile` says one of: missing (no file; defaults are right), ok (value), degraded (why: unreadable,
//      not_a_regular_file, not_json, wrong_shape).
//   2. `writeSettingsFile` refuses a degraded file with a ParkedWrite (status 409) naming the file and why; it writes a
//      missing or ok file atomically (temp file in the same folder, mode 0600, then rename).
//   3. What counts as the right shape is the caller's `accept`; nothing here names a file or a program.
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class ParkedWrite extends Error {
  constructor(file, why) {
    super(`${file} could not be read (${why}), so nothing was written: writing would replace it with defaults.`);
    this.status = 409; this.file = file; this.why = why;
  }
}

export function readSettingsFile(file, { accept = () => true } = {}) {
  let stat;
  try { stat = lstatSync(file); } catch (error) { return error?.code === 'ENOENT' ? { state: 'missing' } : { state: 'degraded', why: 'unreadable' }; }
  if (!stat.isFile()) return { state: 'degraded', why: 'not_a_regular_file' };
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { state: 'degraded', why: 'unreadable' }; }
  let value;
  try { value = JSON.parse(text); } catch { return { state: 'degraded', why: 'not_json' }; }
  return accept(value) ? { state: 'ok', value } : { state: 'degraded', why: 'wrong_shape' };
}

export function writeSettingsFile(file, value, { accept = () => true } = {}) {
  const found = readSettingsFile(file, { accept });
  if (found.state === 'degraded') throw new ParkedWrite(file, found.why);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.next`;
  writeFileSync(next, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, file);
}
