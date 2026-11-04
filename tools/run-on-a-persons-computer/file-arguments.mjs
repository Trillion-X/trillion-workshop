// computer/file-arguments.mjs
//
// Purpose
//   Late-binding file arguments: a tool call's input may name a file instead of carrying its bytes. This Mac reads the
//   file at the tool boundary (computer/mac-tools.mjs runHere) and puts the text or base64 in the name's place, so a
//   large file never enters the AI's context or the account's payload.
//
// Non-negotiable invariants
//   1. What a name looks like, which folders it may point into, which files are never named and the byte cap are DATA
//      (computer/file-arguments.json); this file names no tool, folder or prefix.
//   2. The path is resolved to its real location before anything is read: a name through a link that leads outside every
//      root, or any segment or extension the data protects, is refused. A refusal reads nothing.
//   3. The cap bounds all the files of one call together, checked from each file's size before it is read.
//   4. Only a string value that starts with a prefix is touched; keys, numbers and every other string pass unchanged,
//      and the input given is never modified (a copy comes back).
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const fileArgumentSettings = () => JSON.parse(readFileSync(join(HERE, 'file-arguments.json'), 'utf8'));

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (settings, key, values, status = 422) => Object.assign(new Error(fill(settings.words[key], values)), { status });
const within = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * input with every file name in it replaced by the file's text or base64.
 * → { input, files, bytes } (files: the real paths read, bytes: the total read)
 */
export async function expandFileArguments(input, settings = fileArgumentSettings(), home = homedir()) {
  const found = [];
  const walk = value => {
    if (typeof value === 'string') { const row = settings.prefixes.find(item => value.startsWith(item.prefix)); if (row) found.push({ value, row }); return; }
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(input);
  if (!found.length) return { input, files: [], bytes: 0 };

  const roots = [];
  for (const root of settings.roots) roots.push(await realpath(root.replace(/^~(?=\/|$)/, home)).catch(() => null));
  const protectedNames = new Set(settings.protected_names.map(name => name.toLowerCase()));
  const protectedExtensions = settings.protected_extensions.map(name => name.toLowerCase());
  const loaded = new Map();
  const byFile = new Map();
  let bytes = 0;

  for (const { value, row } of found) {
    if (loaded.has(value)) continue;
    const reference = value.slice(0, 200);
    const asked = value.slice(row.prefix.length).replace(/^~(?=\/|$)/, home);
    if (!asked.startsWith('/')) throw refusal(settings, 'not_absolute', { reference });
    const real = await realpath(asked).catch(() => null);
    if (real === null) throw refusal(settings, 'missing', { reference }, 404);
    // Protected names are judged on the name asked and on where it really leads, so a link cannot hide one.
    const segments = [...asked.split('/'), ...real.split('/')].map(name => name.toLowerCase());
    if (segments.some(name => protectedNames.has(name)) || protectedExtensions.some(end => basename(real).toLowerCase().endsWith(end))) throw refusal(settings, 'protected', { reference }, 403);
    if (!roots.some(root => root !== null && within(root, real))) throw refusal(settings, 'outside_roots', { reference }, 403);
    const again = byFile.get(`${row.as}:${real}`);
    if (again) { loaded.set(value, again); continue; }
    const facts = await stat(real);
    if (!facts.isFile()) throw refusal(settings, 'missing', { reference }, 404);
    bytes += facts.size;
    if (bytes > settings.max_bytes) throw refusal(settings, 'too_big', { reference, limit: settings.max_bytes }, 413);
    const data = await readFile(real);
    let content;
    if (row.as === 'base64') content = data.toString('base64');
    else {
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw refusal(settings, 'not_text', { reference }); }
    }
    const file = { content, real };
    byFile.set(`${row.as}:${real}`, file);
    loaded.set(value, file);
  }

  const replace = value => {
    if (typeof value === 'string') return loaded.has(value) ? loaded.get(value).content : value;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  return { input: replace(input), files: [...byFile.values()].map(item => item.real), bytes };
}
