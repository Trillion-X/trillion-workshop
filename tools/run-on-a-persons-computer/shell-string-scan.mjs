// computer/shell-string-scan.mjs
//
// Purpose
//   The release check for a mechanism REA found in another product: words supplied by a page (or a model, or a person)
//   joined into one command string that a shell then runs. Trillion's helpers are called with argument arrays; this
//   scanner keeps it so. It reads the folders named in computer/shell-string-scan.json and reports every place that
//   builds a shell command string, so a new one fails the test that imports this file (test/shell-string-scan.test.mjs),
//   which every release road that ships these folders runs (scripts/release-roads.json `tests_importing`).
//
// Non-negotiable invariants
//   1. What is refused, which folders are read and every exception are DATA (shell-string-scan.json); this file names none.
//   2. An exception names its file and why a hit there is safe; scanning reports an exception with no reason as a hit.
//   3. Reading is local and read-only; nothing is run.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const shellStringSettings = () => JSON.parse(readFileSync(join(HERE, 'shell-string-scan.json'), 'utf8'));

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** The hits in one file: [{ path, line, rule, say }]. `settings` is shell-string-scan.json. */
export function scanText(path, text, settings) {
  const extension = extname(path);
  const allowed = settings.allowed.find(row => row.file === path && typeof row.because === 'string' && row.because.trim() !== '');
  if (allowed) return [];
  const hits = [];
  for (const rule of settings.rules) {
    if (!rule.files.includes(extension)) continue;
    if (rule.only_when_file_matches && !new RegExp(rule.only_when_file_matches, 'm').test(text)) continue;
    for (const match of text.matchAll(new RegExp(rule.pattern, 'gm'))) hits.push({ path, line: lineOf(text, match.index), rule: rule.id, say: rule.say });
  }
  return hits;
}

function filesUnder(folder, settings) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return settings.skip_folders.includes(entry.name) ? [] : filesUnder(join(folder, entry.name), settings);
    return entry.isFile() && settings.extensions.includes(extname(entry.name)) && !/\.(test|spec)\./.test(entry.name) ? [join(folder, entry.name)] : [];
  });
}

/** Every hit under the repository `root`, by the DATA's roots. */
export function scanTree(root, settings = shellStringSettings()) {
  const hits = [];
  for (const top of settings.roots) {
    let files;
    try { files = filesUnder(join(root, top), settings); } catch { continue; }
    for (const file of files) hits.push(...scanText(relative(root, file), readFileSync(file, 'utf8'), settings));
  }
  return hits;
}
