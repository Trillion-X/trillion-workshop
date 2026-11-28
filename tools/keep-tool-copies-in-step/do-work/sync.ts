// tools/keep-tool-copies-in-step/do-work/sync.ts
//
// PURPOSE
//   tool:keep-tool-copies-in-step. For every tool folder a project copied into its own tools folder (TOOLS_FOLDER, the add
//   tool's), compares three versions: the base (the files its record where-each-tool-comes-from.json says the copy started from), the
//   project's folder now, and the upstream folder at the newest commit its pointer names (the registry's pointer, or the
//   repository's HEAD for a direct pointer). `plan` says what each tool's state is and writes nothing. `apply` settles the
//   safe states: it brings upstream changes to the project as a branch (merged only for a trusted source whose project
//   tests pass), offers project changes upstream (through the source's landing owner, or on a branch), refuses conflicts
//   with their diff, and skips forks.
//
//   node do-work/sync.ts GRANTED-FOLDER   < {"op": "plan", "project"?, "only"?, "fact"?, "clones"?}
//                                         < {"op": "apply", "project"?, "plan": <plan's answer>, "clones"?, "land_through"?}
//     prints one JSON answer; exits 0 when it answered (a conflict is an answer), 2 when it could not run
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing a person wrote is overwritten. A tool with any both-conflict file is left byte for byte as it was, the files
//      that would have merged cleanly included, and is reported with each conflicting file's diff.
//   2. `synced: false` (a fork) is skipped before anything is read about it: no registry read, no fetch, no file read.
//   3. A three-way-different file is decided from the base BYTES (fetched at the record's copied_at_commit), never from
//      hashes alone; a base that cannot be fetched makes it a conflict. git merge-file's non-zero exit is a conflict and its
//      output is never written (read-data/merge-text.ts).
//   4. An upstream change (upstream-only, both-clean) never goes straight into the project's files (plan B4). It is one
//      commit on the project's HEAD (the tool's files and its advanced record line, the record text written by the add
//      tool's writeProjectRecord), kept as branch sync/upstream/trusted or sync/upstream/TOOL with a compare-and-set on the
//      branch ref, and pushed to the project's origin with a lease when it has one. It is merged into the project
//      (`git merge --ff-only`, git refusing when HEAD or those files moved) only when every source in the commit has its
//      owner in the record's `trust` list (DATA) AND the record's `test` command (DATA, words, run in an export of the
//      commit) exits 0. Otherwise it waits for the project's owner. A pull request needs a GitHub key; with none held it is
//      named as the gap, never worked around.
//   5. A tool's record line advances (copied_at_commit, copied_at_files_blake3, files) only in that commit, only for a tool
//      with no conflict, and then to exactly the upstream version it was compared with.
//   6. Project changes go upstream through the source's own landing owner when the input names one for its repository
//      (`land_through`: a checkout on this computer, landed by its queue, which three-way merges onto its main). Any other
//      repository is offered branch `sync/<project>/<tool>` made on the upstream commit, pushed with --force-with-lease
//      naming the branch's sha read just before; never a default branch, never a plain force push. The branch commit is
//      deterministic (same parent, tree, message and times), so offering the same change again is a no-op.
//   7. Fetch, hash and record code is the add tool's (tools/add-a-tool-to-a-project/read-data), imported, never copied:
//      a local clone named in `clones` that holds a commit, or whose origin is the registry address a record line names,
//      is read instead of the network, exactly as the add tool reads it. Nothing is imported from outside the Workshop.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigest, identityOfDigests } from '../../content-identity/read-data/manifest.mjs';
import { canonicalJson } from '../../content-identity/read-data/identity.mjs';
import { BadFrom, isReachableAddress, readRegistry, type Hex64, type Registry } from '../../add-a-tool-to-a-project/read-data/registry.ts';
import { FetchedCommit, GitRefused, NotAtCommit, type Fetched, type FileMap } from '../../add-a-tool-to-a-project/read-data/fetch-folder.ts';
import { RECORD_FILE, TOOLS_FOLDER, readProjectRecord, writeProjectRecord, type RecordFile, type ToolRecord } from '../../add-a-tool-to-a-project/read-data/record.ts';
import { projectInGrant } from '../../add-a-tool-to-a-project/do-work/add.ts';
import { classifyTool, type Rename, type ToolVerdict, type Verdict } from '../read-data/classify.ts';
import { mergeText, threeWayDiff } from '../read-data/merge-text.ts';

export type ToolState = ToolVerdict | 'forked' | 'skipped' | 'refused';
export type Why = 'made-here' | 'not-in-registry' | 'bad-from' | 'fetch-refused' | 'identity-mismatch' | 'no-base'
  | 'record-changed-meanwhile' | 'changed-since-plan' | 'push-refused' | 'landing-refused' | 'not-a-git-project' | 'record-not-committed';
export type Waits = 'not-trusted' | 'no-test-command' | 'tests-not-green' | 'project-moved';
/** A landing owner for one upstream repository on this computer: the words that start it (land_paths.py and its --repo). */
export type LandThrough = { repo: string; command: string[] };
export type PlannedTool = { state: ToolState; files: Record<string, Verdict>; upstream_commit: string | null; renames?: Rename[]; why?: Why; said?: string };
export type PlanResult = { record_blake3: string; because?: { where?: string; place?: string; key?: string }; tools: Record<string, PlannedTool> };
export type PlanInput = { project: string; only?: string[]; fact?: unknown; clones?: string[] };
export type ApplyResult = {
  settled: string[];
  forked: string[];
  conflicts: { tool: string; path: string; diff: string }[];
  unchanged: string[];
  pushed: { tool: string; repo: string; branch: string | null; commit: string; already: boolean; landed_by?: string }[];
  waiting: { tools: string[]; branch: string; commit: string; why: Waits; said: string; pull_request: null }[];
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

/** The files of the project's copy: what git lists (tracked, or new and not ignored), else every regular file. */
function projectFiles(project: string, folder: string): Map<string, ProjectFile> {
  const files = new Map<string, ProjectFile>();
  const at = join(project, TOOLS_FOLDER, folder);
  if (!existsSync(at) || !lstatSync(at).isDirectory()) return files;
  const keep = (relativePath: string) => {
    const file = join(at, ...relativePath.split('/'));
    if (!existsSync(file)) return;
    const stat = lstatSync(file);
    if (stat.isFile()) files.set(relativePath, { bytes: readFileSync(file), executable: (stat.mode & 0o111) !== 0 });
  };
  const inGit = spawnSync('git', ['-C', project, 'rev-parse', '--is-inside-work-tree'], { env: ENV });
  if (inGit.status === 0 && inGit.stdout.toString('utf8').trim() === 'true') {
    const listed = git(project, ['ls-files', '-z', '-c', '-o', '--exclude-standard', '--', `${TOOLS_FOLDER}/${folder}/`]);
    const prefix = `${TOOLS_FOLDER}/${folder}/`;
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
    if (line.from === 'made-here') { computed.push({ ...plain, state: 'skipped', why: 'made-here', said: 'Made in this project: it has no upstream.' }); continue; }

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
    const projectNow = projectFiles(project, name);
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
  return computed;
}

const plannedOf = (one: Computed): PlannedTool => ({ state: one.state, files: one.files, upstream_commit: one.upstream_commit,
  ...(one.renames ? { renames: one.renames } : {}), ...(one.why ? { why: one.why, said: one.said } : {}) });

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

/** What each tool's state is, with every file's verdict. Writes nothing. */
export async function plan(input: PlanInput, io: Io = realIo(input.clones)): Promise<PlanResult> {
  const project = realpathSync(input.project);
  const { expected, record } = readProjectRecord(join(project, TOOLS_FOLDER));
  return withScratch(async scratch => {
    const computed = await compareAll(project, record, input.only, io, scratch);
    const because = becauseOf(input.fact);
    return { record_blake3: expected, ...(because ? { because } : {}), tools: Object.fromEntries(computed.map(one => [one.name, plannedOf(one)])) };
  });
}

const PROJECT_SIDE: ReadonlySet<Verdict> = new Set(['project-only', 'deleted-project', 'renamed-project']);
const UPSTREAM_SIDE: ReadonlySet<Verdict> = new Set(['upstream-only', 'deleted-upstream', 'renamed-upstream']);
type Change = { bytes: Uint8Array | null; executable: boolean };
type Offer = Map<string, Change>;

/** What one settling tool changes: the files its upstream side brings to the project, and the files offered upstream. */
function movesOf(one: Computed): { into: Offer; offer: Offer } {
  const into: Offer = new Map();
  const offer: Offer = new Map();
  const upstreamNow = fileMapOf(one.fetched!);
  for (const [path, verdict] of Object.entries(one.files)) {
    const mine = one.project.get(path) ?? null;
    if (verdict === 'both-clean') {
      const change = { bytes: one.merged.get(path)!, executable: mine?.executable ?? false };
      into.set(path, change);
      offer.set(path, change);
    } else if (UPSTREAM_SIDE.has(verdict)) {
      const theirs = upstreamNow.get(path) ?? null;
      into.set(path, { bytes: theirs?.bytes ?? null, executable: theirs?.executable ?? false });
    } else if (PROJECT_SIDE.has(verdict)) {
      offer.set(path, { bytes: mine?.bytes ?? null, executable: mine?.executable ?? false });
    }
  }
  return { into, offer };
}

/** The owner a repository address names (github.com/OWNER/..., git@host:OWNER/...); null for a local folder. */
export function ownerOf(repo: string): string | null {
  const scp = /^[^@\s/]+@[^:\s/]+:([^/\s]+)\//.exec(repo);
  if (scp) return scp[1].toLowerCase();
  if (!isReachableAddress(repo)) return null;
  const parts = new URL(repo).pathname.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[0].toLowerCase() : null;
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

const branchPart = (text: string): string => text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'project';

/** Offers `offer` upstream as branch sync/<project>/<tool> on the upstream commit (invariant 6). Null when it changes nothing. */
function offerUpstream(one: Computed, offer: Offer, projectName: string): { branch: string; commit: string; already: boolean } | null {
  const { repo, path, commit } = one.upstream!;
  const dir = one.commitDir!;
  const branch = `sync/${branchPart(projectName)}/${one.name}`;
  const ref = `refs/heads/${branch}`;
  const index = join(dir, '.git', `sync-index-${one.name}`);
  const env = { ...ENV, GIT_INDEX_FILE: index };
  try {
    git(dir, ['read-tree', commit], { env });
    for (const [relativePath, change] of offer) {
      const full = `${path}/${relativePath}`;
      if (change.bytes === null) { git(dir, ['update-index', '--force-remove', '--', full], { env }); continue; }
      const blob = git(dir, ['hash-object', '-w', '--stdin'], { input: change.bytes });
      git(dir, ['update-index', '--add', '--cacheinfo', `${change.executable ? '100755' : '100644'},${blob},${full}`], { env });
    }
    const tree = git(dir, ['write-tree'], { env });
    if (tree === git(dir, ['rev-parse', `${commit}^{tree}`])) return null;
    const when = git(dir, ['log', '-1', '--format=%cI', commit]);
    const message = `${projectName}'s copy of ${one.name}, offered upstream by tool:keep-tool-copies-in-step\n\n`
      + `Made on ${commit} (${path}); review and merge it as any change.\n`;
    const made = git(dir, ['commit-tree', tree, '-p', commit, '-F', '-'], { env: { ...ENV, ...SIGNER, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, input: Buffer.from(message) });
    const there = git(dir, ['ls-remote', repo, ref]).split('\n').map(l => l.split('\t')).find(([, name]) => name === ref)?.[0] ?? '';
    if (there === made) return { branch, commit: made, already: true };
    if (!branch.startsWith('sync/')) throw new Error(`refusing to push ${branch}: only sync/ branches are offered`);
    // push.negotiate: the push finds the upstream commit it is made on, so only the changed objects are sent.
    git(dir, ['-c', 'push.negotiate=true', 'push', '--no-verify', '--quiet', repo, `${made}:${ref}`, `--force-with-lease=${ref}:${there}`]);
    return { branch, commit: made, already: false };
  } finally {
    rmSync(index, { force: true });
  }
}

/** The project's git, for the branch an upstream change waits on: its top folder and the commit HEAD names. */
function projectGit(project: string): { top: string; head: string } | null {
  const inGit = spawnSync('git', ['-C', project, 'rev-parse', '--show-toplevel', 'HEAD'], { env: ENV });
  if (inGit.status !== 0) return null;
  const [top, head] = inGit.stdout.toString('utf8').trim().split('\n');
  return COMMIT.test(head ?? '') ? { top: realpathSync(top), head } : null;
}

/** The record text the add tool's writeProjectRecord writes for `record`, written into a fresh folder of the run's own. */
function recordBytes(scratch: string, record: RecordFile): Buffer {
  const folder = mkdtempSync(join(scratch, 'record-'));
  writeProjectRecord(folder, record, readProjectRecord(folder).expected, () => {});
  return readFileSync(join(folder, RECORD_FILE));
}

type Waiting = ApplyResult['waiting'][number];

/** One commit on the project's HEAD holding `tools`' upstream changes and their advanced record lines, kept as `branch`
 *  (compare-and-set on the ref) and pushed to the project's origin with a lease when it has one (invariant 4). */
function projectCommit(at: { top: string; head: string }, project: string, scratch: string, record: RecordFile,
  tools: Computed[], branch: string, push: (error: string) => void): string {
  const inTop = (path: string) => [relative(at.top, project), TOOLS_FOLDER, path].filter(Boolean).join('/');
  const env = { ...ENV, GIT_INDEX_FILE: join(scratch, `index-${tools.length}-${branch.replace(/\W+/g, '-')}`) };
  git(at.top, ['read-tree', at.head], { env });
  const lines = { ...record.tools };
  for (const one of tools) {
    for (const [path, change] of movesOf(one).into) {
      const full = inTop(`${one.name}/${path}`);
      if (change.bytes === null) { git(at.top, ['update-index', '--force-remove', '--', full], { env }); continue; }
      const blob = git(at.top, ['hash-object', '-w', '--stdin'], { input: change.bytes });
      git(at.top, ['update-index', '--add', '--cacheinfo', `${change.executable ? '100755' : '100644'},${blob},${full}`], { env });
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
  const blob = git(at.top, ['hash-object', '-w', '--stdin'], { input: recordBytes(scratch, { ...record, tools: lines }) });
  git(at.top, ['update-index', '--add', '--cacheinfo', `100644,${blob},${inTop(RECORD_FILE)}`], { env });
  const tree = git(at.top, ['write-tree'], { env });
  const when = git(at.top, ['log', '-1', '--format=%cI', at.head]);
  const sources = [...new Set(tools.map(one => one.upstream!.repo))].join(', ');
  const message = `${tools.map(one => one.name).join(', ')} from upstream, by tool:keep-tool-copies-in-step\n\nUpstream: ${sources}.\n`;
  const made = git(at.top, ['commit-tree', tree, '-p', at.head, '-F', '-'], { env: { ...ENV, ...SIGNER, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, input: Buffer.from(message) });
  const ref = `refs/heads/${branch}`;
  const before = spawnSync('git', ['-C', at.top, 'rev-parse', '--verify', '--quiet', ref], { env: ENV }).stdout.toString('utf8').trim();
  if (before !== made) git(at.top, ['update-ref', ref, made, before || '0'.repeat(40)]);
  const origin = spawnSync('git', ['-C', at.top, 'remote', 'get-url', 'origin'], { env: ENV });
  if (origin.status === 0) {
    const there = spawnSync('git', ['-C', at.top, 'ls-remote', 'origin', ref], { env: ENV }).stdout.toString('utf8').split('\t')[0].trim();
    if (there !== made) {
      const pushed = spawnSync('git', ['-C', at.top, 'push', '--no-verify', '--quiet', 'origin', `${made}:${ref}`, `--force-with-lease=${ref}:${there}`], { env: ENV });
      if (pushed.status !== 0) push(pushed.stderr.toString('utf8').trim());
    }
  }
  return made;
}

/** Whether the project's tests pass on `commit`: the record's `test` words run in an export of it. */
function testsOn(at: { top: string }, project: string, scratch: string, record: RecordFile, commit: string): { green: boolean; why: Waits; said: string } {
  const words = (record as { test?: unknown }).test;
  if (!Array.isArray(words) || words.length === 0 || !words.every(word => typeof word === 'string' && word.length > 0)) {
    return { green: false, why: 'no-test-command', said: `${RECORD_FILE} names no test (a list of words, for example ["npm","test"]), so no change merges on its own.` };
  }
  const tree = mkdtempSync(join(scratch, 'tests-'));
  git(at.top, ['--work-tree', tree, 'read-tree', '-u', '--reset', commit], { env: { ...ENV, GIT_INDEX_FILE: join(scratch, `tests-index-${basename(tree)}`) } });
  const [program, ...rest] = words as string[];
  const ran = spawnSync(program, rest, { cwd: join(tree, relative(at.top, project)), env: process.env, maxBuffer: 1 << 28, timeout: 900000 });
  if (ran.status === 0) return { green: true, why: 'tests-not-green', said: '' };
  const said = ran.error ? String(ran.error.message) : `${ran.stdout.toString('utf8')}${ran.stderr.toString('utf8')}`.trim().slice(-2000);
  return { green: false, why: 'tests-not-green', said: `${words.join(' ')} exited ${ran.status ?? 'without a code'}: ${said}` };
}

/** Lands project changes through the source's landing owner (invariant 6): its words, then one --edit per changed file
 *  (a file of the run's own on stdin's place) or --remove for a deleted one. The landed commit, from the owner's answer. */
function landThrough(owner: LandThrough, one: Computed, offer: Offer, projectName: string, scratch: string): string {
  const folder = mkdtempSync(join(scratch, 'land-'));
  const words = [...owner.command, '--lane', 'keep-tool-copies-in-step'];
  const messageFile = join(folder, 'message');
  writeFileSync(messageFile, `${projectName}'s copy of ${one.name}, landed by tool:keep-tool-copies-in-step\n\nThe project's edits of ${one.upstream!.path}, made on ${one.upstream!.commit}.\n`);
  words.push('--message-file', messageFile);
  [...offer].forEach(([relativePath, change], index) => {
    const full = `${one.upstream!.path}/${relativePath}`;
    if (change.bytes === null) { words.push('--remove', full); return; }
    const file = join(folder, `file-${index}`);
    writeFileSync(file, change.bytes);
    // The landing owner runs the command through a shell: the run's own file name is quoted (it holds no quote).
    words.push('--edit', `${full}=cat '${file}'`);
  });
  const [program, ...rest] = words;
  const ran = spawnSync(program, rest, { env: process.env, maxBuffer: 1 << 28 });
  const said = `${ran.stdout?.toString('utf8') ?? ''}${ran.stderr?.toString('utf8') ?? ''}`;
  const landed = /landed ([0-9a-f]{40})/.exec(said)?.[1];
  if (ran.status !== 0 || !landed) throw new GitRefused(`the landing owner did not land ${one.name}: ${(ran.error?.message ?? said).trim().slice(-1500)}`);
  return landed;
}

/** Settles what `plan` found (see the invariants above). */
export async function apply(input: { project: string; plan: PlanResult; clones?: string[]; land_through?: LandThrough[] }, io: Io = realIo(input.clones)): Promise<ApplyResult> {
  const project = realpathSync(input.project);
  const toolsFolder = join(project, TOOLS_FOLDER);
  const result: ApplyResult = { settled: [], forked: [], conflicts: [], unchanged: [], pushed: [], waiting: [], skipped: [], refused: [] };
  const planned = input.plan?.tools;
  if (!planned || typeof planned !== 'object' || typeof input.plan.record_blake3 !== 'string') throw new Error('apply needs plan: the answer of op plan.');
  const { expected, record } = readProjectRecord(toolsFolder);
  if (expected !== input.plan.record_blake3) {
    for (const tool of Object.keys(planned)) result.refused.push({ tool, why: 'record-changed-meanwhile', said: `${join(toolsFolder, RECORD_FILE)} changed after plan read it.` });
    return result;
  }
  return withScratch(async scratch => {
    const computed = await compareAll(project, record, Object.keys(planned), io, scratch);
    const settling: Computed[] = [];
    for (const one of computed) {
      if (canonicalJson(plannedOf(one)) !== canonicalJson(planned[one.name])) {
        result.refused.push({ tool: one.name, why: 'changed-since-plan', said: `${one.name} is ${one.state} now, not what plan found; plan again.` });
        continue;
      }
      if (one.state === 'forked') result.forked.push(one.name);
      else if (one.state === 'none-changed') result.unchanged.push(one.name);
      else if (one.state === 'skipped') result.skipped.push({ tool: one.name, why: one.why! });
      else if (one.state === 'refused') result.refused.push({ tool: one.name, why: one.why!, said: one.said! });
      else if (one.state === 'both-conflict') {
        for (const [path, diff] of one.diffs) result.conflicts.push({ tool: one.name, path, diff });
      } else settling.push(one);
    }

    // Upstream changes come to the project as a branch (invariant 4).
    const incoming = settling.filter(one => movesOf(one).into.size > 0 || canonicalJson({ c: one.line.copied_at_commit, f: one.line.files })
      !== canonicalJson({ c: one.upstream!.commit, f: one.fetched!.digests }));
    if (incoming.length) {
      const at = projectGit(project);
      const recordPath = join(toolsFolder, RECORD_FILE);
      const committed = at ? spawnSync('git', ['-C', at.top, 'diff', '--quiet', 'HEAD', '--', recordPath], { env: ENV }).status === 0 : false;
      if (!at) {
        for (const one of incoming) result.refused.push({ tool: one.name, why: 'not-a-git-project', said: `${project} is not a git checkout with a commit; an upstream change comes to a project only as a branch.` });
      } else if (!committed) {
        for (const one of incoming) result.refused.push({ tool: one.name, why: 'record-not-committed', said: `${recordPath} differs from HEAD; commit it first, so the branch is made on what the project holds.` });
      } else {
        const trust = new Set(((record as { trust?: unknown }).trust as unknown[] | undefined ?? []).filter((t): t is string => typeof t === 'string').map(t => t.toLowerCase()));
        const trusted = incoming.filter(one => { const owner = ownerOf(one.upstream!.repo); return owner !== null && trust.has(owner); });
        const untrusted = incoming.filter(one => !trusted.includes(one));
        const pushNote = (tools: Computed[]) => (said: string) => { for (const one of tools) result.refused.push({ tool: one.name, why: 'push-refused', said }); };
        const waits = (tools: Computed[], branch: string, commit: string, why: Waits, said: string): Waiting =>
          ({ tools: tools.map(one => one.name), branch, commit, why, said, pull_request: null });
        if (trusted.length) {
          const branch = 'sync/upstream/trusted';
          const commit = projectCommit(at, project, scratch, record, trusted, branch, pushNote(trusted));
          const tests = testsOn(at, project, scratch, record, commit);
          if (!tests.green) result.waiting.push(waits(trusted, branch, commit, tests.why, tests.said));
          else {
            const merged = spawnSync('git', ['-C', at.top, 'merge', '--ff-only', '--quiet', commit], { env: ENV });
            if (merged.status === 0) result.settled.push(...trusted.map(one => one.name));
            else result.waiting.push(waits(trusted, branch, commit, 'project-moved', `git merge --ff-only refused: ${merged.stderr.toString('utf8').trim().slice(-800)}`));
          }
        }
        for (const one of untrusted) {
          const branch = `sync/upstream/${one.name}`;
          const commit = projectCommit(at, project, scratch, record, [one], branch, pushNote([one]));
          result.waiting.push(waits([one], branch, commit, 'not-trusted', `The owner of ${one.upstream!.repo} is not in ${RECORD_FILE}'s trust list; the change waits on ${branch} for the project's owner.`));
        }
        result.gap = 'No GitHub key bound to api.github.com is held in the vault, so no pull request is opened: each waiting change is a branch only.';
      }
    }

    // Project changes go upstream (invariant 6).
    for (const one of settling) {
      const offer = movesOf(one).offer;
      if (!offer.size) continue;
      const owner = (input.land_through ?? []).find(entry => entry.repo === one.upstream!.repo);
      try {
        if (owner) result.pushed.push({ tool: one.name, repo: one.upstream!.repo, branch: null, commit: landThrough(owner, one, offer, basename(project), scratch), already: false, landed_by: owner.command.join(' ') });
        else {
          const offered = offerUpstream(one, offer, basename(project));
          if (offered) result.pushed.push({ tool: one.name, repo: one.upstream!.repo, ...offered });
        }
      } catch (error) {
        if (!(error instanceof GitRefused)) throw error;
        result.refused.push({ tool: one.name, why: owner ? 'landing-refused' : 'push-refused', said: error.message });
      }
    }
    return result;
  });
}

async function main(): Promise<void> {
  const [granted] = process.argv.slice(2);
  if (!granted) throw new Error('Usage: node do-work/sync.ts GRANTED-FOLDER < input.json');
  const input = JSON.parse(readFileSync(0, 'utf8')) as { op?: string; project?: string; only?: string[]; fact?: unknown; plan?: PlanResult; clones?: unknown; land_through?: LandThrough[] };
  const project = projectInGrant(granted, input.project ?? '.');
  // A local clone is read only from inside the granted folder, as the project is.
  if (input.clones !== undefined && (!Array.isArray(input.clones) || !input.clones.every(c => typeof c === 'string' && c.length > 0))) throw new Error('clones is a list of folder paths.');
  const clones = (input.clones as string[] | undefined ?? []).map(clone => projectInGrant(granted, clone));
  let output: unknown;
  if (input.op === 'plan') output = await plan({ project, only: input.only, fact: input.fact, clones });
  else if (input.op === 'apply') {
    const landThroughInput = input.land_through ?? [];
    if (!Array.isArray(landThroughInput) || !landThroughInput.every(entry => entry && typeof entry.repo === 'string' && Array.isArray(entry.command) && entry.command.length > 0 && entry.command.every(word => typeof word === 'string' && word.length > 0))) {
      throw new Error('land_through is a list of {repo, command}: command is the words that start the landing owner.');
    }
    output = await apply({ project, plan: input.plan as PlanResult, clones, land_through: landThroughInput });
  }
  else throw new Error('op is plan or apply.');
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`); process.exitCode = 2; });
}
