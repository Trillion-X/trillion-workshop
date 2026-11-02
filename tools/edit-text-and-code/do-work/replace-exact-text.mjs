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
//   - Several edits at once ({ edits: [{ file, find, replace }, ...] }) are all or
//     nothing: they apply in order (a later edit sees the text an earlier one
//     made in the same file), and if any one is refused, no file is written.
//
// Run: node replace-exact-text.mjs <granted folder> [edits.json]
//   with { file, find, replace } or { edits: [...] } on standard input, or in the JSON file named after the folder.

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

async function readText(folder, file) {
  const { target, inside } = await fileInsideFolder(folder, file);
  const before = await stat(target);
  const bytes = await readFile(target);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Refusal(`${inside} is not valid UTF-8 text`);
  return { target, inside, before, text };
}

async function stage(target, mode, next) {
  const staged = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.staged`);
  const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode & 0o777);
  try {
    await handle.writeFile(next, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return staged;
}

// Every staged file is written before any is published, and none is published if any of the files changed meanwhile.
async function publish(files) {
  const staged = [];
  try {
    for (const f of files) staged.push(await stage(f.target, f.before.mode, f.text));
    for (const f of files) {
      const now = await stat(f.target);
      if (now.mtimeMs !== f.before.mtimeMs || now.size !== f.before.size) {
        throw new Refusal(`${f.inside} changed while the edit was being prepared; nothing was written`);
      }
    }
  } catch (error) {
    await Promise.all(staged.map(path => unlink(path).catch(() => {})));
    throw error;
  }
  for (const [i, f] of files.entries()) await rename(staged[i], f.target);
}

export async function replaceInFile(folder, { file, find, replace }) {
  const read = await readText(folder, file);
  const next = { ...read, text: replaceExactlyOnce(read.text, find, replace) };
  await publish([next]);
  const after = await stat(read.target);
  return { file: read.inside, bytes_before: read.before.size, bytes_after: after.size, replaced: 1 };
}

// Several edits, in order, all or nothing. Each refusal names the edit by its place in the list.
export async function replaceInFiles(folder, edits) {
  if (!Array.isArray(edits) || edits.length === 0) throw new Refusal('edits must be a list of at least one { file, find, replace }');
  const files = new Map();
  const counts = new Map();
  for (const [i, edit] of edits.entries()) {
    try {
      if (!edit || typeof edit !== 'object') throw new Refusal('must be { file, find, replace }');
      const { target } = await fileInsideFolder(folder, edit.file);
      if (!files.has(target)) files.set(target, await readText(folder, edit.file));
      const f = files.get(target);
      f.text = replaceExactlyOnce(f.text, edit.find, edit.replace);
      counts.set(target, (counts.get(target) ?? 0) + 1);
    } catch (error) {
      if (error instanceof Refusal) throw new Refusal(`edit ${i}${edit?.file ? ` in ${edit.file}` : ''}: ${error.message}; nothing was written`);
      throw error;
    }
  }
  await publish([...files.values()]);
  const changed = [];
  for (const f of files.values()) {
    changed.push({ file: f.inside, bytes_before: f.before.size, bytes_after: (await stat(f.target)).size, replaced: counts.get(f.target) });
  }
  return { files: changed, replaced: edits.length };
}

async function main() {
  const [folder, editsFile] = process.argv.slice(2);
  if (!folder) throw new Refusal('usage: replace-exact-text.mjs <granted folder> [edits.json], with { file, find, replace } or { edits: [...] } on standard input or in the file');
  let raw;
  if (editsFile) {
    try { raw = await readFile(editsFile); } catch { throw new Refusal(`cannot read the edits file ${editsFile}`); }
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    raw = Buffer.concat(chunks);
  }
  let request;
  try { request = JSON.parse(raw.toString('utf8')); } catch { throw new Refusal('the request must be JSON: { file, find, replace } or { edits: [{ file, find, replace }, ...] }'); }
  const edits = Array.isArray(request) ? request : request?.edits;
  const result = edits !== undefined ? await replaceInFiles(folder, edits) : await replaceInFile(folder, request ?? {});
  process.stdout.write(`${JSON.stringify({ result })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    process.stdout.write(`${JSON.stringify({ error: error instanceof Refusal ? error.message : `could not edit: ${error.message}` })}\n`);
    process.exitCode = 1;
  });
}
