// tools/add-a-tool-to-a-project/do-work/add.ts
//
// PURPOSE
//   tool:add-a-tool-to-a-project. Copies one tool folder, and every folder it needs, into a project, where the project
//   owns and edits it like any of its own code, at the place the project's own layout wants it. The pointer comes from a
//   registry (tools-in-this-registry.json: repo, folder, commit, files_blake3, needs_tools) or is given directly as {repo,
//   path, commit}. The files are fetched at the pinned commit, their identity is checked against the pointer, they are
//   written as `<project>/<into>/<folder>/`, one line per folder (its place as `at`) is written in the project's record
//   where-each-tool-comes-from.json with a compare-and-set, and each new folder's own `prepare` command (DATA in its card)
//   is run in it. The record is wherever the project keeps its one record file (read-data/record.ts recordPlace, from git's
//   list of the project's files); a project with none is given one at `record_at`, else at its top. `into` defaults to the
//   record's folder. A needed folder the record already names is found at its recorded `at`.
//
//   node do-work/add.ts add GRANTED-FOLDER   < {"project", "tool", "from"?, "as"?, "into"?, "record_at"?, "prepare"?, "clones"?}
//     prints {"added", "already", "refused", "prepared", "not_prepared", "import_map"} once; exits 1 when anything was
//     refused. import_map is the TypeScript paths entries that reach every recorded copy by its trillion-workshop/tools/
//     import name.
//
// NON-NEGOTIABLE INVARIANTS
//   1. All or nothing: when any folder of the set is refused, no folder is placed and the record is not written.
//   2. A folder's identity is the content-identity owner's manifest identity of its files at the commit; a registry pointer
//      whose identity differs is refused (identity-mismatch) and nothing is written.
//   3. A folder the project already holds is never overwritten: the same pointer is `already`; an edited copy is refused
//      with the diff; another version from the same source is refused (that is a sync); another source under the same
//      name is refused (name-clash) unless the asked tool is given another folder name with `as`.
//   4. The needs (needs_tools) are DATA: the registry pointer's list and the tool's card's list. The tool never reads a
//      tool's code. Needs that loop (A needs B, B needs A) copy each folder once.
//   5. What makes a folder ready (prepare) is DATA in the folder's card, run as words in the folder, never through a shell;
//      this file names no package ecosystem. Its outputs are never in the record: `files` holds only fetched files.
//   6. Writes stay inside the project, at each line's `at` and in the record's folder; the project must be inside the
//      granted folder; names and places never climb, are never absolute and never pass through a link (bad-place).
//   7. Each line's closure_blake3 is the manifest identity of {folder: files_blake3} over the folder and every folder it
//      reaches through needs_tools, so two computers holding the same closure announce the same identity.
//   8. A local clone named in `clones` (inside the granted folder) that already holds a pointer's commit is read instead
//      of the network (read-data/fetch-folder.ts); it is only read, and the files, their identity and the record are the
//      same bytes as a fetch gives.
//   9. The record holds no file path: a registry and a direct pointer's repo are recorded by an address every computer
//      can reach (read-data/registry.ts `addressOf`: a local folder is recorded as its git origin address, and one with
//      none is refused bad-from), and each folder's locator is its `at`, relative to the project's top.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigest, identityOfDigests } from '../../content-identity/read-data/manifest.mjs';
import { canonicalJson } from '../../content-identity/read-data/identity.mjs';
import { BadFrom, TOOL_NAME, addressOf, isInsidePath, readRegistry, type Hex64, type Registry } from '../read-data/registry.ts';
import { FetchedCommit, GitRefused, NotAtCommit, type Fetched } from '../read-data/fetch-folder.ts';
import { BadCard, OldCardName, cardFacts } from '../read-data/card.ts';
import { BadPlace, RecordChanged, importMapOf, placeOf, readProjectRecord, recordPlace, writeProjectRecord, type FromWhere, type RecordFile, type ToolRecord } from '../read-data/record.ts';
import { unifiedDiff } from '../read-data/diff-text.ts';

export type Direct = { repo: string; path: string; commit: string };
export type AddInput = { project: string; tool: string; from?: string | Direct; as?: string; into?: string; record_at?: string; prepare?: boolean; clones?: string[] };
export type Why = 'edited-copy' | 'other-version-present' | 'name-clash' | 'not-in-registry' | 'tool-not-found-at-commit'
  | 'identity-mismatch' | 'record-changed-meanwhile' | 'bad-from' | 'bad-card' | 'old-card-name' | 'fetch-refused' | 'bad-place';
export type Refusal = { tool: string; why: Why; said: string; diff?: string };
export type Added = { tool: string; commit: string; files: number; files_blake3: Hex64; closure_blake3: Hex64 };
export type AddOutput = { added: Added[]; already: string[]; refused: Refusal[]; prepared: string[]; not_prepared: Array<{ tool: string; said: string }>;
  /** When nothing was refused: the TypeScript paths entries for every recorded copy (read-data/record.ts importMapOf). */
  import_map?: Record<string, string[]> };

// One folder of the set being added: where it comes from and, when it is new, its fetched files and card facts.
type Wanted = { folder: string; from: Exclude<FromWhere, 'made-here'>; repo: string; path: string; commit: string;
  files_blake3: Hex64 | null; paths?: string[]; needs: string[] };
type Member = { folder: string; at: string; from: Exclude<FromWhere, 'made-here'>; commit: string; files_blake3: Hex64; needs: string[];
  fetched: Fetched | null; prepare: string[] | null };

const COMMIT = /^[0-9a-f]{40}$/;
const sameFrom = (a: FromWhere | undefined, b: FromWhere): boolean => a !== undefined && canonicalJson(a) === canonicalJson(b);

/** True when every file the record line names is on disk with the digest it names. */
function unedited(folder: string, line: ToolRecord): boolean {
  return Object.entries(line.files ?? {}).every(([path, digest]) => {
    const at = join(folder, path);
    return existsSync(at) && lstatSync(at).isFile() && fileDigest(readFileSync(at)) === digest;
  });
}

/** Writes fetched files under `into`, executable bits kept. */
function writeFolder(into: string, fetched: Fetched): void {
  for (const [path, bytes, executable] of fetched.files) {
    const at = join(into, ...path.split('/'));
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, bytes);
    if (executable) chmodSync(at, 0o755);
  }
}

/** The folders reachable from `start` through needs, `start` included. */
function reach(start: string, needsOf: Map<string, string[]>): string[] {
  const seen = new Set<string>();
  const walk = (folder: string): void => {
    if (seen.has(folder)) return;
    seen.add(folder);
    for (const need of needsOf.get(folder) ?? []) walk(need);
  };
  walk(start);
  return [...seen];
}

/** Needs first, then the folder: the order prepare runs in (a loop is broken where it is first met). */
function needsFirst(start: string, needsOf: Map<string, string[]>): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const walk = (folder: string): void => {
    if (seen.has(folder)) return;
    seen.add(folder);
    for (const need of needsOf.get(folder) ?? []) walk(need);
    order.push(folder);
  };
  walk(start);
  return order;
}

const refusedOnly = (refused: Refusal[], already: string[] = []): AddOutput => ({ added: [], already, refused, prepared: [], not_prepared: [] });

/** Refused when a place's folders, as far as they exist, hold a link or a file: a copy is never written through one. */
function noLinkOnTheWay(project: string, place: string): void {
  let at = project;
  for (const part of place.split('/').filter(Boolean)) {
    at = join(at, part);
    if (!existsSync(at) && !lstatExists(at)) return;
    const stat = lstatSync(at);
    if (stat.isSymbolicLink()) throw new BadPlace(`${place} passes through the link ${relative(project, at)}; a copy is never written through one.`);
    if (!stat.isDirectory()) throw new BadPlace(`${place} passes through the file ${relative(project, at)}.`);
  }
}
const lstatExists = (at: string): boolean => { try { lstatSync(at); return true; } catch { return false; } };

/** The pointer of the asked tool, and how its needs are found: through the registry, or beside it in the same commit. */
async function rootOf(input: AddInput, record: RecordFile, clones: string[]): Promise<{ registry: Registry | null; root: Wanted } | Refusal> {
  const folder = input.as ?? input.tool;
  if (input.from !== null && typeof input.from === 'object') {
    const { repo, path, commit } = input.from;
    if (typeof repo !== 'string' || !repo || !isInsidePath(path) || typeof commit !== 'string' || !COMMIT.test(commit)) {
      return { tool: input.tool, why: 'bad-from', said: 'A direct from is {repo, path, commit}: a repo, a path inside it and a full 40-hex commit.' };
    }
    // The record keeps an address every computer can reach (a local repo folder is recorded as its origin address); the
    // files are still read from the repo as given.
    let recorded: string;
    try { recorded = addressOf(repo); } catch (error) {
      if (error instanceof BadFrom) return { tool: input.tool, why: 'bad-from', said: error.message };
      throw error;
    }
    return { registry: null, root: { folder, from: { repo: recorded, path, commit }, repo, path, commit, files_blake3: null, needs: [] } };
  }
  const address = input.from ?? record.registry;
  if (typeof address !== 'string') return { tool: input.tool, why: 'bad-from', said: 'No from was given and the project record names no registry.' };
  let registry: Registry;
  try { registry = await readRegistry(address, clones); } catch (error) {
    if (error instanceof BadFrom) return { tool: input.tool, why: 'bad-from', said: error.message };
    throw error;
  }
  const pointer = registry.tools[input.tool];
  if (!pointer) return { tool: input.tool, why: 'not-in-registry', said: `${registry.address} holds no tool ${input.tool}.` };
  return { registry, root: wantedFromRegistry(registry, input.tool, folder) };
}

const wantedFromRegistry = (registry: Registry, name: string, folder: string): Wanted => {
  const p = registry.tools[name];
  return { folder, from: { registry: registry.address, tool: name }, repo: p.repo, path: p.path, commit: p.commit,
    files_blake3: p.files_blake3, ...(p.paths ? { paths: p.paths } : {}), needs: p.needs_tools };
};

/** Adds the asked tool and every folder it needs to the project. See the invariants above. */
export async function add(input: AddInput): Promise<AddOutput> {
  if (typeof input.tool !== 'string' || !TOOL_NAME.test(input.tool)) return refusedOnly([{ tool: String(input.tool), why: 'bad-from', said: 'tool is not a tool name (a-z, 0-9 and -).' }]);
  if (input.as !== undefined && (typeof input.as !== 'string' || !TOOL_NAME.test(input.as))) return refusedOnly([{ tool: input.tool, why: 'bad-from', said: 'as is not a folder name (a-z, 0-9 and -).' }]);
  if (input.clones !== undefined && (!Array.isArray(input.clones) || !input.clones.every(c => typeof c === 'string' && c.length > 0))) return refusedOnly([{ tool: input.tool, why: 'bad-from', said: 'clones is a list of folder paths.' }]);
  const missingClone = (input.clones ?? []).find(clone => !existsSync(clone) || !lstatSync(realpathSync(clone)).isDirectory());
  if (missingClone !== undefined) return refusedOnly([{ tool: input.tool, why: 'bad-from', said: `The clone ${missingClone} is not a folder.` }]);
  const clones = (input.clones ?? []).map(clone => realpathSync(clone));
  const project = realpathSync(input.project);
  if (!lstatSync(project).isDirectory()) throw new Error(`${project} is not a folder.`);
  // Where the record is (the project's one record file, else record_at, else the project's top) and where new copies go.
  let recordAt: string;
  let into: string;
  try {
    const found = recordPlace(project);
    const asked = input.record_at === undefined ? undefined : placeOf(input.record_at, 'record_at');
    if (found !== null && asked !== undefined && asked !== found) {
      throw new BadPlace(`The project's record is in ${found || 'its top folder'}; record_at names ${asked || 'its top folder'}.`);
    }
    recordAt = found ?? asked ?? '';
    into = input.into === undefined ? recordAt : placeOf(input.into, 'into');
    noLinkOnTheWay(project, recordAt);
    noLinkOnTheWay(project, into);
  } catch (error) {
    if (error instanceof BadPlace) return refusedOnly([{ tool: input.tool, why: 'bad-place', said: error.message }]);
    throw error;
  }
  const recordFolder = join(project, recordAt);
  const { expected, record } = readProjectRecord(recordFolder);
  for (const [name, line] of Object.entries(record.tools)) {
    try { placeOf(line.at, `The record line ${name}'s at`); } catch (error) {
      if (error instanceof BadPlace) return refusedOnly([{ tool: name, why: 'bad-place', said: `${error.message} Every line names where its copy lives.` }]);
      throw error;
    }
  }
  const rooted = await rootOf(input, record, clones);
  if ('why' in rooted) return refusedOnly([rooted]);
  const { registry, root } = rooted;

  const madeRecordFolder = !existsSync(recordFolder);
  mkdirSync(recordFolder, { recursive: true });
  const staging = join(recordFolder, `.adding-${process.pid}-${Date.now()}`);
  mkdirSync(staging);
  let placed = false;
  try {
    const refused: Refusal[] = [];
    const already: string[] = [];
    const members = new Map<string, Member>();
    const fromOf = new Map<string, Wanted['from']>();
    const commits = new Map<string, FetchedCommit>();
    const fetchFolder = (wanted: Wanted): Fetched => {
      const key = `${wanted.repo}\n${wanted.commit}`;
      if (!commits.has(key)) commits.set(key, new FetchedCommit(staging, wanted.repo, wanted.commit, commits.size, clones));
      return commits.get(key)!.folder(wanted.path, wanted.paths);
    };
    const queue: Wanted[] = [root];
    while (queue.length) {
      const wanted = queue.shift()!;
      const seen = fromOf.get(wanted.folder);
      if (seen) {
        if (!sameFrom(seen, wanted.from)) refused.push({ tool: wanted.folder, why: 'name-clash', said: `Two folders of this add are both named ${wanted.folder}.` });
        continue;
      }
      fromOf.set(wanted.folder, wanted.from);
      const line = record.tools[wanted.folder];
      const at = line ? line.at : posix.join(into || '.', wanted.folder);
      const here = join(project, at);
      let needs = wanted.needs;
      if (line && sameFrom(line.from, wanted.from)) {
        const same = wanted.files_blake3 === null ? line.copied_at_commit === wanted.commit : line.copied_at_files_blake3 === wanted.files_blake3;
        const clean = unedited(here, line);
        if (same && clean) {
          already.push(wanted.folder);
          members.set(wanted.folder, { folder: wanted.folder, at, from: wanted.from, commit: line.copied_at_commit!, files_blake3: line.copied_at_files_blake3!,
            needs: line.needs_tools ?? [], fetched: null, prepare: null });
          needs = line.needs_tools ?? [];
        } else if (!clean) {
          let fetched: Fetched;
          try { fetched = fetchFolder(wanted); } catch (error) { refused.push(fetchRefusal(wanted.folder, error)); continue; }
          const compare = join(staging, 'pointer', wanted.folder);
          writeFolder(compare, fetched);
          const paths = [...new Set([...Object.keys(line.files ?? {}), ...Object.keys(fetched.digests)])].sort();
          refused.push({ tool: wanted.folder, why: 'edited-copy', said: `${here} was edited after it was copied; nothing was written.`, diff: unifiedDiff(compare, here, paths) });
          continue;
        } else {
          refused.push({ tool: wanted.folder, why: 'other-version-present', said: `${here} holds another version from the same source; moving it is a sync (tool:keep-tool-copies-in-step).` });
          continue;
        }
      } else if (line || existsSync(here)) {
        const hint = wanted === root ? ' Give as to add it under another folder name.' : '';
        refused.push({ tool: wanted.folder, why: 'name-clash', said: `${here} is already ${line ? `another source's folder (${canonicalJson(line.from)})` : 'a folder the record does not name'}.${hint}` });
        continue;
      } else {
        let fetched: Fetched;
        try { fetched = fetchFolder(wanted); } catch (error) { refused.push(fetchRefusal(wanted.folder, error)); continue; }
        if (wanted.files_blake3 !== null && fetched.files_blake3 !== wanted.files_blake3) {
          refused.push({ tool: wanted.folder, why: 'identity-mismatch', said: `The files at ${wanted.commit} have identity ${fetched.files_blake3}, not the pointer's ${wanted.files_blake3}.` });
          continue;
        }
        let card;
        try { card = cardFacts(wanted.path, new Map(fetched.files.map(([path, bytes]) => [path, bytes]))); } catch (error) {
          if (error instanceof BadCard) { refused.push({ tool: wanted.folder, why: 'bad-card', said: error.message }); continue; }
          if (error instanceof OldCardName) { refused.push({ tool: wanted.folder, why: 'old-card-name', said: error.message }); continue; }
          throw error;
        }
        needs = [...new Set([...wanted.needs, ...card.needs_tools])].sort();
        members.set(wanted.folder, { folder: wanted.folder, at, from: wanted.from, commit: wanted.commit, files_blake3: fetched.files_blake3, needs, fetched, prepare: card.prepare });
      }
      for (const need of needs) {
        if (registry) {
          if (!registry.tools[need]) { refused.push({ tool: need, why: 'not-in-registry', said: `${wanted.folder} needs ${need}, which ${registry.address} does not hold.` }); continue; }
          queue.push(wantedFromRegistry(registry, need, need));
        } else {
          const path = posix.join(posix.dirname(wanted.path), need);
          queue.push({ folder: need, from: { repo: wanted.repo, path, commit: wanted.commit }, repo: wanted.repo, path, commit: wanted.commit, files_blake3: null, needs: [] });
        }
      }
    }
    if (refused.length) return refusedOnly(refused, already);

    const needsOf = new Map([...members.values()].map(member => [member.folder, member.needs]));
    const closureOf = (folder: string): Hex64 => identityOfDigests(reach(folder, needsOf).map((f): [string, string] => [f, members.get(f)!.files_blake3]));
    const fresh = [...members.values()].filter(member => member.fetched !== null);
    if (fresh.length === 0) return { added: [], already, refused: [], prepared: [], not_prepared: [], import_map: importMapOf(record) };

    const lines: Record<string, ToolRecord> = {};
    for (const member of fresh) {
      writeFolder(join(staging, 'tools', member.folder), member.fetched!);
      lines[member.folder] = { at: member.at, from: member.from, synced: true, copied_at_commit: member.commit, copied_at_files_blake3: member.files_blake3,
        closure_blake3: closureOf(member.folder), needs_tools: member.needs, files: member.fetched!.digests };
    }
    const next: RecordFile = { ...record, ...(registry && !record.registry ? { registry: registry.address } : {}), tools: { ...record.tools, ...lines } };
    try {
      writeProjectRecord(recordFolder, next, expected, () => {
        const taken = fresh.filter(member => lstatExists(join(project, member.at)));
        if (taken.length) throw new RecordChanged(`${taken.map(member => member.at).join(', ')} appeared in ${project} during this add.`);
        for (const member of fresh) {
          mkdirSync(dirname(join(project, member.at)), { recursive: true });
          renameSync(join(staging, 'tools', member.folder), join(project, member.at));
        }
        placed = true;
      });
    } catch (error) {
      if (error instanceof RecordChanged) return refusedOnly([{ tool: input.tool, why: 'record-changed-meanwhile', said: error.message }], already);
      throw error;
    }

    const prepared: string[] = [];
    const notPrepared: Array<{ tool: string; said: string }> = [];
    if (input.prepare !== false) {
      for (const folder of needsFirst(root.folder, needsOf)) {
        const member = members.get(folder)!;
        if (!member.fetched || !member.prepare) continue;
        const [program, ...words] = member.prepare;
        const done = spawnSync(program, words, { cwd: join(project, member.at), maxBuffer: 1 << 28 });
        if (done.status === 0) prepared.push(folder);
        else notPrepared.push({ tool: folder, said: done.error ? String(done.error.message) : done.stderr.toString('utf8').trim().slice(-2000) });
      }
    }
    return {
      added: fresh.map(member => ({ tool: member.folder, commit: member.commit, files: member.fetched!.files.length, files_blake3: member.files_blake3,
        closure_blake3: lines[member.folder].closure_blake3! })),
      already, refused: [], prepared, not_prepared: notPrepared, import_map: importMapOf(next),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (madeRecordFolder && !placed) rmSync(recordFolder, { recursive: true, force: true });
  }
}

function fetchRefusal(folder: string, error: unknown): Refusal {
  if (error instanceof NotAtCommit) return { tool: folder, why: 'tool-not-found-at-commit', said: error.message };
  if (error instanceof GitRefused) return { tool: folder, why: 'fetch-refused', said: error.message };
  throw error;
}

/** The project the input names, inside the granted folder; a project outside it is refused. */
export function projectInGrant(granted: string, project: string): string {
  const grant = realpathSync(granted);
  const at = realpathSync(resolve(grant, project));
  const inside = relative(grant, at);
  if (inside === '..' || inside.startsWith(`..${sep}`) || resolve(grant, inside) !== at) throw new Error(`${project} is not inside the granted folder.`);
  return at;
}

async function main(): Promise<void> {
  const [verb, granted] = process.argv.slice(2);
  if (verb !== 'add' || !granted) throw new Error('Usage: node do-work/add.ts add GRANTED-FOLDER < input.json');
  const input = JSON.parse(readFileSync(0, 'utf8')) as AddInput;
  // A registry named by a folder or file path is read from the granted folder, as the project is.
  const from = typeof input.from === 'string' && !input.from.startsWith('https://') ? resolve(realpathSync(granted), input.from) : input.from;
  // A local clone is read only from inside the granted folder, as the project is.
  const clones = Array.isArray(input.clones) ? input.clones.map(clone => projectInGrant(granted, clone)) : input.clones;
  const output = await add({ ...input, from, ...(clones === undefined ? {} : { clones }), project: projectInGrant(granted, input.project ?? '.') });
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = output.refused.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`); process.exitCode = 2; });
}

