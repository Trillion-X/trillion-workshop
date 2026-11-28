// tools/keep-tool-copies-in-step/do-work/sync.ts
//
// PURPOSE
//   tool:keep-tool-copies-in-step. For every tool folder a project copied into its own tools folder (TOOLS_FOLDER, the add
//   tool's), compares three versions: the base (the files its record where-each-tool-comes-from.json says the copy started from), the
//   project's folder now, and the upstream folder at the newest commit its pointer names (the registry's pointer, or the
//   repository's HEAD for a direct pointer). `plan` says what each tool's state is and writes nothing. `apply` settles the
//   safe states: it takes upstream changes into the project, offers project changes upstream on a branch, refuses
//   conflicts with their diff, and skips forks.
//
//   node do-work/sync.ts GRANTED-FOLDER   < {"op": "plan", "project"?, "only"?, "fact"?, "clones"?}
//                                         < {"op": "apply", "project"?, "plan": <plan's answer>, "clones"?}
//     prints one JSON answer; exits 0 when it answered (a conflict is an answer), 2 when it could not run
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing a person wrote is overwritten. A tool with any both-conflict file is left byte for byte as it was, the files
//      that would have merged cleanly included, and is reported with each conflicting file's diff.
//   2. `synced: false` (a fork) is skipped before anything is read about it: no registry read, no fetch, no file read.
//   3. A three-way-different file is decided from the base BYTES (fetched at the record's copied_at_commit), never from
//      hashes alone; a base that cannot be fetched makes it a conflict. git merge-file's non-zero exit is a conflict and its
//      output is never written (read-data/merge-text.ts).
//   4. One record write per apply, a compare-and-set on the BLAKE3 of the record text plan read (the add tool's
//      writeProjectRecord). Inside its lock every file to be replaced is checked to still hold what plan read, then the
//      staged files are renamed into place. A record or a file that moved meanwhile refuses the apply and writes nothing.
//   5. A tool's record line advances (copied_at_commit, copied_at_files_blake3, files) only when the tool settled with no
//      conflict, and then to exactly the upstream version it was compared with.
//   6. Upstream is offered changes only as a branch `sync/<project>/<tool>` made on the upstream commit, pushed with
//      --force-with-lease naming the branch's sha read just before; never a default branch, never a plain force push. The
//      branch commit is deterministic (same parent, tree, message and times), so offering the same change again is a no-op.
//   7. Fetch, hash and record code is the add tool's (tools/add-a-tool-to-a-project/read-data), imported, never copied:
//      a local clone named in `clones` that holds a commit, or whose origin is the registry address a record line names,
//      is read instead of the network, exactly as the add tool reads it. Nothing is imported from outside the Workshop.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigest, identityOfDigests } from '../../content-identity/read-data/manifest.mjs';
import { canonicalJson } from '../../content-identity/read-data/identity.mjs';
import { BadFrom, readRegistry, type Hex64, type Registry } from '../../add-a-tool-to-a-project/read-data/registry.ts';
import { FetchedCommit, GitRefused, NotAtCommit, type Fetched, type FileMap } from '../../add-a-tool-to-a-project/read-data/fetch-folder.ts';
import { RECORD_FILE, RecordChanged, TOOLS_FOLDER, readProjectRecord, writeProjectRecord, type RecordFile, type ToolRecord } from '../../add-a-tool-to-a-project/read-data/record.ts';
import { projectInGrant } from '../../add-a-tool-to-a-project/do-work/add.ts';
import { classifyTool, type Rename, type ToolVerdict, type Verdict } from '../read-data/classify.ts';
import { mergeText, threeWayDiff } from '../read-data/merge-text.ts';

export type ToolState = ToolVerdict | 'forked' | 'skipped' | 'refused';
export type Why = 'made-here' | 'not-in-registry' | 'bad-from' | 'fetch-refused' | 'identity-mismatch' | 'no-base'
  | 'record-changed-meanwhile' | 'changed-since-plan' | 'push-refused';
export type PlannedTool = { state: ToolState; files: Record<string, Verdict>; upstream_commit: string | null; renames?: Rename[]; why?: Why; said?: string };
export type PlanResult = { record_blake3: string; because?: { where?: string; place?: string; key?: string }; tools: Record<string, PlannedTool> };
export type PlanInput = { project: string; only?: string[]; fact?: unknown; clones?: string[] };
export type ApplyResult = {
  settled: string[];
  forked: string[];
  conflicts: { tool: string; path: string; diff: string }[];
  unchanged: string[];
  pushed: { tool: string; branch: string; repo: string; commit: string; already: boolean }[];
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
      if (error instanceof BadFrom) { computed.push(refused('bad-from', error.message)); continue; }
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
type Write = { tool: string; path: string; bytes: Uint8Array | null; executable: boolean; expect: Hex64 | null };
type Offer = Map<string, { bytes: Uint8Array | null; executable: boolean }>;

/** The disk writes that take upstream's side into the project, and the files offered upstream, for one settling tool. */
function movesOf(one: Computed): { writes: Write[]; offer: Offer } {
  const writes: Write[] = [];
  const offer: Offer = new Map();
  const upstreamNow = fileMapOf(one.fetched!);
  for (const [path, verdict] of Object.entries(one.files)) {
    const mine = one.project.get(path) ?? null;
    const expect = mine ? fileDigest(mine.bytes) : null;
    if (verdict === 'both-clean') {
      const bytes = one.merged.get(path)!;
      const executable = mine?.executable ?? false;
      writes.push({ tool: one.name, path, bytes, executable, expect });
      offer.set(path, { bytes, executable });
    } else if (UPSTREAM_SIDE.has(verdict)) {
      const theirs = upstreamNow.get(path) ?? null;
      writes.push({ tool: one.name, path, bytes: theirs?.bytes ?? null, executable: theirs?.executable ?? false, expect });
    } else if (PROJECT_SIDE.has(verdict)) {
      offer.set(path, { bytes: mine?.bytes ?? null, executable: mine?.executable ?? false });
    }
  }
  return { writes, offer };
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

/** Removes the folders a deletion left empty, up to (not including) `stop`. */
function pruneEmpty(folder: string, stop: string): void {
  for (let at = folder; at.startsWith(`${stop}/`) && existsSync(at) && readdirSync(at).length === 0; at = dirname(at)) rmdirSync(at);
}

/** Settles what `plan` found (see the invariants above). */
export async function apply(input: { project: string; plan: PlanResult; clones?: string[] }, io: Io = realIo(input.clones)): Promise<ApplyResult> {
  const project = realpathSync(input.project);
  const toolsFolder = join(project, TOOLS_FOLDER);
  const result: ApplyResult = { settled: [], forked: [], conflicts: [], unchanged: [], pushed: [], skipped: [], refused: [] };
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

    const writes: Write[] = [];
    const offers = new Map<string, Offer>();
    const lines: Record<string, ToolRecord> = {};
    for (const one of settling) {
      const moves = movesOf(one);
      writes.push(...moves.writes);
      if (moves.offer.size) offers.set(one.name, moves.offer);
      const advanced: ToolRecord = { ...one.line, copied_at_commit: one.upstream!.commit, copied_at_files_blake3: one.fetched!.files_blake3,
        files: one.fetched!.digests, ...(typeof one.line.from === 'object' && 'repo' in one.line.from ? { from: { ...one.line.from, commit: one.upstream!.commit } } : {}) };
      if (canonicalJson(advanced) !== canonicalJson(one.line)) lines[one.name] = advanced;
    }

    if (Object.keys(lines).length || writes.length) {
      const tools = { ...record.tools, ...lines };
      for (const [name, line] of Object.entries(tools)) {
        const reached = reach(name, tools);
        if (!line.closure_blake3 || !reached.some(folder => lines[folder])) continue;
        tools[name] = { ...line, closure_blake3: identityOfDigests(reached.map((folder): [string, string] => [folder, tools[folder].copied_at_files_blake3!])) };
      }
      const staging = join(toolsFolder, `.syncing-${process.pid}-${Date.now()}`);
      mkdirSync(staging);
      try {
        writes.forEach((write, index) => { if (write.bytes !== null) writeFileSync(join(staging, String(index)), write.bytes); });
        writeProjectRecord(toolsFolder, { ...record, tools }, expected, () => {
          for (const write of writes) {
            const at = join(toolsFolder, write.tool, ...write.path.split('/'));
            const now = existsSync(at) && lstatSync(at).isFile() ? fileDigest(readFileSync(at)) : null;
            if (now !== write.expect) throw new RecordChanged(`${at} changed after plan read it.`);
          }
          writes.forEach((write, index) => {
            const at = join(toolsFolder, write.tool, ...write.path.split('/'));
            if (write.bytes === null) { unlinkSync(at); pruneEmpty(dirname(at), join(toolsFolder, write.tool)); return; }
            mkdirSync(dirname(at), { recursive: true });
            renameSync(join(staging, String(index)), at);
            chmodSync(at, write.executable ? 0o755 : 0o644);
          });
        });
      } catch (error) {
        if (!(error instanceof RecordChanged)) throw error;
        for (const one of settling) result.refused.push({ tool: one.name, why: 'record-changed-meanwhile', said: error.message });
        return result;
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    for (const one of settling) if (lines[one.name] || writes.some(write => write.tool === one.name)) result.settled.push(one.name);

    for (const one of settling) {
      const offer = offers.get(one.name);
      if (!offer) continue;
      try {
        const offered = offerUpstream(one, offer, basename(project));
        if (offered) result.pushed.push({ tool: one.name, repo: one.upstream!.repo, ...offered });
      } catch (error) {
        if (!(error instanceof GitRefused)) throw error;
        result.refused.push({ tool: one.name, why: 'push-refused', said: error.message });
      }
    }
    return result;
  });
}

async function main(): Promise<void> {
  const [granted] = process.argv.slice(2);
  if (!granted) throw new Error('Usage: node do-work/sync.ts GRANTED-FOLDER < input.json');
  const input = JSON.parse(readFileSync(0, 'utf8')) as { op?: string; project?: string; only?: string[]; fact?: unknown; plan?: PlanResult; clones?: unknown };
  const project = projectInGrant(granted, input.project ?? '.');
  // A local clone is read only from inside the granted folder, as the project is.
  if (input.clones !== undefined && (!Array.isArray(input.clones) || !input.clones.every(c => typeof c === 'string' && c.length > 0))) throw new Error('clones is a list of folder paths.');
  const clones = (input.clones as string[] | undefined ?? []).map(clone => projectInGrant(granted, clone));
  let output: unknown;
  if (input.op === 'plan') output = await plan({ project, only: input.only, fact: input.fact, clones });
  else if (input.op === 'apply') output = await apply({ project, plan: input.plan as PlanResult, clones });
  else throw new Error('op is plan or apply.');
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`); process.exitCode = 2; });
}
