// tools/read-other-ais-setups/read-data/ai-setups.mjs
//
// Purpose: lists, read only, the instruction, command and skill files other AIs keep on this Mac, each as an item the
// person (through their AI) can bring into Trillion as a saved instruction. The account side (agents.instructions with
// add_instructions) adds them without replacing anything.
//
// Non-negotiable invariants
//   1. Places, kinds, endings and bounds are DATA (read-data/ai-setups.json); this file names no AI.
//   2. Read only: nothing in those places is created, changed or removed.
//   3. Every file is read through the file-scope owner (read-data/file-arguments.mjs, carried from Trillion-X/trillion computer/file-arguments.mjs), so its roots, protected names,
//      links and size cap apply; a file it refuses is listed as unreadable with its reason, not skipped silently.
//   4. An item's text is cut at most_chars_per_item characters (code points) and says it was cut.
import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandFileArguments } from './file-arguments.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const aiSetupSettings = () => JSON.parse(readFileSync(join(HERE, 'ai-setups.json'), 'utf8'));
/** A place's path segments joined, with `~` as the home folder read at run time. */
const expand = (parts, home) => join(...parts.map(part => (part === '~' ? home : part)));
const idOf = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const isFile = async path => { try { return (await stat(path)).isFile(); } catch { return false; } };

async function candidates(source, home) {
  if (source.files) {
    const found = [];
    for (const file of source.files) { const path = expand(file, home); if (await isFile(path)) found.push({ path, name: basename(path, extname(path)) }); }
    return found;
  }
  const folder = expand(source.folder, home);
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    if (source.entry) {
      const path = join(folder, entry.name, source.entry);
      if ((entry.isDirectory() || entry.isSymbolicLink()) && await isFile(path)) found.push({ path, name: entry.name });
    } else if ((entry.isFile() || entry.isSymbolicLink()) && (source.endings ?? []).some(ending => entry.name.endsWith(ending))) {
      found.push({ path: join(folder, entry.name), name: basename(entry.name, extname(entry.name)) });
    }
  }
  return found;
}

/** → { items: [{ id, source, kind, name, path, text, cut } | { ..., unreadable }], sources: { id: count } } */
export async function readAiSetups(input = {}, { settings = aiSetupSettings(), home = homedir(), scope } = {}) {
  const wanted = Array.isArray(input.sources) && input.sources.length ? new Set(input.sources) : null;
  const items = [], counts = {};
  for (const source of settings.sources.filter(row => !wanted || wanted.has(row.id))) {
    counts[source.id] = 0;
    for (const found of await candidates(source, home)) {
      if (items.length >= settings.most_items) break;
      const item = { id: `${source.id}-${idOf(found.name) || 'item'}`, source: source.id, kind: source.kind, name: found.name.slice(0, settings.label_chars), path: found.path };
      try {
        const { input: read } = await expandFileArguments({ text: `$file:${found.path}` }, scope, home);
        const points = Array.from(read.text);
        items.push({ ...item, text: points.slice(0, settings.most_chars_per_item).join(''), cut: points.length > settings.most_chars_per_item });
      } catch (error) { items.push({ ...item, unreadable: String(error.message ?? error) }); }
      counts[source.id] += 1;
    }
  }
  return { items, sources: counts };
}

/** tool:read-ai-setups, run by tools/records-door run-an-export.mjs as read(input). */
export const aiSetupTools = { async read(input) { return readAiSetups(input); } };
export const { read } = aiSetupTools;
