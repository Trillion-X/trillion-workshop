// tools/workflows/read-data/citation-resolvers.mjs
//
// Opens what a finding cites. A `cites-resolve` check (recipe-check-kinds.json) names a resolver row of
// citation-resolvers.json; the row says how to find citations in a text (`pattern`), which repositories they may name
// (`roots`, each a folder and the ref to read) and which of two ways of looking one up applies (`kind`):
//
//   file-line  <root>/<path>:<line>   the line of that file (a checkout at the root's ref, or the copy in the person's files) holds the item's quote (when the check names one)
//   commit     a commit hash          it exists in one of the roots and is dated after the item's `after` date
//
//   resolveItem(check, item, { resolvers, files }) -> [{ cite, ok, why }]   ok is true, false, or null when the root is not
//                                                                           on this computer (cannot be judged here)
//
// `files` is the person's files the caller read from where it keeps them and handed in ({ <name>: text | { text } |
// { base64 } | null }); a copy folder is read only from those, and a file not handed in cannot be judged.
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
const folderOf = source => (source.folder.startsWith('~/') ? homedir() + source.folder.slice(1) : source.folder);
const squash = text => String(text).replace(/\s+/g, ' ').trim();
// The text of a file handed in, or undefined when it was not handed in or handed in as not there.
const textOfHeld = held => (held === null || held === undefined ? undefined
  : typeof held === 'string' ? held
  : held.text !== undefined ? String(held.text) : Buffer.from(String(held.base64 ?? ''), 'base64').toString('utf8'));
const git = (folder, ...args) => run('git', ['-C', folder, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }).then(done => done.stdout);

// One root's source as it can be read here: a checkout read with git at its ref, or the person's own files holding a copy
// (read from the files handed in). `sources` are tried in the order the DATA lists them; the first one present answers.
//   { name, readFile(path) -> text | null | undefined, commitDate(hash) -> ISO date | null | undefined }   null: not there; undefined: cannot say
async function sourceOf(rootName, root, files) {
  for (const source of root.sources ?? []) {
    if (source.folder) {
      const folder = folderOf(source);
      if (!existsSync(folder)) continue;
      return {
        name: `${rootName} at ${source.ref ?? 'HEAD'}`,
        // The head a verdict is judged against: the commit the ref names now (a checkout is live), so a verdict says what it saw.
        head: async () => git(folder, 'rev-parse', '--short=12', `${source.ref ?? 'HEAD'}^{commit}`).then(out => out.trim(), () => null),
        readFile: async path => git(folder, 'show', `${source.ref ?? 'HEAD'}:${path}`).catch(() => null),
        // A citation pinned to a commit (file:line@commit) reads the file as that commit holds it; null: not there at that commit.
        readAt: async (commitId, path) => git(folder, 'show', `${commitId}:${path}`).catch(() => null),
        commitDate: async hash => git(folder, 'show', '-s', '--format=%cI', `${hash}^{commit}`).then(out => out.trim(), () => null),
      };
    }
    if (source.files && files) {
      const at = `${source.files.replace(/\/$/, '')}/`;
      // The text of one file of the copy; undefined when it was not handed in.
      const readText = async name => textOfHeld(files[name]);
      const stampText = await readText(`${at}.source-copy.json`);
      if (typeof stampText !== 'string') continue;
      // A stamp that is not JSON is no stamp: the copy cannot say what it was made from, so the next source answers.
      let stamp;
      try { stamp = JSON.parse(stampText); } catch { continue; }
      // The paths the copy holds (`files`) and whether that is every tracked file (`complete`), when the writer recorded them.
      const held = Array.isArray(stamp?.files) ? new Set(stamp.files) : null;
      return {
        name: `${rootName} (the copy in ${source.files})`,
        // The head the copy was made from, as the copy's own stamp records it (null when the stamp holds none: an unstamped copy).
        head: async () => stamp?.head ?? null,
        // text; null: the copy says the file is not in the repository; undefined: the copy cannot say (not held, or not handed in)
        readFile: async path => {
          if (held && !held.has(path)) return stamp.complete === true ? null : undefined;
          return readText(`${at}${path}`);
        },
        // A date from the copy's own .commit-dates.json; undefined (cannot say) when that file or the hash is missing, never "no such commit".
        commitDate: async hash => {
          const text = await readText(`${at}.commit-dates.json`);
          let dates;
          try { dates = JSON.parse(text ?? ''); } catch { return undefined; }
          const found = Object.keys(dates).find(full => full.startsWith(hash));
          return found ? dates[found] : undefined;
        },
      };
    }
  }
  return null;
}

// What a verdict names as the source it was judged against: the source and the head it held, or that its head is not recorded.
async function judgedAgainst(source) {
  const head = await source.head();
  return head ? `${source.name} at ${head}` : `${source.name}, head not recorded`;
}

async function fileLine(row, cite, item, check, { files }) {
  // A citation may name a line range (file:40-55) and a commit (@commit): then the file is read as that commit holds it.
  const [, rootName, path, line, endLine, pinned] = new RegExp(row.pattern).exec(cite);
  const root = row.roots?.[rootName];
  if (!root) return { cite, ok: false, why: `no repository named ${rootName} in the resolver` };
  if (path.split('/').some(part => part === '..' || part === '.' || part === '') || path.includes('\\')) return { cite, ok: false, why: `${path} is not a path inside ${rootName}` };
  const source = await sourceOf(rootName, root, files);
  if (!source) return { cite, ok: null, why: `${rootName} is not on this computer and no copy of it is in the files this run may read` };
  if (pinned && !source.readAt) return { cite, ok: null, why: `${rootName} has no source that can read ${path} at commit ${pinned}` };
  const text = pinned ? await source.readAt(pinned, path) : await source.readFile(path);
  if (text === undefined) return { cite, ok: null, why: `${path} could not be read from ${source.name}` };
  if (text === null) return { cite, ok: false, why: `${path} is not in ${pinned ? `${rootName} at commit ${pinned}` : source.name}` };
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const at = Number(line);
  const last = endLine === undefined ? at : Number(endLine);
  if (at < 1 || last < at || last > lines.length) return { cite, ok: false, why: `${path} has ${lines.length} lines, not ${last}` };
  const quote = check.quote === undefined ? null : item?.[check.quote];
  if (check.quote !== undefined && !(typeof quote === 'string' && squash(quote))) return { cite, ok: false, why: `the quote in ${check.quote} is missing` };
  const against = pinned ? `${source.name.split(' at ')[0]} at commit ${pinned}` : await judgedAgainst(source);
  if (quote !== null && !squash(lines.slice(at - 1, last).join(' ')).includes(squash(quote))) return { cite, ok: false, why: `line ${at}${last > at ? `-${last}` : ''} of ${path} does not hold the quoted text`, against };
  return { cite, ok: true, against };
}

async function commit(row, cite, item, check, { files }) {
  const after = check.after === undefined ? null : Date.parse(item?.[check.after]);
  if (check.after !== undefined && Number.isNaN(after)) return { cite, ok: false, why: `${check.after} is not a date` };
  let blind = 0;
  let unsure = 0;
  for (const [rootName, root] of Object.entries(row.roots ?? {})) {
    const source = await sourceOf(rootName, root, files);
    if (!source) { blind += 1; continue; }
    const found = await source.commitDate(cite);
    if (found === undefined) { unsure += 1; continue; }
    if (!found) continue;
    const when = Date.parse(found);
    const against = await judgedAgainst(source);
    return after !== null && !(when > after) ? { cite, ok: false, why: `commit is dated ${new Date(when).toISOString()}, not after ${new Date(after).toISOString()}`, against } : { cite, ok: true, against };
  }
  return blind || unsure ? { cite, ok: null, why: blind ? 'a repository has no source here, so the commit cannot be ruled out' : 'the copy of a repository holds no date for that commit, so it cannot be ruled out' } : { cite, ok: false, why: 'no such commit in any root' };
}

// A row a finding cites is in the person's own database, which the caller reads itself: no kind here looks it up.
const KINDS = { 'file-line': fileLine, commit };

export async function resolveItem(check, item, { resolvers = RESOLVERS, files } = {}) {
  const row = resolvers.resolvers.find(entry => entry.resolver === check.resolver);
  if (!row) return [{ cite: check.resolver, ok: null, why: `no resolver named ${check.resolver}` }];
  const text = item?.[check.field];
  const cites = [...new Set(typeof text === 'string' ? [...text.matchAll(new RegExp(row.pattern, 'g'))].map(match => match[0]) : [])];
  return Promise.all(cites.map(cite => KINDS[row.kind](row, cite, item, check, { files })));
}
