// tools/workflows/read-data/citation-resolvers.mjs
//
// Opens what a finding cites. A `cites-resolve` check (recipe-check-kinds.json) names a resolver row of
// citation-resolvers.json; the row says how to find citations in a text (`pattern`), which repositories they may name
// (`roots`, each a folder and the ref to read) and which of three ways of looking one up applies (`kind`):
//
//   file-line  <root>/<path>:<line>   the line of that file at the root's ref holds the item's quote (when the check names one)
//   commit     a commit hash          it exists in one of the roots and is dated after the item's `after` date
//   row        a row id               the row exists in the person's own records (read through the door)
//
//   resolveItem(check, item, { resolvers, door }) -> [{ cite, ok, why }]   ok is true, false, or null when the root is not
//                                                                          on this computer (cannot be judged here)
//
// Nothing here names a repository, a step or a field: the roots and patterns are DATA, the field names come from the check.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

const run = promisify(execFile);
export const RESOLVERS = JSON.parse(readFileSync(new URL('../citation-resolvers.json', import.meta.url), 'utf8'));
// A root's folder in the DATA may start with ~/ (the person's home), so the file names no one's home folder.
const folderOf = root => (root.folder.startsWith('~/') ? homedir() + root.folder.slice(1) : root.folder);
const squash = text => String(text).replace(/\s+/g, ' ').trim();
const git = (folder, ...args) => run('git', ['-C', folder, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }).then(done => done.stdout);

async function fileLine(row, cite, item, check) {
  const [, rootName, path, line] = new RegExp(row.pattern).exec(cite);
  const root = row.roots?.[rootName];
  if (!root) return { cite, ok: false, why: `no repository named ${rootName} in the resolver` };
  if (!existsSync(folderOf(root))) return { cite, ok: null, why: `${rootName} is not on this computer` };
  let text;
  try { text = await git(folderOf(root), 'show', `${root.ref ?? 'HEAD'}:${path}`); } catch { return { cite, ok: false, why: `${path} is not in ${rootName} at ${root.ref ?? 'HEAD'}` }; }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const at = Number(line);
  if (at < 1 || at > lines.length) return { cite, ok: false, why: `${path} has ${lines.length} lines, not ${at}` };
  const quote = check.quote === undefined ? null : item?.[check.quote];
  if (check.quote !== undefined && !(typeof quote === 'string' && squash(quote))) return { cite, ok: false, why: `the quote in ${check.quote} is missing` };
  if (quote !== null && !squash(lines[at - 1]).includes(squash(quote))) return { cite, ok: false, why: `line ${at} of ${path} does not hold the quoted text` };
  return { cite, ok: true };
}

async function commit(row, cite, item, check) {
  const after = check.after === undefined ? null : Date.parse(item?.[check.after]);
  if (check.after !== undefined && Number.isNaN(after)) return { cite, ok: false, why: `${check.after} is not a date` };
  let blind = 0;
  for (const root of Object.values(row.roots ?? {})) {
    if (!existsSync(folderOf(root))) { blind += 1; continue; }
    try {
      const when = Date.parse((await git(folderOf(root), 'show', '-s', '--format=%cI', `${cite}^{commit}`)).trim());
      return after !== null && !(when > after) ? { cite, ok: false, why: `commit is dated ${new Date(when).toISOString()}, not after ${new Date(after).toISOString()}` } : { cite, ok: true };
    } catch { /* not in this root */ }
  }
  return blind ? { cite, ok: null, why: 'a repository is not on this computer, so the commit cannot be ruled out' } : { cite, ok: false, why: 'no such commit in any root' };
}

async function rowExists(row, cite, _item, _check, door) {
  if (!door) return { cite, ok: null, why: 'no records door to look the row up in' };
  const type = row.type_of_id.map(source => new RegExp(source).exec(cite)?.[1]).find(Boolean) ?? cite.split(':')[0];
  return (await door.read(type, cite)) ? { cite, ok: true } : { cite, ok: false, why: 'no such row' };
}

const KINDS = { 'file-line': fileLine, commit, row: rowExists };

export async function resolveItem(check, item, { resolvers = RESOLVERS, door } = {}) {
  const row = resolvers.resolvers.find(entry => entry.resolver === check.resolver);
  if (!row) return [{ cite: check.resolver, ok: null, why: `no resolver named ${check.resolver}` }];
  const text = item?.[check.field];
  const cites = [...new Set(typeof text === 'string' ? [...text.matchAll(new RegExp(row.pattern, 'g'))].map(match => match[0]) : [])];
  return Promise.all(cites.map(cite => KINDS[row.kind](row, cite, item, check, door)));
}
