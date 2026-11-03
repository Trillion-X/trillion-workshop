// tools/drive-the-screen/read-data/helper-sandbox.mjs
//
// PURPOSE
//   Starts a native helper that works on content it did not make under a deny-default macOS Seatbelt profile, so a hostile
//   file that reaches the helper's decoder can read nothing of the person's and reach no network. Each helper's profile,
//   what it holds and what it does not are DATA (tools/drive-the-screen/read-data/helper-sandbox.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file names no helper and no path: the helpers, their allowed operations and their words are the DATA.
//   2. A helper with no row, or a Mac without the sandbox program, is refused. It is never run unconfined by default.
//   3. `enabled: false` on a row is the person's own switch for that helper and runs it as before.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const helperSettings = () => JSON.parse(readFileSync(join(HERE, 'helper-sandbox.json'), 'utf8'));

/** The profile text for one helper: deny default, then exactly its allow rows, `{here}` filled with the real path of `here`. */
export function profileOf(id, { settings = helperSettings(), here = HERE } = {}) {
  const row = settings.helpers[id];
  if (!row) throw new Error(`No sandbox profile is kept for the helper ${id}. It was not run.`);
  const folder = realpathSync(here);
  if (/["\\\n]/.test(folder)) throw new Error('The helper folder holds a character a sandbox rule cannot hold. It was not run.');
  return ['(version 1)', '(deny default)', ...row.allow.map(line => line.replaceAll('{here}', folder))].join('\n');
}

/** The program and arguments to start: the helper's own command under its profile, or the command itself when the row is switched off. */
export function confined(id, program, args, { settings = helperSettings(), here = HERE, exists = existsSync } = {}) {
  const row = settings.helpers[id];
  if (!row) throw new Error(`No sandbox profile is kept for the helper ${id}. It was not run.`);
  if (row.enabled === false) return { program, args };
  if (!exists(settings.program)) throw new Error(`This Mac has no ${settings.program}, so ${id} was not run unconfined.`);
  return { program: settings.program, args: ['-p', profileOf(id, { settings, here }), program, ...args] };
}
