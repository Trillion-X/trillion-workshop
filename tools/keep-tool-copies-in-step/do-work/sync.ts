// tools/keep-tool-copies-in-step/do-work/sync.ts
//
// PURPOSE
//   tool:keep-tool-copies-in-step. For every tool folder a project copied (each where its record line's `at` says, the
//   record being the project's one where-each-tool-comes-from.json, found in the tip's file list), compares three versions: the base (the files its record where-each-tool-comes-from.json says the copy started
//   from), the project's folder at the tip of the project's branch, and the upstream folder at the commit its pointer names
//   (the registry's pointer, only its `paths` when it names them, or the repository's HEAD for a direct pointer). The
//   project is read from a clone the tool keeps itself in its own state folder (the granted folder), fetched from the
//   project's repository address each run; no working checkout of the project is read or written. `plan` says what each
//   tool's state is and writes nothing to the project. `apply` offers each upstream change to the project as one branch
//   sync/upstream/<record line>/<upstream commit>, refuses conflicts with their diff, and skips forks.
//
//   node do-work/sync.ts STATE-FOLDER   < {"op": "plan", "repo", "branch"?, "only"?, "fact"?, "clones"?}
//                                       < {"op": "apply", "repo", "branch"?, "plan": <plan's answer>, "clones"?}
//     prints one JSON answer; exits 0 when it answered (a conflict is an answer), 2 when it could not run
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing a person wrote is overwritten. A tool with any both-conflict file is left byte for byte as it was, the files
//      that would have merged cleanly included, and is reported with each conflicting file's diff.
//   2. `synced: false` (a fork) is skipped before anything is read about it: no registry read, no fetch, no file read.
//   3. A three-way-different file is decided from the base BYTES (fetched at the record's copied_at_commit), never from
//      hashes alone; a base that cannot be fetched makes it a conflict. git merge-file's non-zero exit is a conflict and its
//      output is never written (read-data/merge-text.ts).
//   4. Branches only. The one push this tool makes goes through pushSyncBranch, which refuses every ref but
//      refs/heads/sync/upstream/<record line>/<40-hex upstream commit>, before git is started. It never force-pushes, never
//      fast-forwards or merges any branch, and never pushes the project's branch, main or any other ref. An upstream change
//      (upstream-only, both-clean, or a needed tool's change) is one commit on the tip of the project's branch (the tool's
//      files and its advanced record line, the record text written by the add tool's writeProjectRecord), with author,
//      committer, message and times fixed by that tip, so the same change on the same tip is the same commit.
//   5. A pull request is opened only for a branch the push created, judged from that push's own answer (git push
//      --porcelain: `*` is a new ref), never from a read made before it. No GitHub key is held, so each created branch's
//      pull request is answered as would_open and the gap is named; two runs of one change make one branch and one
//      would_open.
//   6. A tool's record line advances (copied_at_commit, copied_at_files_blake3, files) only in that branch commit, only for
//      a tool with no conflict, and then to exactly the upstream version it was compared with. A pointer's `paths` bound
//      what upstream is: a file outside them is never brought, so a file the pointer dropped is never added again.
//   7. Project changes stay in the project: a project-only tool is reported, and nothing is pushed for it.
//   8. Fetch, hash and record code is the add tool's (tools/add-a-tool-to-a-project/read-data), imported, never copied:
//      a local clone named in `clones` that holds a commit, or whose origin is the registry address a record line names,
//      is read instead of the network, exactly as the add tool reads it. Nothing is imported from outside the Workshop.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigest, identityOfDigests } from '../../content-identity/read-data/manifest.mjs';
import { canonicalJson } from '../../content-identity/read-data/identity.mjs';
import { BadFrom, isReachableAddress, readRegistry, type Hex64, type Registry } from '../../add-a-tool-to-a-project/read-data/registry.ts';
import { FetchedCommit, GitRefused, NotAtCommit, type Fetched, type FileMap } from '../../add-a-tool-to-a-project/read-data/fetch-folder.ts';
import { BadPlace, RECORD_FILE, placeOf, readProjectRecord, recordPlaceIn, writeProjectRecord, type RecordFile, type ToolRecord } from '../../add-a-tool-to-a-project/read-data/record.ts';
import { projectInGrant } from '../../add-a-tool-to-a-project/do-work/add.ts';
import { classifyTool, type Rename, type ToolVerdict, type Verdict } from '../read-data/classify.ts';
import { mergeText, threeWayDiff } from '../read-data/merge-text.ts';

export type ToolState = ToolVerdict | 'forked' | 'skipped' | 'refused' | 'local-edit';
export type Why = 'made-here' | 'not-in-registry' | 'bad-from' | 'fetch-refused' | 'identity-mismatch' | 'no-base'
  | 'record-changed-meanwhile' | 'changed-since-plan' | 'push-refused' | 'ref-refused' | 'local-edit' | 'needs-not-settled' | 'bad-place';
export type PlannedTool = { state: ToolState; files: Record<string, Verdict>; upstream_commit: string | null; renames?: Rename[]; why?: Why; said?: string;
  closure?: { recorded: Hex64; upstream: Hex64 } };
export type PlanResult = { record_blake3: string; because?: { where?: string; place?: string; key?: string }; tools: Record<string, PlannedTool> };
/** Where the project is: its repository address, the branch read (main when not named), and the tool's state folder. */
export type ProjectInput = { state: string; repo: string; branch?: string };
export type PlanInput = ProjectInput & { only?: string[]; fact?: unknown; clones?: string[] };
export type ApplyResult = {
  forked: string[];
  conflicts: { tool: string; path: string; diff: string }[];
  unchanged: string[];
  /** Tools with project changes only: they stay in the project, and nothing is pushed for them. */
  project_only: string[];
  /** One branch per upstream change: created is the push's own answer (a new ref); would_open is true for a created branch
   *  whose pull request is not opened because no GitHub key is held. */
  waiting: { tools: string[]; branch: string; commit: string; created: boolean; would_open: boolean; pull_request: null }[];
  gap?: string;
  skipped: { tool: string; why: Why }[];
  refused: { tool: string; why: Why; said: string }[];
};

/** What the sync reaches beyond the project folder: fetching a commit, reading a registry, asking a repo for its HEAD. */
export type Io = {
  fetchCommit: (scratch: string, repo: string, commit: string, index: number) => { dir: string; folder: (path: string, paths?: string[]) => Fetched };
  readRegistry: (from: string) => Promise<Registry>;
  remoteHead: (repo: string) => string;
};

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
const COMMIT = /^[0-9a-f]{40}$/;
const SIGNER = { GIT_AUTHOR_NAME: 'tool:keep-tool-copies-in-step', GIT_AUTHOR_EMAIL: 'keep-tool-copies-in-step@example.com',
  GIT_COMMITTER_NAME: 'tool:keep-tool-copies-in-step', GIT_COMMITTER_EMAIL: 'keep-tool-copies-in-step@example.com' };

/** One git call; its stdout, or GitRefused carrying what git said. */
function git(dir: string | null, args: string[], { env = ENV, input }: { env?: NodeJS.ProcessEnv; input?: Uint8Array } = {}): string {
  const done = spawnSync('git', dir === null ? args : ['-C', dir, ...args], { env, input, maxBuffer: 1 << 30 });
  if (done.error) throw done.error;
  if (done.status !== 0) throw new GitRefused(`git ${args.find(a => !a.startsWith('-')) ?? args[0]} refused: ${done.stderr.toString('utf8').trim()}`);
  return done.stdout.toString('utf8').trim();
}

/** The commit a repository's HEAD names now. */
function remoteHead(repo: string): string {
  const line = git(null, ['ls-remote', repo, 'HEAD']).split('\n')[0] ?? '';
  const commit = line.split('\t')[0];
  if (!COMMIT.test(commit)) throw new GitRefused(`${repo} names no HEAD commit.`);
  return commit;
}

/** The real reach: each commit borrowed from the first of `clones` that holds it, else fetched (the add tool's FetchedCommit);
 *  a registry the record names by its address read from the clone whose origin it is, else fetched (the add tool's readRegistry). */
export const realIo = (clones: string[] = []): Io => ({
  fetchCommit: (scratch, repo, commit, index) => new FetchedCommit(scratch, repo, commit, index, clones),
  readRegistry: from => readRegistry(from, clones), remoteHead });

type Upstream = { repo: string; path: string; commit: string; paths?: string[]; files_blake3: Hex64 | null };
type ProjectFile = { bytes: Buffer; executable: boolean };
type Computed = PlannedTool & {
  name: string;
  line: ToolRecord;
  upstream?: Upstream;
  fetched?: Fetched;
  commitDir?: string;
  project: Map<string, ProjectFile>;
  merged: Map<string, Uint8Array>;
  diffs: Map<string, string>;
};

/** The files of the project's copy at `place` (its line's `at`): what git lists (tracked, or new and not ignored), else every
 *  regular file. */
function projectFiles(project: string, place: string): Map<string, ProjectFile> {
  const files = new Map<string, ProjectFile>();
  const at = join(project, place);
  if (!existsSync(at) || !lstatSync(at).isDirectory()) return files;
  const keep = (relativePath: string) => {
    const file = join(at, ...relativePath.split('/'));
    if (!existsSync(file)) return;
    const stat = lstatSync(file);
    if (stat.isFile()) files.set(relativePath, { bytes: readFileSync(file), executable: (stat.mode & 0o111) !== 0 });
  };
  const inGit = spawnSync('git', ['-C', project, 'rev-parse', '--is-inside-work-tree'], { env: ENV });
  if (inGit.status === 0 && inGit.stdout.toString('utf8').trim() === 'true') {
    const listed = git(project, ['ls-files', '-z', '-c', '-o', '--exclude-standard', '--', `${place}/`]);
    const prefix = `${place}/`;
    for (const name of listed.split('\0').filter(Boolean)) if (name.startsWith(prefix)) keep(name.slice(prefix.length));
    return files;
  }
  const walk = (relativeFolder: string) => {
    for (const entry of readdirSync(join(at, ...relativeFolder.split('/').filter(Boolean)), { withFileTypes: true })) {
      const relativePath = relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relativePath);
      else if (entry.isFile()) keep(relativePath);
    }
  };
  walk('');
  return files;
}

const digestsOf = (files: Map<string, ProjectFile>): FileMap => Object.fromEntries([...files].map(([path, file]) => [path, fileDigest(file.bytes)]));
const fileMapOf = (fetched: Fetched): Map<string, ProjectFile> => new Map(fetched.files.map(([path, bytes, executable]) => [path, { bytes, executable }]));

/** Compares every tool the record names (only those in `only`, when given). Shared by plan and apply. */
async function compareAll(project: string, record: RecordFile, only: string[] | undefined, io: Io, scratch: string): Promise<Computed[]> {
  const registries = new Map<string, Promise<Registry>>();
  const commits = new Map<string, ReturnType<Io['fetchCommit']>>();
  const fetchAt = (repo: string, commit: string) => {
    const key = `${repo}\n${commit}`;
    if (!commits.has(key)) commits.set(key, io.fetchCommit(scratch, repo, commit, commits.size));
    return commits.get(key)!;
  };
  const wanted = only ? new Set(only) : null;
  const names = Object.keys(record.tools).filter(name => !wanted || wanted.has(name)).sort();
  const computed: Computed[] = [];
  for (const name of names) {
    const line = record.tools[name];
    const plain = { name, line, files: {}, upstream_commit: null, project: new Map(), merged: new Map(), diffs: new Map() };
    const refused = (why: Why, said: string): Computed => ({ ...plain, state: 'refused', why, said });
    if (line.synced === false) { computed.push({ ...plain, state: 'forked' }); continue; }
    try { placeOf(line.at, `The record line ${name}'s at`); } catch (error) {
      if (error instanceof BadPlace) { computed.push(refused('bad-place', `${error.message} Every line names where its copy lives.`)); continue; }
      throw error;
    }
    if (line.from === 'made-here') { computed.push({ ...plain, state: 'skipped', why: 'made-here', said: 'Made in this project: it has no upstream.' }); continue; }
    // A line whose files do not hash to the identity it names was edited by hand: it is no start version (plan 30.3).
    if (line.files && line.copied_at_files_blake3 && identityOfDigests(line.files) !== line.copied_at_files_blake3) {
      computed.push({ ...plain, state: 'local-edit', why: 'local-edit', said: `The record line of ${name} names files whose identity is ${identityOfDigests(line.files)}, not its copied_at_files_blake3 ${line.copied_at_files_blake3}: it was edited by hand, so it is not trusted as the version the copy started from. Add the tool again, or put back the line tool:add-a-tool-to-a-project wrote.` });
      continue;
    }

    let upstream: Upstream;
    try {
      if ('registry' in line.from) {
        if (!registries.has(line.from.registry)) registries.set(line.from.registry, io.readRegistry(line.from.registry));
        const pointer = (await registries.get(line.from.registry)!).tools[line.from.tool];
        if (!pointer) { computed.push(refused('not-in-registry', `${line.from.registry} holds no tool ${line.from.tool}.`)); continue; }
        upstream = { repo: pointer.repo, path: pointer.path, commit: pointer.commit, ...(pointer.paths ? { paths: pointer.paths } : {}), files_blake3: pointer.files_blake3 };
      } else {
        upstream = { repo: line.from.repo, path: line.from.path, commit: io.remoteHead(line.from.repo), files_blake3: null };
      }
    } catch (error) {
      if (error instanceof BadFrom) {
        // A line written before the add tool recorded registries by address (2381a22ed) names a folder path; readRegistry
        // reads one only when its git origin is an address, so the cause names the one-time rewrite, never a second reader.
        const old = typeof line.from === 'object' && 'registry' in line.from && !isReachableAddress(line.from.registry);
        computed.push(refused('bad-from', old ? `${error.message} This record line names its registry by a path, as records written before tool:add-a-tool-to-a-project 2381a22ed do: rewrite its registry fields once to the registry's address (same commits and identities).` : error.message));
        continue;
      }
      if (error instanceof GitRefused) { computed.push(refused('fetch-refused', error.message)); continue; }
      throw error;
    }
    if (!line.files || !line.copied_at_commit || !COMMIT.test(line.copied_at_commit)) {
      computed.push(refused('no-base', `The record line of ${name} names no files and commit it was copied at.`));
      continue;
    }

    let fetched: Fetched;
    let commitDir: string;
    try {
      const at = fetchAt(upstream.repo, upstream.commit);
      fetched = at.folder(upstream.path, upstream.paths);
      commitDir = at.dir;
    } catch (error) {
      if (error instanceof GitRefused || error instanceof NotAtCommit) { computed.push(refused('fetch-refused', error.message)); continue; }
      throw error;
    }
    if (upstream.files_blake3 !== null && fetched.files_blake3 !== upstream.files_blake3) {
      computed.push(refused('identity-mismatch', `${upstream.path} at ${upstream.commit} has identity ${fetched.files_blake3}, not the pointer's ${upstream.files_blake3}.`));
      continue;
    }

    const base = line.files;
    const projectNow = projectFiles(project, line.at);
    const projectMap = digestsOf(projectNow);
    const upstreamNow = fileMapOf(fetched);
    const upstreamMap = fetched.digests;
    // First pass with no merges: which files are three-way different (or differently absent) and need the base bytes.
    const first = classifyTool(base, projectMap, upstreamMap);
    const needBase = Object.entries(first.files).filter(([path, verdict]) => verdict === 'both-conflict' && base[path] !== undefined).map(([path]) => path);
    const baseBytes = new Map<string, Buffer>();
    if (needBase.length) {
      try {
        const old = fetchAt(upstream.repo, line.copied_at_commit).folder(upstream.path, needBase);
        // A base whose bytes are not what the record names is no base: those files stay conflicts.
        for (const [path, bytes] of old.files) if (fileDigest(bytes) === base[path]) baseBytes.set(path, bytes);
      } catch (error) {
        if (!(error instanceof GitRefused || error instanceof NotAtCommit)) throw error;
      }
    }
    const merged = new Map<string, Uint8Array>();
    const diffs = new Map<string, string>();
    for (const path of needBase) {
      const [b, l, u] = [baseBytes.get(path), projectNow.get(path)?.bytes, upstreamNow.get(path)?.bytes];
      if (b && l && u) {
        const merge = mergeText(l, b, u, path);
        if (merge.ok) { merged.set(path, merge.bytes); continue; }
        diffs.set(path, merge.diff);
      }
    }
    const settled = classifyTool(base, projectMap, upstreamMap, path => merged.has(path));
    for (const [path, verdict] of Object.entries(settled.files)) {
      if (verdict !== 'both-conflict' || diffs.has(path)) continue;
      const b = baseBytes.get(path) ?? null;
      const note = base[path] !== undefined && b === null ? `# The base bytes of ${path} at ${line.copied_at_commit} could not be read; it is refused unmerged.\n` : '';
      diffs.set(path, note + threeWayDiff(path, b, projectNow.get(path)?.bytes ?? null, upstreamNow.get(path)?.bytes ?? null));
    }
    computed.push({ ...plain, state: settled.tool, files: settled.files, upstream_commit: upstream.commit,
      ...(settled.renames.length ? { renames: settled.renames } : {}), upstream, fetched, commitDir, project: projectNow, merged, diffs });
  }
  // A change in any needed tool is an upstream change of this tool (plan 30.3, B3): its closure_blake3, made as the add
  // tool makes it over every folder it reaches, is compared with the same identity over the upstream versions.
  const upstreamIdentity = async (folder: string): Promise<Hex64 | undefined> => {
    const line = record.tools[folder];
    if (!line || line.synced === false || line.from === 'made-here' || !('registry' in line.from)) return line?.copied_at_files_blake3;
    if (!registries.has(line.from.registry)) registries.set(line.from.registry, io.readRegistry(line.from.registry));
    try { return (await registries.get(line.from.registry)!).tools[line.from.tool]?.files_blake3 ?? line.copied_at_files_blake3; } catch { return line.copied_at_files_blake3; }
  };
  for (const one of computed) {
    if (!one.upstream || !one.line.closure_blake3 || one.state === 'both-conflict') continue;
    const reached = reach(one.name, record.tools);
    const pairs = await Promise.all(reached.map(async (folder): Promise<[string, Hex64 | undefined]> => [folder, folder === one.name ? one.fetched!.files_blake3 : await upstreamIdentity(folder)]));
    if (pairs.some(([, identity]) => identity === undefined)) continue;
    const upstreamClosure = identityOfDigests(pairs as Array<[string, string]>);
    if (upstreamClosure === one.line.closure_blake3) continue;
    one.closure = { recorded: one.line.closure_blake3, upstream: upstreamClosure };
    if (one.state === 'none-changed') one.state = 'upstream-only';
  }
  return computed;
}

const plannedOf = (one: Computed): PlannedTool => ({ state: one.state, files: one.files, upstream_commit: one.upstream_commit,
  ...(one.renames ? { renames: one.renames } : {}), ...(one.why ? { why: one.why, said: one.said } : {}), ...(one.closure ? { closure: one.closure } : {}) });

function becauseOf(fact: unknown): PlanResult['because'] | undefined {
  if (fact === null || typeof fact !== 'object') return undefined;
  const f = fact as Record<string, unknown>;
  const because: NonNullable<PlanResult['because']> = {};
  for (const field of ['where', 'place', 'key'] as const) if (typeof f[field] === 'string') because[field] = f[field] as string;
  return because;
}

function withScratch<T>(work: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), 'keep-tool-copies-'));
  return work(scratch).finally(() => rmSync(scratch, { recursive: true, force: true }));
}

/** What each tool's state is, with every file's verdict. Writes nothing to the project (it fetches into its own clone). */
export async function plan(input: PlanInput, io: Io = realIo(input.clones)): Promise<PlanResult> {
  const { dir, recordAt } = openProject(input);
  const { expected, record } = readProjectRecord(join(dir, recordAt));
  return withScratch(async scratch => {
    const computed = await compareAll(dir, record, input.only, io, scratch);
    const because = becauseOf(input.fact);
    return { record_blake3: expected, ...(because ? { because } : {}), tools: Object.fromEntries(computed.map(one => [one.name, plannedOf(one)])) };
  });
}

const PROJECT_SIDE: ReadonlySet<Verdict> = new Set(['project-only', 'deleted-project', 'renamed-project']);
const UPSTREAM_SIDE: ReadonlySet<Verdict> = new Set(['upstream-only', 'deleted-upstream', 'renamed-upstream']);
type Change = { bytes: Uint8Array | null; executable: boolean };

/** The files one settling tool's upstream side brings to the project (merged files included), and whether the project
 *  holds changes of its own that stay where they are. */
function movesOf(one: Computed): { into: Map<string, Change>; projectChanged: boolean } {
  const into = new Map<string, Change>();
  let projectChanged = false;
  const upstreamNow = fileMapOf(one.fetched!);
  for (const [path, verdict] of Object.entries(one.files)) {
    const mine = one.project.get(path) ?? null;
    if (verdict === 'both-clean') into.set(path, { bytes: one.merged.get(path)!, executable: mine?.executable ?? false });
    else if (UPSTREAM_SIDE.has(verdict)) {
      const theirs = upstreamNow.get(path) ?? null;
      into.set(path, { bytes: theirs?.bytes ?? null, executable: theirs?.executable ?? false });
    } else if (PROJECT_SIDE.has(verdict)) projectChanged = true;
  }
  return { into, projectChanged };
}

/** The folders reachable from `start` through needs_tools, `start` included. */
function reach(start: string, tools: Record<string, ToolRecord>): string[] {
  const seen = new Set<string>();
  const walk = (folder: string): void => {
    if (seen.has(folder) || !tools[folder]) return;
    seen.add(folder);
    for (const need of tools[folder].needs_tools ?? []) walk(need);
  };
  walk(start);
  return [...seen];
}

/** The only refs this tool pushes: refs/heads/sync/upstream/<record line>/<40-hex upstream commit>. */
const SYNC_REF = /^refs\/heads\/sync\/upstream\/[a-z0-9][a-z0-9._-]*\/[0-9a-f]{40}$/;

/** Refused before git starts: a push to any ref but a sync/upstream branch (invariant 4). */
export class RefRefused extends Error {}

/** The branch one upstream change waits on: its record line and the upstream commit it brings. */
export const syncRef = (line: string, upstreamCommit: string): string => `refs/heads/sync/upstream/${line}/${upstreamCommit}`;

/** Pushes `commit` to `ref` of `repo` from the clone `dir`, without force, and says whether the push created the ref
 *  (its own porcelain answer: `*` new, `=` already there). Every ref but a sync/upstream branch is refused before git
 *  starts. A ref git refuses (it names another commit) is a GitRefused carrying git's words. */
export function pushSyncBranch(dir: string, repo: string, commit: string, ref: string): { created: boolean } {
  if (!SYNC_REF.test(ref) || ref.includes('..')) throw new RefRefused(`refusing to push ${ref}: only refs/heads/sync/upstream/<record line>/<upstream commit> is pushed.`);
  if (!COMMIT.test(commit)) throw new RefRefused(`refusing to push ${commit}: not a full commit id.`);
  const done = spawnSync('git', ['-C', dir, 'push', '--porcelain', '--no-verify', repo, `${commit}:${ref}`], { env: ENV, maxBuffer: 1 << 24 });
  if (done.error) throw done.error;
  const said = `${done.stdout.toString('utf8')}${done.stderr.toString('utf8')}`;
  const line = done.stdout.toString('utf8').split('\n').find(row => row.split('\t')[1] === `${commit}:${ref}`);
  if (done.status !== 0 || !line) throw new GitRefused(`git push of ${ref} refused: ${said.trim().slice(-1500)}`);
  const flag = line[0];
  if (flag === '*') return { created: true };
  if (flag === '=') return { created: false };
  throw new GitRefused(`git push of ${ref} answered ${JSON.stringify(line)}, which neither created nor found the branch.`);
}

/** The tool's own clone of the project, in its state folder: fetched blob-less at the tip of `branch`, with a sparse
 *  checkout of only the record and each copy its lines place (`at`). The record is the project's one record file in the
 *  tip's file list (recordPlaceIn; two are refused). Its folder is the project the comparison reads; the project's own
 *  working checkout is never read or written. The tip commit and the record's folder are returned with it. */
function openProject(input: ProjectInput): { dir: string; tip: string; recordAt: string } {
  const branch = input.branch ?? 'main';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) throw new Error(`branch ${JSON.stringify(branch)} is not a branch name.`);
  if (typeof input.repo !== 'string' || input.repo.length === 0) throw new Error('repo is the project repository address.');
  const dir = join(realpathSync(input.state), 'projects', `${branchPart(input.repo)}-${fileDigest(Buffer.from(input.repo)).slice(0, 12)}`);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) git(dir, ['init', '-q']);
  const remotes = git(dir, ['remote']).split('\n');
  git(dir, remotes.includes('origin') ? ['remote', 'set-url', 'origin', input.repo] : ['remote', 'add', 'origin', input.repo]);
  git(dir, ['-c', 'protocol.version=2', 'fetch', '-q', '--no-tags', '--depth', '1', '--filter=blob:none', 'origin', `refs/heads/${branch}`]);
  const tip = git(dir, ['rev-parse', 'FETCH_HEAD']);
  if (!COMMIT.test(tip)) throw new GitRefused(`${input.repo} answered no commit for ${branch}.`);
  const found = recordPlaceIn(git(dir, ['ls-tree', '-r', '-z', '--name-only', tip]).split('\0').filter(Boolean));
  const recordAt = found ?? '';
  const recordPath = recordAt ? `${recordAt}/${RECORD_FILE}` : RECORD_FILE;
  git(dir, ['config', 'core.sparseCheckout', 'true']);
  const checkout = (places: string[]) => {
    writeFileSync(join(dir, '.git', 'info', 'sparse-checkout'), places.map(place => `/${place}\n`).join(''));
    git(dir, ['checkout', '-q', '--detach', '--force', tip]);
  };
  checkout([recordPath]);
  // Each copy is checked out at the place its line names; a line whose place is no folder inside the project is left
  // out here, and compareAll refuses it.
  const places = found === null ? [] : Object.values(readProjectRecord(join(dir, recordAt)).record.tools).flatMap(line => {
    try { return [placeOf(line.at, 'at')]; } catch (error) { if (error instanceof BadPlace) return []; throw error; }
  }).filter(Boolean);
  checkout([recordPath, ...places.map(place => `${place}/`)]);
  for (const place of places) git(dir, ['clean', '-q', '-ffdx', '--', place]);
  return { dir, tip, recordAt };
}

const branchPart = (text: string): string => text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'project';

/** The record text the add tool's writeProjectRecord writes for `record`, written into a fresh folder of the run's own. */
function recordBytes(scratch: string, record: RecordFile): Buffer {
  const folder = mkdtempSync(join(scratch, 'record-'));
  writeProjectRecord(folder, record, readProjectRecord(folder).expected, () => {});
  return readFileSync(join(folder, RECORD_FILE));
}

type Waiting = ApplyResult['waiting'][number];

/** One commit on the project's tip holding `tools`' upstream changes and their advanced record lines (invariant 4). */
function projectCommit(dir: string, tip: string, scratch: string, recordAt: string, record: RecordFile, tools: Computed[]): string {
  const inTop = (place: string, path: string) => (place ? `${place}/${path}` : path);
  const env = { ...ENV, GIT_INDEX_FILE: join(scratch, `index-${tools[0].name}`) };
  git(dir, ['read-tree', tip], { env });
  const lines = { ...record.tools };
  for (const one of tools) {
    for (const [path, change] of movesOf(one).into) {
      const full = inTop(one.line.at, path);
      if (change.bytes === null) { git(dir, ['update-index', '--force-remove', '--', full], { env }); continue; }
      const blob = git(dir, ['hash-object', '-w', '--stdin'], { input: change.bytes });
      git(dir, ['update-index', '--add', '--cacheinfo', `${change.executable ? '100755' : '100644'},${blob},${full}`], { env });
    }
    lines[one.name] = { ...one.line, copied_at_commit: one.upstream!.commit, copied_at_files_blake3: one.fetched!.files_blake3,
      files: one.fetched!.digests, ...(typeof one.line.from === 'object' && 'repo' in one.line.from ? { from: { ...one.line.from, commit: one.upstream!.commit } } : {}) };
  }
  const moved = new Set(tools.map(one => one.name));
  for (const [name, line] of Object.entries(lines)) {
    const reached = reach(name, lines);
    if (line.closure_blake3 && reached.some(folder => moved.has(folder))) {
      lines[name] = { ...line, closure_blake3: identityOfDigests(reached.map((folder): [string, string] => [folder, lines[folder].copied_at_files_blake3!])) };
    }
  }
  const blob = git(dir, ['hash-object', '-w', '--stdin'], { input: recordBytes(scratch, { ...record, tools: lines }) });
  git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${inTop(recordAt, RECORD_FILE)}`], { env });
  const tree = git(dir, ['write-tree'], { env });
  const when = git(dir, ['log', '-1', '--format=%cI', tip]);
  const sources = [...new Set(tools.map(one => one.upstream!.repo))].join(', ');
  const message = `${tools.map(one => one.name).join(', ')} from upstream, by tool:keep-tool-copies-in-step\n\nUpstream: ${sources}.\n`;
  return git(dir, ['commit-tree', tree, '-p', tip, '-F', '-'], { env: { ...ENV, ...SIGNER, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, input: Buffer.from(message) });
}

const NO_KEY = 'No GitHub key bound to api.github.com is held in the vault, so the pull request each created branch would open is not opened (would_open).';

/** Settles what `plan` found (see the invariants above). */
export async function apply(input: ProjectInput & { plan: PlanResult; clones?: string[] }, io: Io = realIo(input.clones)): Promise<ApplyResult> {
  const result: ApplyResult = { forked: [], conflicts: [], unchanged: [], project_only: [], waiting: [], skipped: [], refused: [] };
  const planned = input.plan?.tools;
  if (!planned || typeof planned !== 'object' || typeof input.plan.record_blake3 !== 'string') throw new Error('apply needs plan: the answer of op plan.');
  const { dir, tip, recordAt } = openProject(input);
  const { expected, record } = readProjectRecord(join(dir, recordAt));
  if (expected !== input.plan.record_blake3) {
    for (const tool of Object.keys(planned)) result.refused.push({ tool, why: 'record-changed-meanwhile', said: `${RECORD_FILE} at ${tip} is not the one plan read.` });
    return result;
  }
  return withScratch(async scratch => {
    const computed = await compareAll(dir, record, Object.keys(planned), io, scratch);
    const settling: Computed[] = [];
    for (const one of computed) {
      if (canonicalJson(plannedOf(one)) !== canonicalJson(planned[one.name])) {
        result.refused.push({ tool: one.name, why: 'changed-since-plan', said: `${one.name} is ${one.state} now, not what plan found; plan again.` });
        continue;
      }
      if (one.state === 'forked') result.forked.push(one.name);
      else if (one.state === 'none-changed') result.unchanged.push(one.name);
      else if (one.state === 'skipped') result.skipped.push({ tool: one.name, why: one.why! });
      else if (one.state === 'refused' || one.state === 'local-edit') result.refused.push({ tool: one.name, why: one.why!, said: one.said! });
      else if (one.state === 'both-conflict') {
        for (const [path, diff] of one.diffs) result.conflicts.push({ tool: one.name, path, diff });
      } else settling.push(one);
    }
    for (const one of settling) if (one.state === 'project-only') result.project_only.push(one.name);

    // Upstream changes come to the project as one branch each (invariant 4).
    const own = settling.filter(one => movesOf(one).into.size > 0 || canonicalJson({ c: one.line.copied_at_commit, f: one.line.files })
      !== canonicalJson({ c: one.upstream!.commit, f: one.fetched!.digests }));
    // A tool whose own files did not move but whose closure did rides on the branch of the first needed tool that moved,
    // so its closure_blake3 is made again from what that commit holds.
    const ownNames = new Set(own.map(one => one.name));
    const riders = new Map<string, Computed[]>();
    for (const one of settling.filter(tool => !ownNames.has(tool.name) && tool.closure)) {
      const need = reach(one.name, record.tools).find(folder => folder !== one.name && ownNames.has(folder));
      if (need === undefined) {
        result.refused.push({ tool: one.name, why: 'needs-not-settled', said: `The tools ${one.name} needs changed upstream (closure ${one.closure!.upstream}, recorded ${one.closure!.recorded}), but none of them settles in this apply; it moves when they do.` });
        continue;
      }
      riders.set(need, [...(riders.get(need) ?? []), one]);
    }
    for (const one of own) {
      const tools = [one, ...(riders.get(one.name) ?? [])];
      const ref = syncRef(one.name, one.upstream!.commit);
      try {
        const commit = projectCommit(dir, tip, scratch, recordAt, record, tools);
        const { created } = pushSyncBranch(dir, input.repo, commit, ref);
        const waiting: Waiting = { tools: tools.map(tool => tool.name), branch: ref.slice('refs/heads/'.length), commit, created, would_open: created, pull_request: null };
        result.waiting.push(waiting);
        if (created) result.gap = NO_KEY;
      } catch (error) {
        if (error instanceof RefRefused) { for (const tool of tools) result.refused.push({ tool: tool.name, why: 'ref-refused', said: error.message }); continue; }
        if (!(error instanceof GitRefused)) throw error;
        for (const tool of tools) result.refused.push({ tool: tool.name, why: 'push-refused', said: error.message });
      }
    }
    return result;
  });
}

async function main(): Promise<void> {
  const [state] = process.argv.slice(2);
  if (!state) throw new Error('Usage: node do-work/sync.ts STATE-FOLDER < input.json');
  const input = JSON.parse(readFileSync(0, 'utf8')) as { op?: string; repo?: string; branch?: string; only?: string[]; fact?: unknown; plan?: PlanResult; clones?: unknown };
  // A local clone is read only from inside the state folder.
  if (input.clones !== undefined && (!Array.isArray(input.clones) || !input.clones.every(c => typeof c === 'string' && c.length > 0))) throw new Error('clones is a list of folder paths.');
  const clones = (input.clones as string[] | undefined ?? []).map(clone => projectInGrant(state, clone));
  const where = { state, repo: input.repo as string, ...(input.branch !== undefined ? { branch: input.branch } : {}) };
  let output: unknown;
  if (input.op === 'plan') output = await plan({ ...where, only: input.only, fact: input.fact, clones });
  else if (input.op === 'apply') output = await apply({ ...where, plan: input.plan as PlanResult, clones });
  else throw new Error('op is plan or apply.');
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`); process.exitCode = 2; });
}
