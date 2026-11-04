// tools/publish-an-engine-release/do-work/publish-an-engine-release.mjs
//
// `tool:publish-an-engine-release` (tool-rows.json), run on the builder computer: fetch the repository's branch,
// check the commit is on its first-parent line, number it (git rev-list --count --first-parent), build the engine
// with `cargo build --release --bin trillion-local` for the builder's own rust target, pack the program and the
// repository's product/ folder as a tar.gz, name it by its BLAKE3 identity, sign the entry with the builder's key, put
// the tar.gz at <feed folder>/<commit>/<target>.tar.gz and add the entry to feed.json in one rename. A commit older
// than the feed's newest release for the same target is refused before anything is built, and again under the
// feed's lock, so an older commit never wins. Each computer adopts from the feed itself (engine job J1).
//
// The repository URL, branch and builder are input; this file names none. The repository token arrives on
// descriptor 3 only: git reads it through a credential helper that reads that descriptor, so it never reaches argv,
// a file, the environment, a log or the answer.
//
// usage: publish-an-engine-release.mjs publish REQUEST_FILE [--commit COMMIT] | make-key KEY_FILE | public-key KEY_FILE
import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { tarGz } from '../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';
import { addRelease, checkCommit, checkTarget, mayPublish, newSigningKey, publicKeyHex, readFeed, settings, signEntry } from './release-feed.mjs';

const refuse = (message, exit = 1) => Object.assign(new Error(message), { exit });
const absolute = (path, what) => {
  if (typeof path !== 'string' || !isAbsolute(path)) throw refuse(`${what} must be an absolute path.`, 2);
  return path;
};

// The credential helper git runs: on `get` it answers the token read from descriptor 3, which git and the helper
// inherit from this process; it ignores `store` and `erase`. The token is in neither this text nor argv.
export const CREDENTIAL_HELPER = '!f() { test "$1" = get || exit 0; t=$(cat <&3) || exit 0; test -n "$t" || exit 0; printf "username=x-access-token\\npassword=%s\\n" "$t"; }; f';

/** Run a program; answers its stdout. `token` (when given) is written to the child's descriptor 3 and closed. */
export function runProgram(program, args, { cwd, env = process.env, token, timeout = settings.git_timeout_ms, log } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe', ...(token !== undefined ? ['pipe'] : [])] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', bytes => { out += bytes; if (log) log.write(bytes); });
    child.stderr.on('data', bytes => { err = (err + bytes).slice(-8192); if (log) log.write(bytes); });
    child.on('error', error => { clearTimeout(timer); reject(error.code === 'ENOENT' ? refuse(`${program} is not on this computer's PATH: the builder needs it (install sets it up).`) : error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(refuse(`\`${[program, ...args.filter(arg => !arg.startsWith('credential.helper'))].slice(0, 4).join(' ')}\` ${signal ? `was stopped (${signal})` : `exited ${code}`}: ${err.trim().split('\n').slice(-4).join(' | ')}`));
    });
    if (token !== undefined) { child.stdio[3].on('error', () => {}); child.stdio[3].end(token); }
  });
}

const git = (folder, args, options = {}) => runProgram('git', ['-C', folder, ...args], options);

/** The repository at the branch's tip in WORK/source, fetched with the token; answers the branch tip. */
export async function fetchRepository({ repository, branch, source, token }) {
  if (!existsSync(join(source, '.git'))) { mkdirSync(source, { recursive: true }); await git(source, ['init', '-q']); }
  const remotes = (await git(source, ['remote'])).split('\n');
  await git(source, remotes.includes('origin') ? ['remote', 'set-url', 'origin', repository] : ['remote', 'add', 'origin', repository]);
  await git(source, ['-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`, '-c', 'core.askPass=true',
    'fetch', '-q', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { token: token ?? '', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return (await git(source, ['rev-parse', `refs/remotes/origin/${branch}`])).trim();
}

/** The commit's sequence: its count of first-parent commits, refused unless it is on the branch's first-parent line. */
export async function sequenceOf({ source, branch, commit }) {
  const line = (await git(source, ['rev-list', '--first-parent', `refs/remotes/origin/${branch}`])).split('\n');
  if (!line.includes(commit)) throw refuse(`Commit ${commit} is not on ${branch}'s first-parent line: only a commit the branch itself moved to is published.`, 3);
  return Number((await git(source, ['rev-list', '--count', '--first-parent', commit])).trim());
}

/** The builder's own rust target, the host line of `rustc -vV`. */
export async function hostTarget(rustc = 'rustc', env = process.env) {
  const host = (await runProgram(rustc, ['-vV'], { env })).split('\n').find(line => line.startsWith('host: '));
  return checkTarget(host?.slice(6).trim());
}

/** The files under `paths` (relative to `root`) as tarGz entries; folders named in `skip` are left out. */
export function filesUnder(root, paths, skip = []) {
  return paths.flatMap(path => {
    const status = lstatSync(join(root, path));
    if (status.isDirectory()) return skip.includes(basename(path)) ? [] : filesUnder(root, readdirSync(join(root, path)).map(name => `${path}/${name}`), skip);
    if (!status.isFile()) throw refuse(`${path} is neither a file nor a folder: a release holds only files.`);
    return [{ name: path, bytes: readFileSync(join(root, path)), executable: Boolean(status.mode & 0o100) }];
  });
}

/** Pack the program and product/ as tar.gz into `file`; answers { content, bytes }. */
export function packRelease({ program, source, file }) {
  const packed = tarGz([...filesUnder(dirname(program), [settings.binary]), ...filesUnder(source, [settings.product_folder])]);
  writeFileSync(file, packed, { mode: 0o644 });
  return { content: makeHashCodeHexFromBytes(packed), bytes: packed.length };
}

/** The signing key, refused when anyone but its owner may read it. */
export function readSigningKey(file) {
  const mode = statSync(absolute(file, 'key_file')).mode & 0o777;
  if (mode & 0o077) throw refuse(`The signing key ${file} may be read by others (mode ${mode.toString(8)}): it must be ${settings.key_file_mode.toString(8)}.`);
  return readFileSync(file, 'utf8');
}

/** Make the builder's signing key once (0400); answers its public key. A key already there is kept. */
export function makeKey(file) {
  absolute(file, 'KEY_FILE');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(file, 'wx', settings.key_file_mode);
    try { writeSync(fd, newSigningKey()); fsyncSync(fd); } finally { closeSync(fd); }
    return { public_key: publicKeyHex(readSigningKey(file)), made: true };
  }
  return { public_key: publicKeyHex(readSigningKey(file)), made: false };
}

/** Hold the feed folder's lock while `work` runs; a lock left by a process that is gone is taken over. */
export async function withFeedLock(feedFolder, work) {
  const lock = join(feedFolder, '.publish.lock');
  for (let tries = 0; ; tries++) {
    try { const fd = openSync(lock, 'wx', 0o600); writeSync(fd, String(process.pid)); closeSync(fd); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || tries > 1) throw refuse(`The feed is locked by ${lock}: another publish is running; if none is, remove that file.`);
      const holder = Number(readFileSync(lock, 'utf8'));
      let alive = false;
      try { process.kill(holder, 0); alive = true; } catch (gone) { alive = gone.code === 'EPERM'; }
      if (alive) throw refuse(`Another publish (process ${holder}) holds the feed's lock: wait for it to finish.`);
      rmSync(lock, { force: true });
    }
  }
  try { return await work(); } finally { rmSync(lock, { force: true }); }
}

/** Write a file by a rename, so a reader sees the old file or the new one, never part of one. */
export function writeAtomically(file, text) {
  const part = `${file}.${process.pid}.part`, fd = openSync(part, 'w', 0o644);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(part, file);
}

const readText = file => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const feedFile = folder => join(folder, settings.feed_file);
const tarballOf = (feedFolder, commit, target) => join(feedFolder, checkCommit(commit), `${checkTarget(target)}.tar.gz`);

/** Publish one commit: build, pack, sign, and add it to the feed. */
export async function publish(request, { token = '', commit: asked } = {}) {
  const { repository, branch } = request;
  if (typeof repository !== 'string' || !repository) throw refuse('The request names no repository: send repository, the URL git fetches.', 2);
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes('..')) throw refuse('The request names no branch git can fetch: send branch, like main.', 2);
  if (typeof request.base_url !== 'string' || !/^https:\/\/[^/]+\/.*\/$/.test(request.base_url)) throw refuse('base_url must be the https address the feed folder is served at, ending in /.', 2);
  const work = absolute(request.work_folder, 'work_folder'), feedFolder = absolute(request.feed_folder, 'feed_folder');
  const privateKey = readSigningKey(absolute(request.key_file, 'key_file')), publicKey = publicKeyHex(privateKey);
  const source = join(work, 'source'), targetDir = join(work, 'target');
  mkdirSync(feedFolder, { recursive: true, mode: 0o755 });
  const tip = await fetchRepository({ repository, branch, source, token });
  const commit = checkCommit(asked ?? tip);
  const sequence = await sequenceOf({ source, branch, commit });
  const env = { ...process.env, TRILLION_RELEASE_COMMIT: commit, TRILLION_RELEASE_SEQUENCE: String(sequence), CARGO_TARGET_DIR: targetDir };
  const target = await hostTarget(request.toolchain?.rustc ?? 'rustc', env);
  const before = mayPublish(readFeed(readText(feedFile(feedFolder))), { commit, sequence, target });
  if (before.already) return answerOf(before.already, { publicKey, already: true, dropped: 0, held: readFeed(readText(feedFile(feedFolder))).releases.length });

  await git(source, ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--force', '--detach', commit]);
  await git(source, ['clean', '-q', '-ffdx']);
  const trailer = (await git(source, ['log', '-1', `--format=%(trailers:key=${settings.urgent_trailer},valueonly)`, commit])).trim().toLowerCase();
  const urgent = request.urgent === true || trailer.split('\n').includes('true');
  if (!existsSync(join(source, settings.product_folder))) throw refuse(`Commit ${commit} has no ${settings.product_folder}/ folder: a release holds ${settings.binary} and ${settings.product_folder}/.`);
  const log = createWriteStream(join(work, 'build.log'));
  try {
    await runProgram(request.toolchain?.cargo ?? 'cargo', ['build', '--release', '--bin', settings.binary], { cwd: source, env, timeout: settings.build_timeout_ms, log });
  } finally { log.end(); }
  const program = join(targetDir, 'release', settings.binary);
  if (!existsSync(program)) throw refuse(`cargo finished but made no ${program}: the repository's package must have a ${settings.binary} binary.`);

  const file = tarballOf(feedFolder, commit, target), part = `${file}.${process.pid}.part`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  const { content, bytes } = packRelease({ program, source, file: part });
  const entry = signEntry({ commit, sequence, target, url: `${request.base_url}${commit}/${target}.tar.gz`, content, bytes, urgent }, privateKey);

  return withFeedLock(feedFolder, async () => {
    const now = readFeed(readText(feedFile(feedFolder)));
    let result;
    try { result = addRelease(now, entry, request.keep_releases ?? settings.keep_releases); }
    catch (error) { rmSync(part, { force: true }); throw error; }
    if (!result.added) { rmSync(part, { force: true }); return answerOf(result.entry, { publicKey, already: true, dropped: 0, held: now.releases.length }); }
    renameSync(part, file);
    writeAtomically(feedFile(feedFolder), `${JSON.stringify(result.feed, null, 1)}\n`);
    for (const gone of result.dropped) {
      const old = tarballOf(feedFolder, gone.commit, gone.target);
      rmSync(old, { force: true });
      try { rmdirSync(dirname(old)); } catch { /* another target's release is still in that folder */ }
    }
    return answerOf(entry, { publicKey, already: false, dropped: result.dropped.length, held: result.feed.releases.length });
  });
}

const answerOf = (entry, { publicKey, already, dropped, held }) => ({ ...entry, public_key: publicKey, already_published: already, dropped, releases_held: held });

/** The request read from its file, each path resolved against the file's own folder. */
export function readRequest(file) {
  const request = JSON.parse(readFileSync(absolute(file, 'REQUEST_FILE'), 'utf8')), here = dirname(file);
  for (const key of ['work_folder', 'feed_folder', 'key_file']) if (typeof request[key] === 'string') request[key] = resolvePath(here, request[key]);
  return request;
}

/** Descriptor `fd`'s text, bounded; a descriptor nobody opened is empty. When the caller opens no descriptor 3, the
 *  number may hold one Node opened for itself (its event loop's epoll on Linux, kqueue on macOS), and reading that
 *  fails in a way that differs by system, so only a pipe, socket or file the caller handed in is read. */
export async function privateInput(fd) {
  let text = '';
  try {
    const kind = fstatSync(fd);
    if (!kind.isFIFO() && !kind.isSocket() && !kind.isFile()) return '';
  } catch (error) { if (error.code === 'EBADF') return ''; throw error; }
  try {
    for await (const bytes of createReadStream(null, { fd, autoClose: false })) {
      text += bytes;
      if (text.length > settings.private_input_bytes_at_most) throw refuse(`Descriptor ${fd} holds more than its bound.`);
    }
  } catch (error) { if (error.code === 'EBADF' || error.code === 'EINVAL') return ''; throw error; }
  return text.trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, first, ...rest] = process.argv.slice(2);
  const usage = 'usage: publish-an-engine-release.mjs publish REQUEST_FILE [--commit COMMIT] (repository token on fd 3) | make-key KEY_FILE | public-key KEY_FILE';
  try {
    let answer;
    if (operation === 'publish' && first && (rest.length === 0 || (rest.length === 2 && rest[0] === '--commit'))) {
      answer = await publish(readRequest(resolvePath(first)), { token: await privateInput(3), commit: rest[1] });
    } else if (operation === 'make-key' && first && rest.length === 0) answer = makeKey(resolvePath(first));
    else if (operation === 'public-key' && first && rest.length === 0) answer = { public_key: existsSync(resolvePath(first)) ? publicKeyHex(readSigningKey(resolvePath(first))) : null };
    else throw refuse(usage, 2);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
