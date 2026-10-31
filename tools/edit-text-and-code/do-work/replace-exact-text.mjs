// tools/edit-text-and-code/do-work/replace-exact-text.mjs
//
// Purpose
//   Replace one exact run of text in a file inside a folder the person granted
//   for change, so a caller can change a line inside a large file without
//   holding the whole file.
//
// Non-negotiable invariants
//   - The text to find must occur EXACTLY ONCE. Zero occurrences is a refusal,
//     not a silent no-op, because a no-op reports success for a change that
//     never happened. More than one is a refusal because the caller cannot have
//     meant all of them without saying so.
//   - Byte comparison only. No regular expression, no normalisation, no
//     whitespace tolerance: a match that had to be guessed at can be wrong.
//   - Publication is an atomic same-folder rename after a full write, so a
//     failure never leaves a truncated file; if the file changed while the new
//     text was being written, nothing is published.
//   - Only a regular file, reached through no link, inside the granted folder,
//     and only text that is valid UTF-8 (a binary file is refused, not damaged).
//
// Run: node replace-exact-text.mjs <granted folder>   with { file, find, replace } on standard input.

import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export class Refusal extends Error {}

export function replaceExactlyOnce(text, find, replaceWith) {
  if (typeof find !== 'string' || find === '') throw new Refusal('the text to find may not be empty');
  if (typeof replaceWith !== 'string') throw new Refusal('replace must be text (it may be empty to remove the found text)');
  const first = text.indexOf(find);
  if (first === -1) throw new Refusal('the text to find does not occur in this file');
  if (text.indexOf(find, first + find.length) !== -1) {
    throw new Refusal('the text to find occurs more than once; include enough surrounding text to make it unique');
  }
  return text.slice(0, first) + replaceWith + text.slice(first + find.length);
}

// The granted folder's real path joined with the file's path, every part of which must be a plain
// directory or the regular file itself: a link anywhere on the way is refused rather than followed.
export async function fileInsideFolder(folder, file) {
  if (typeof file !== 'string' || file === '') throw new Refusal('file must be a path inside the granted folder');
  if (isAbsolute(file)) throw new Refusal('file must be a path relative to the granted folder');
  const root = await realpath(resolve(folder));
  const target = resolve(root, file);
  const inside = relative(root, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Refusal('file leaves the granted folder');
  let walked = root;
  for (const part of inside.split(sep)) {
    walked = join(walked, part);
    let info;
    try { info = await lstat(walked); } catch { throw new Refusal(`${inside} does not exist in the granted folder`); }
    if (info.isSymbolicLink()) throw new Refusal(`${inside} goes through a link, which is refused`);
  }
  if (!(await lstat(target)).isFile()) throw new Refusal(`${inside} is not a regular file`);
  return { target, inside };
}

export async function replaceInFile(folder, { file, find, replace }) {
  const { target, inside } = await fileInsideFolder(folder, file);
  const before = await stat(target);
  const bytes = await readFile(target);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Refusal(`${inside} is not valid UTF-8 text`);
  const next = replaceExactlyOnce(text, find, replace);
  const staged = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.staged`);
  const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, before.mode & 0o777);
  try {
    await handle.writeFile(next, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const now = await stat(target);
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
      throw new Refusal(`${inside} changed while the edit was being prepared; nothing was written`);
    }
    await rename(staged, target);
  } catch (error) {
    await unlink(staged).catch(() => {});
    throw error;
  }
  const after = await stat(target);
  return { file: inside, bytes_before: before.size, bytes_after: after.size, replaced: 1 };
}

async function main() {
  const folder = process.argv[2];
  if (!folder) throw new Refusal('usage: replace-exact-text.mjs <granted folder>, with { file, find, replace } on standard input');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Refusal('standard input must be JSON: { file, find, replace }'); }
  const result = await replaceInFile(folder, request ?? {});
  process.stdout.write(`${JSON.stringify({ result })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    process.stdout.write(`${JSON.stringify({ error: error instanceof Refusal ? error.message : `could not edit: ${error.message}` })}\n`);
    process.exitCode = 1;
  });
}
