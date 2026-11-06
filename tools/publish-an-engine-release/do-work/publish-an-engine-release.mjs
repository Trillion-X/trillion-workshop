// tools/publish-an-engine-release/do-work/publish-an-engine-release.mjs
//
// `tool:publish-an-engine-release` (tool-rows.json), run on the builder computer: fetch the repository's branch,
// check the commit is on its first-parent line, number it (its commit time, git show -s --format=%ct), build the engine
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
// `accept` takes another builder's signed entry, for that builder's own target, into this same feed (`accept` below):
// one feed holds every target, and a target is only the entry's data.
//
// usage: publish-an-engine-release.mjs publish REQUEST_FILE [--commit COMMIT] | accept REQUEST_FILE ENTRY_FILE BODY_FILE
//        | make-key KEY_FILE | public-key KEY_FILE
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { tarGz } from '../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';
import { addRelease, checkCommit, checkEntry, checkTarget, mayPublish, newSigningKey, publicKeyHex, readFeed, settings, signEntry, signerOf } from './release-feed.mjs';

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

/**
 * The commit's sequence: its commit time in seconds, refused unless it is on the branch's first-parent line. This is the
 * one numbering every engine build uses: the Mac app stamps the engine it carries the same way (trillion-apps
 * scripts/release-macos-app.sh, `git show -s --format=%ct`), so a release from this feed runs on a Mac only when it is
 * newer than the engine the app carries, and the computers that already follow the feed see a larger number.
 */
export async function sequenceOf({ source, branch, commit }) {
  const line = (await git(source, ['rev-list', '--first-parent', `refs/remotes/origin/${branch}`])).split('\n');
  if (!line.includes(commit)) throw refuse(`Commit ${commit} is not on ${branch}'s first-parent line: only a commit the branch itself moved to is published.`, 3);
  return commitTime(source, commit);
}

/** A commit's time in seconds: the one sequence rule every engine build uses (see sequenceOf). */
export async function commitTime(source, commit) {
  return Number((await git(source, ['show', '-s', '--format=%ct', commit])).trim());
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

/** Pack the program, and product/ when the commit has one, as tar.gz into `file`; answers { content, bytes }. */
export function packRelease({ program, source, file }) {
  const product = existsSync(join(source, settings.product_folder)) ? filesUnder(source, [settings.product_folder]) : [];
  const packed = tarGz([...filesUnder(dirname(program), [settings.binary]), ...product]);
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

/** Hold the feed folder's lock while `work` runs; a lock left by a process that is gone is taken over, and one a live
 *  process holds (another target's publish or accept adding its entry) is waited for, at most `feed_lock_wait_ms`. */
export async function withFeedLock(feedFolder, work, waitMs = settings.feed_lock_wait_ms) {
  const lock = join(feedFolder, '.publish.lock'), until = Date.now() + waitMs;
  for (;;) {
    try { const fd = openSync(lock, 'wx', 0o600); writeSync(fd, String(process.pid)); closeSync(fd); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw refuse(`The feed's lock ${lock} could not be made: ${error.message}`);
      let holder = NaN;
      try { holder = Number(readFileSync(lock, 'utf8')); } catch { continue; /* the holder just let go */ }
      let alive = false;
      try { process.kill(holder, 0); alive = true; } catch (gone) { alive = gone.code === 'EPERM'; }
      if (!alive) { rmSync(lock, { force: true }); continue; }
      if (Date.now() >= until) throw refuse(`Another publish (process ${holder}) holds the feed's lock: wait for it to finish.`);
      await new Promise(resolve => setTimeout(resolve, 100));
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
export async function publish(request, { token = '', commit: asked, credentials = process.env.CREDENTIALS_DIRECTORY } = {}) {
  const { repository, branch } = request;
  if (typeof repository !== 'string' || !repository) throw refuse('The request names no repository: send repository, the URL git fetches.', 2);
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes('..')) throw refuse('The request names no branch git can fetch: send branch, like main.', 2);
  if (typeof request.base_url !== 'string' || !/^https:\/\/[^/]+\/.*\/$/.test(request.base_url)) throw refuse('base_url must be the https address the feed folder is served at, ending in /.', 2);
  const work = absolute(request.work_folder, 'work_folder'), feedFolder = absolute(request.feed_folder, 'feed_folder');
  const privateKey = readSigningKey(absolute(request.key_file, 'key_file')), publicKey = publicKeyHex(privateKey);
  const source = join(work, 'source'), targetDir = join(work, 'target');
  mkdirSync(feedFolder, { recursive: true, mode: 0o755 });
  const darwin = darwinOf(request, credentials);
  const tip = await fetchRepository({ repository, branch, source, token });
  const commit = checkCommit(asked ?? tip);
  const sequence = await sequenceOf({ source, branch, commit });
  const env = buildEnvironment({ commit, sequence, targetDir });
  const target = await hostTarget(request.toolchain?.rustc ?? 'rustc', env);
  const feedNow = () => readFeed(readText(feedFile(feedFolder)));
  const before = mayPublish(feedNow(), { commit, sequence, target });
  if (before.already && !darwin) return answerOf(before.already, { publicKey, already: true, dropped: 0, held: feedNow().releases.length });

  await git(source, ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--force', '--detach', commit]);
  await git(source, ['clean', '-q', '-ffdx']);
  const trailer = (await git(source, ['log', '-1', `--format=%(trailers:key=${settings.urgent_trailer},valueonly)`, commit])).trim().toLowerCase();
  const urgent = request.urgent === true || trailer.split('\n').includes('true');
  const log = createWriteStream(join(work, 'build.log'));
  try {
    let answer;
    if (before.already) answer = answerOf(before.already, { publicKey, already: true, dropped: 0, held: feedNow().releases.length });
    else {
      await runProgram(request.toolchain?.cargo ?? 'cargo', ['build', '--release', '--bin', settings.binary], { cwd: source, env, timeout: settings.build_timeout_ms, log });
      const program = join(targetDir, 'release', settings.binary);
      if (!existsSync(program)) throw refuse(`cargo finished but made no ${program}: the repository's package must have a ${settings.binary} binary.`);
      answer = await packSignAndAdd({ request, feedFolder, source, program, privateKey, publicKey, fields: { commit, sequence, target, urgent } });
    }
    if (!darwin) return answer;
    // Each Mac target is its own entry in this same feed: one that fails (or is older) leaves the others as they are.
    const also = [];
    for (const one of darwin.targets) {
      try { also.push(await publishDarwin({ request, darwin, source, work, targetDir, env, log, feedFolder, feedNow, privateKey, publicKey, fields: { commit, sequence, target: one, urgent } })); }
      catch (error) { also.push({ target: one, error: error.message }); }
    }
    return { ...answer, also };
  } finally { log.end(); }
}

/** The environment a build sees: this process's, less the service's credentials folder (the build runs the
 *  repository's own build scripts, which have no business with the signing identity), with the release values. */
export function buildEnvironment({ commit, sequence, targetDir }) {
  const { CREDENTIALS_DIRECTORY: _credentials, ...rest } = process.env;
  return { ...rest, TRILLION_RELEASE_COMMIT: commit, TRILLION_RELEASE_SEQUENCE: String(sequence), CARGO_TARGET_DIR: targetDir };
}

/** Pack a built program, sign its entry and add it to the feed under the lock. */
async function packSignAndAdd({ request, feedFolder, source, program, privateKey, publicKey, fields }) {
  const { commit, target } = fields;
  const file = tarballOf(feedFolder, commit, target), part = `${file}.${process.pid}.part`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  const { content, bytes } = packRelease({ program, source, file: part });
  const entry = signEntry({ commit, sequence: fields.sequence, target, url: `${request.base_url}${commit}/${target}.tar.gz`, content, bytes, urgent: fields.urgent }, privateKey);
  return addUnderLock({ request, feedFolder, entry, part, file, publicKey });
}

const D = settings.darwin;

/**
 * Hold what `rcodesign print-signature-info` read back from a signed program to the requirement trillion-apps
 * CarriedCode.checkRelease admits a feed release by, clause by clause:
 *   `anchor apple generic`                              the leaf chains to an Apple root (`chains_to_apple_root_ca`),
 *   `certificate leaf[field.1.2.840.113635.100.6.1.13]` the leaf has the Developer ID Application extension,
 *   `certificate leaf[subject.OU] = "<team>"`           the leaf's subject OU (`apple_team_id`) is the app's team;
 * and, as the app's own engine is signed, every code directory has the hardened runtime flag, the identifier is the
 * program's name and the team name is the team. Answers nothing; anything else is refused before the entry is signed.
 */
export function checkDeveloperId(info, team) {
  const fail = why => { throw refuse(`The signed ${settings.binary} does not meet the Mac app's Developer ID requirement: ${why}.`); };
  const values = key => [...info.matchAll(new RegExp(`^\\s*-?\\s*${key}:\\s*(.*?)\\s*$`, 'gm'))].map(match => match[1].replace(/^['"]|['"]$/g, ''));
  const flags = values('flags');
  if (!flags.length) fail('it has no code directory');
  if (!flags.every(one => /\bRUNTIME\b/.test(one))) fail(`a code directory lacks the hardened runtime (flags ${flags.join(', ')})`);
  if (!values('identifier').every(one => one === settings.binary)) fail(`its identifier is not ${settings.binary}`);
  const leaf = info.split(/^\s*- subject:/m).slice(1).find(block => new RegExp(`^\\s*apple_team_id:\\s*['"]?${team}['"]?\\s*$`, 'm').test(block));
  if (!leaf) fail(`no certificate in its signature has the subject OU ${team}`);
  if (!/^\s*chains_to_apple_root_ca:\s*true\s*$/m.test(leaf)) fail('its leaf certificate does not chain to an Apple root');
  if (!/^\s*-\s*['"]?Developer ID Application['"]?\s*$/m.test(leaf)) fail(`its leaf certificate has no Developer ID Application extension (${D.developer_id_oid})`);
  // rcodesign writes the team into the code directory only for an Apple-issued certificate, as codesign does.
  const teams = values('team_name');
  if (!teams.length || !teams.every(one => one === team)) fail(`its code directory's team is ${teams.join(', ') || 'none'}, not ${team}`);
  const verifies = values('signature_verifies');
  if (!verifies.length || !verifies.every(one => one === 'true')) fail('its CMS signature does not verify');
}

/**
 * The config's Mac targets, checked, or null when it names none. `credentials` is the folder systemd opened the
 * receiver's credentials in ($CREDENTIALS_DIRECTORY); the identity and its password are files there, named by
 * settings.darwin.credentials, read by rcodesign by path only.
 */
export function darwinOf(request, credentials) {
  const asked = request.darwin;
  if (asked === undefined || asked === null) return null;
  if (!Array.isArray(asked.targets) || !asked.targets.length || !asked.targets.every(target => D.targets.includes(target))) throw refuse(`darwin.targets must list Mac targets this builder cross-builds: ${D.targets.join(', ')}.`, 2);
  if (typeof asked.team_id !== 'string' || !new RegExp(D.team_pattern).test(asked.team_id)) throw refuse('darwin.team_id must be the Mac app\'s Developer ID team (10 letters and digits): CarriedCode.checkRelease admits a release signed by that team only.', 2);
  const sdk = absolute(asked.sdk_root ?? D.sdk_folder, 'darwin.sdk_root');
  return { ...asked, sdk, credentials: typeof credentials === 'string' && credentials ? credentials : null };
}

/**
 * One Mac target's release of the commit already checked out: cross-built on this Linux builder with cargo-zigbuild
 * against the macOS SDK, signed Developer ID with the hardened runtime by rcodesign, its signature read back and held
 * to the requirement the Mac app admits a feed release by (`checkDeveloperId`), then packed, signed and added like
 * the builder's own target. A sequence older than the feed's for this target is refused before it is built.
 */
export async function publishDarwin({ request, darwin, source, work, targetDir, env, log, feedFolder, feedNow, privateKey, publicKey, fields }) {
  const { target } = fields;
  const may = mayPublish(feedNow(), fields);
  if (may.already) return answerOf(may.already, { publicKey, already: true, dropped: 0, held: feedNow().releases.length });
  if (!darwin.credentials) throw refuse(`No Developer ID identity for ${target}: publish reads it from the receiver service's credentials ($CREDENTIALS_DIRECTORY), which install stores; run it through the service.`);
  const identity = join(darwin.credentials, D.credentials.identity), password = join(darwin.credentials, D.credentials.password);
  for (const file of [identity, password]) if (!existsSync(file)) throw refuse(`The credential ${basename(file)} is not in the service's credentials: run install again with the Developer ID identity on descriptor 5 and its password on descriptor 6.`);
  if (!existsSync(join(darwin.sdk, 'SDKSettings.json'))) throw refuse(`${darwin.sdk} holds no macOS SDK (no SDKSettings.json): run install again with darwin.sdk, the SDK as a tar.xz.`);
  const toolchain = request.toolchain ?? {};
  const crossEnv = {
    ...env, SDKROOT: darwin.sdk, MACOSX_DEPLOYMENT_TARGET: D.deployment_target,
    ...(toolchain.zig_python ? { CARGO_ZIGBUILD_PYTHON_PATH: toolchain.zig_python } : {}),
  };
  await runProgram(toolchain.cargo ?? 'cargo', ['zigbuild', '--release', '--bin', settings.binary, '--target', target], { cwd: source, env: crossEnv, timeout: settings.build_timeout_ms, log });
  const built = join(targetDir, target, 'release', settings.binary);
  if (!existsSync(built)) throw refuse(`cargo zigbuild finished but made no ${built}.`);
  const signed = join(work, 'signed', target, settings.binary);
  rmSync(dirname(signed), { recursive: true, force: true });
  mkdirSync(dirname(signed), { recursive: true, mode: 0o700 });
  const rcodesign = toolchain.rcodesign ?? 'rcodesign';
  await runProgram(rcodesign, ['sign', '--p12-file', identity, '--p12-password-file', password, '--code-signature-flags', D.code_signature_flags,
    '--timestamp-url', D.timestamp_url, '--binary-identifier', settings.binary, built, signed], { env, timeout: settings.git_timeout_ms, log });
  checkDeveloperId(await runProgram(rcodesign, ['print-signature-info', signed], { env }), darwin.team_id);
  chmodSync(signed, 0o755);
  return packSignAndAdd({ request, feedFolder, source, program: signed, privateKey, publicKey, fields });
}

/**
 * Take one signed entry another builder made for its own target into this builder's feed. The other builder (one per
 * target: a computer of that target, or a hosted runner of it) built the same commit with the same release identity,
 * packed it the same way (`packRelease`) and signed the entry with its own key (contribute-an-engine-release.mjs);
 * `body` is the tar.gz bytes. The entry is taken only when its signature is by a key in the config's
 * `accept_entries_from`, its commit is on the branch's first-parent line at the entry's sequence (fetched here, into
 * its own folder, so a build running meanwhile is untouched), its sequence is newer than the feed's for its target,
 * and the body's length and BLAKE3 are the entry's. It is then signed again with this builder's key and served from
 * this feed, so every computer's existing `public_keys` (the Mac app's carried ones too) take it with no config or app
 * change: this builder vouches for what an accepted key signed. Anything else is refused and the feed is unchanged.
 */
export async function accept(request, { token = '', entry: offered, body } = {}) {
  const { repository, branch } = request;
  const accepted = request.accept_entries_from ?? [];
  if (!Array.isArray(accepted) || !accepted.length || !accepted.every(key => /^[0-9a-f]{64}$/.test(key))) throw refuse('The config accepts no other builder\'s entries: accept_entries_from must list their Ed25519 public keys as 64 hex (install takes them).', 2);
  if (typeof request.base_url !== 'string' || !/^https:\/\/[^/]+\/.*\/$/.test(request.base_url)) throw refuse('base_url must be the https address the feed folder is served at, ending in /.', 2);
  if (!Buffer.isBuffer(body)) throw refuse('accept needs the release body, the tar.gz bytes.', 2);
  const work = absolute(request.work_folder, 'work_folder'), feedFolder = absolute(request.feed_folder, 'feed_folder');
  const privateKey = readSigningKey(absolute(request.key_file, 'key_file')), publicKey = publicKeyHex(privateKey);
  const { signature, url: _theirs, ...fields } = offered ?? {};
  const commit = checkCommit(fields.commit), target = checkTarget(fields.target);
  const candidate = checkEntry({ ...fields, url: `${request.base_url}${commit}/${target}.tar.gz`, signature });
  if (!signerOf(candidate, accepted)) throw refuse(`The entry for ${commit} (${target}) is not signed by a key in accept_entries_from: release_signature_refused.`, 3);
  mkdirSync(feedFolder, { recursive: true, mode: 0o755 });
  const source = join(work, 'verify-source');
  await fetchRepository({ repository, branch, source, token });
  const sequence = await sequenceOf({ source, branch, commit });
  if (sequence !== candidate.sequence) throw refuse(`The entry says ${commit} is sequence ${candidate.sequence}, but it is ${sequence} on ${branch}'s first-parent line.`, 3);
  const before = mayPublish(readFeed(readText(feedFile(feedFolder))), candidate);
  if (before.already) return answerOf(before.already, { publicKey, already: true, dropped: 0, held: readFeed(readText(feedFile(feedFolder))).releases.length });
  if (body.length !== candidate.bytes || makeHashCodeHexFromBytes(body) !== candidate.content) throw refuse(`The body sent for ${commit} (${target}) is not the entry's content: release_content_mismatch.`, 3);
  const file = tarballOf(feedFolder, commit, target), part = `${file}.${process.pid}.part`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
  writeFileSync(part, body, { mode: 0o644 });
  const { signature: _offered, ...unsigned } = candidate;
  return addUnderLock({ request, feedFolder, entry: signEntry(unsigned, privateKey), part, file, publicKey });
}

/** Add a signed entry whose tar.gz is at `part` to the feed under its lock, and remove what no longer fits. */
async function addUnderLock({ request, feedFolder, entry, part, file, publicKey }) {
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

/** Descriptor `fd`'s text, bounded; a descriptor nobody opened for this process is empty. When the caller opens no
 *  descriptor 3, the number may hold one Node opened for itself (its event loop's epoll on Linux, kqueue on macOS), and
 *  reading that fails in a way that differs by system, so only a pipe, socket or file the caller handed in is read;
 *  EBADF, EINVAL or ENXIO on the read itself still count as nothing handed in. */
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
  } catch (error) { if (['EBADF', 'EINVAL', 'ENXIO'].includes(error.code)) return ''; throw error; }
  return text.trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, first, ...rest] = process.argv.slice(2);
  const usage = 'usage: publish-an-engine-release.mjs publish REQUEST_FILE [--commit COMMIT] | accept REQUEST_FILE ENTRY_FILE BODY_FILE (repository token on fd 3) | make-key KEY_FILE | public-key KEY_FILE';
  try {
    let answer;
    if (operation === 'publish' && first && (rest.length === 0 || (rest.length === 2 && rest[0] === '--commit'))) {
      answer = await publish(readRequest(resolvePath(first)), { token: await privateInput(3), commit: rest[1] });
    } else if (operation === 'accept' && first && rest.length === 2) {
      const entry = JSON.parse(readFileSync(resolvePath(rest[0]), 'utf8'));
      answer = await accept(readRequest(resolvePath(first)), { token: await privateInput(3), entry, body: readFileSync(resolvePath(rest[1])) });
    } else if (operation === 'make-key' && first && rest.length === 0) answer = makeKey(resolvePath(first));
    else if (operation === 'public-key' && first && rest.length === 0) answer = { public_key: existsSync(resolvePath(first)) ? publicKeyHex(readSigningKey(resolvePath(first))) : null };
    else throw refuse(usage, 2);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    // A Mac target that failed fails the run (exit 4), with the release that was published still printed above.
    const failed = (answer.also ?? []).filter(one => one.error);
    for (const one of failed) process.stderr.write(`${one.target}: ${one.error}\n`);
    if (failed.length) process.exitCode = 4;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
