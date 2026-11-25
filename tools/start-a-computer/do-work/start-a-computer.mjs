// tools/start-a-computer/do-work/start-a-computer.mjs
//
// `tool:start-a-computer` and its siblings (tool-rows.json): make a machine into a computer that runs what its own row says.
// The machine comes from the provider description the request names in machine.provider (a file the person keeps, rented
// or one they already run over SSH); its public name from the one in name.provider. Then the computer's row
// (`record:computer`, request.computer_row) is applied: set-up-the-machine.sh prepares it over SSH, each unit with a `source`
// gets its program built from that commit on the computer itself (no release, no feed, no copied program), the files the
// row renders are written, and the units that changed restart and must answer their boot check. The answer is what was
// read back: what was written, built and restarted, the public health page's HTTP status and the provider's monthly price.
//
// A path in a request file is read relative to that file; ssh uses the person's own SSH agent and settings unless
// the request names an identity file. Credentials arrive on private pipes only: descriptor 3 holds the machine
// provider's credential (the row's vault_key), descriptor 4 the name provider's, and descriptor 5 the values the computer
// row's units name by vault name (`secret_vault_key`), as one JSON object of vault name to value. They never reach argv, a file, the
// environment or the answer.
//
// usage: start-a-computer.mjs price REQUEST_FILE | rent REQUEST_FILE | start REQUEST_FILE | apply REQUEST_FILE | differences REQUEST_FILE | status LEASE_FILE | unit LEASE_FILE REQUEST_FILE | remove LEASE_FILE
import { differences, renderWhatItRuns, dropInName, withPrepared, withSlots, publishedFile } from './render-what-a-computer-runs.mjs';
import { addressesOfName, declaredSetsOf, dnsClient, keepHealthyRecords, keepRecordSets, recordSetsOf } from '../../move-the-public-door/do-work/portable-dns-cutover.mjs';
import { fill } from './fill-fields.mjs';
import { keyState, keyDifferences, sealTheKeys, removeThePlainKeys } from './keep-the-key-sealed.mjs';
import { surplusBuilds, surplusDifferences, dropSurplusBuilds } from './keep-recent-builds.mjs';
import { readAll, writeAll } from './files-in-one-go.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { readFileSync, readdirSync, realpathSync, statSync, createReadStream } from 'node:fs';
import { isAbsolute, dirname, relative, resolve as resolvePath } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zstdCompressSync, constants as zlibConstants } from 'node:zlib';
import { homedir } from 'node:os';
import { isDeepStrictEqual, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { fileURLToPath } from 'node:url';
import {
  readProvider, providerClient, rentMachine, readMachine, releaseMachine, readPrice, pointName,
  forgetName, readLease, registerMachine, fileStore,
} from './rent-a-machine.mjs';

const SETUP = fileURLToPath(new URL('./set-up-the-machine.sh', import.meta.url));
const CAP_JOURNAL = fileURLToPath(new URL('./cap-the-journal.sh', import.meta.url));
const BUILD = readFileSync(new URL('./build-from-source.sh', import.meta.url), 'utf8');
const SETTINGS = JSON.parse(readFileSync(new URL('../read-data/settings.json', import.meta.url), 'utf8'));
const q = text => `'${String(text).replace(/'/g, `'\\''`)}'`;
const absolute = (path, what) => {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Object.assign(new Error(`${what} must be an absolute path.`), { exit: 2 });
  return path;
};

// sshd answers only so many half-open connections at once (MaxStartups) and resets the rest, so a layout with many units
// must not open every check at the same moment: at most this many commands run on a machine at a time.
const AT_ONCE = 4;
let running = 0;
const waiting = [];
const release = () => { if (waiting.length) waiting.shift()(); else running--; };
const turn = async () => { if (running < AT_ONCE) running++; else await new Promise(resolve => waiting.push(resolve)); };

/** Run one command on the machine as root; `input` is a string, a Buffer or a readable stream. Answers stdout. */
export async function onMachine(machine, command, input, spawnImpl = spawn) {
  await turn();
  try { return await sshOnce(machine, command, input, spawnImpl); } finally { release(); }
}

function sshOnce({ ssh, address }, command, input, spawnImpl) {
  const identity = ssh.identity_file ? ['-i', absolute(ssh.identity_file, 'ssh.identity_file'), '-o', 'IdentitiesOnly=yes'] : [];
  // Every command of one apply rides one SSH connection (a master kept for `ssh_reuse_seconds` after the last): a new
  // connection costs seconds, and an apply runs hundreds of commands, some while a unit it replaces is stopped.
  const reuse = ['-o', 'ControlMaster=auto', '-o', `ControlPath=${SETTINGS.ssh_reuse_path}`, '-o', `ControlPersist=${SETTINGS.ssh_reuse_seconds}`];
  const args = ['-T', ...identity, ...reuse, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${absolute(ssh.known_hosts, 'ssh.known_hosts')}`, `root@${address}`, command];
  return new Promise((resolve, reject) => {
    const child = spawnImpl('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', bytes => { out += bytes; });
    child.stderr.on('data', bytes => { err += bytes; });
    child.on('error', reject);
    // A command that ends before it reads all its input (ssh that never connected, say) closes its standard input: the write's
    // EPIPE is that same failure, which `close` reports with ssh's own words, so it is not thrown on its own and the process
    // does not crash with no command named (Nov 20 2026: `differences` with no machine address died "write EPIPE").
    child.stdin.on('error', () => {});
    child.on('close', code => (code === 0 ? resolve(out) : reject(Object.assign(new Error(`On the machine, \`${command.split(' ')[0]}\` exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`), { code }))));
    if (input?.pipe) input.pipe(child.stdin); else child.stdin.end(input ?? '');
  });
}

async function untilSsh(machine, { wait, run, tries = 36 }) {
  for (let i = 1; ; i++) {
    try { return await run(machine, 'uname -m'); }
    catch (error) { if (i >= tries) throw new Error(`The machine at ${machine.address} never answered SSH: ${error.message}`); await wait(5000); }
  }
}

/** Compare what a computer's row says it runs (`runs`, from `request.computer_row`) with what it runs now: every file the row
 * renders, every drop-in the row does not declare, and every unmanaged user and folder the row keeps. Answers the differences, [] when the
 * computer matches. An absent file is a difference; a failed connection is an error, not an absence. */
export async function runsDifferences(machine, runs, run = onMachine, deps = {}) {
  const { rendered, live, found } = await runsState(machine, runs, run, deps);
  return [...differences(rendered, live), ...found];
}

/** What a computer's `runs` renders, what the computer has at those paths, and what the computer keeps that `runs` does not
 * name. Each unit that names `prepare` is first handed to its program's own module (`withPrepared`),
 * and the answer's `runs` is that whole list, the one the apply follows. */
export async function runsState(machine, given, run = onMachine, { pages } = {}) {
  const runs = withSlots(await withPrepared(given, { pages })), units = runs.units;
  const rendered = renderWhatItRuns(runs);
  // The files of a folder a unit owns whole are read in one command (files-in-one-go.mjs); every other file one by one.
  const inOwned = ownedFolders(runs);
  const live = await readAll(machine, run, rendered.filter(({ path }) => inOwned(path)));
  for (const { path, binary } of rendered.filter(({ path }) => !inOwned(path))) live[path] = await readIfPresent(machine, run, path, binary);
  const found = [];
  for (const unit of units) {
    const dir = `/etc/systemd/system/${unit.unit}.d`;
    const names = (await run(machine, `if [ -d ${q(dir)} ]; then ls -1 ${q(dir)}; fi`)).split('\n').filter(Boolean);
    found.push(...names.filter(name => !(unit.drop_ins ?? []).map(dropInName).includes(name.replace(/\.conf$/, ''))).map(name => ({ path: `${dir}/${name}`, reason: 'not in the computer row' })));
  }
  // A unit that keeps its key sealed (`key_sealed_file`) is a difference while the computer lacks the sealed file or still holds the plain one.
  const keys = await keyState(machine, units, run);
  found.push(...keyDifferences(keys));
  for (const item of runs.unmanaged ?? []) {
    const gone = { path: item.user ? `user ${item.user}` : item.path, reason: 'unmanaged, kept, and missing on the computer' };
    const test = item.user ? `getent passwd ${q(item.user)} >/dev/null` : `test -e ${q(item.path)}`;
    const present = await run(machine, `${test} || exit 3`).then(() => true, error => { if (error.code === 3) return false; throw error; });
    if (!present) found.push(gone);
  }
  // A file the row says is absent (a secret it once kept in the clear, say) is a difference while it is there.
  const present = [];
  for (const path of runs.absent ?? []) {
    if (await run(machine, `test -e ${q(path)} || exit 3`).then(() => true, error => { if (error.code === 3) return false; throw error; })) present.push(path);
  }
  // A folder a unit owns whole (`owned_folders`: a web server's pages, say) holds only the files the row renders: a file left
  // there by an earlier row (a page that left the pages folder) is a difference, and the apply removes it.
  const renderedPaths = new Set(rendered.map(({ path }) => path));
  const strays = [];
  for (const folder of new Set(units.flatMap(unit => unit.owned_folders ?? []))) {
    const listed = (await run(machine, `if [ -d ${q(folder)} ]; then find ${q(folder)} -type f; fi`)).split('\n').filter(Boolean);
    strays.push(...listed.filter(file => !renderedPaths.has(file)));
  }
  present.push(...strays);
  found.push(...present.map(path => ({ path, reason: strays.includes(path) ? 'in a folder the row owns, and not rendered by it' : 'present; the computer row says absent' })));
  // A user the row says is absent (`absent_users`, a tunnel user an old setup made) is a difference while the computer has it.
  const usersPresent = [];
  for (const user of runs.absent_users ?? []) {
    if (await run(machine, `getent passwd ${q(user)} >/dev/null || exit 3`).then(() => true, error => { if (error.code === 3) return false; throw error; })) usersPresent.push(user);
  }
  found.push(...usersPresent.map(user => ({ path: `user ${user}`, reason: 'present; the computer row says absent' })));
  // A port the row's firewall admits (settings.json `machine` with the row's own over it, and every port a unit's prepare
  // opens) that the computer's firewall does not admit is a difference, and the apply runs set-up, which admits it. A
  // computer whose firewall another program keeps (firewall_allow null) is not asked.
  const firewall = { ...SETTINGS.machine, ...runs.machine }.firewall_allow;
  const portsClosed = [];
  if (Array.isArray(firewall)) {
    const status = await run(machine, 'ufw status 2>/dev/null || true');
    const admits = port => status.split('\n').some(line => line.split(/\s+/)[0] === port && /\sALLOW\s/.test(line) && !line.includes('(v6)'));
    portsClosed.push(...[...new Set(firewall)].filter(port => !admits(port)));
  }
  found.push(...portsClosed.map(port => ({ path: `firewall ${port}`, reason: 'the computer row admits it; the firewall does not' })));
  // A unit whose program is built from source (`source`) is behind when its `current` is not the commit its row names; the
  // apply builds that commit on the computer and moves `current` to it.
  // One whose `current` is that commit but whose running program is not `current`'s (a restart that failed, or a program
  // swapped by hand) is owed a restart: what runs is checked, never only what is on disk.
  const builds = [], stale = [];
  const isActive = name => run(machine, `systemctl is-active --quiet ${q(name)} || exit 3`).then(() => true, error => { if (error.code === 3) return false; throw error; });
  // A program run by an interpreter (`interpreter`: node, say) is not the process's own executable: it runs `current`'s build
  // when its process started after `current` last moved (the link's own change time). The start is now minus the process's
  // elapsed seconds (`ps -o etimes`), never /proc/<pid>'s own time: procfs sets that when the entry is first looked up, so a
  // process listed later (Nov 21 2026: the kernel's out-of-memory task dump) looked newer than a link moved after it started,
  // and two new site builds were never started.
  // The process a unit runs is that file: its executable is the file, not a replaced one ("PATH (deleted)" once replaced under it).
  const runsFile = (unit, path) => run(machine, `pid=$(systemctl show -p MainPID --value ${q(unit.unit)}); [ "$pid" != 0 ] && [ "$(readlink -f /proc/$pid/exe)" = "$(readlink -f ${q(path)})" ] || exit 3`)
    .then(() => true, error => { if (error.code === 3) return false; throw error; });
  const runsLink = async (unit, program) => unit.interpreter
    ? run(machine, `pid=$(systemctl show -p MainPID --value ${q(unit.unit)}); [ "$pid" != 0 ] && [ "$(( $(date +%s) - $(ps -o etimes= -p "$pid") ))" -ge "$(stat -c %Z ${q(`${unit.builds}/${unit.current ?? 'current'}`)})" ] || exit 3`)
      .then(() => true, error => { if (error.code === 3) return false; throw error; })
    : runsFile(unit, `${unit.builds}/${unit.current ?? 'current'}/${program}`);
  for (const unit of units.filter(row => row.source && !row.slot)) {
    const { commit, program } = sourceOf(unit);
    const from = (await run(machine, `readlink ${q(`${unit.builds}/current`)} || true`)).trim();
    if (from !== commit) { builds.push({ unit, from }); continue; }
    if (!await runsLink(unit, program)) stale.push({ unit, reason: `is not running ${unit.builds}/current, the build its row names` });
  }
  // A unit with no source that runs a program the computer downloads (its `program` is a download's `path`) is behind when its
  // running process is not that file: a file replaced under a running program is restarted, as a stale source unit is.
  const downloads = new Set(({ ...SETTINGS.machine, ...runs.machine }.downloads ?? []).map(download => download.path));
  for (const unit of units.filter(row => !row.source && !row.slot && downloads.has(row.program))) {
    if (!await runsFile(unit, unit.program)) stale.push({ unit, reason: `is not running ${unit.program}, the program its row names` });
  }
  found.push(...builds.map(({ unit, from }) => ({ path: `${unit.builds}/current`, reason: `runs ${from || 'no program'}; its row builds ${unit.source.commit}` })));
  found.push(...stale.map(({ unit, reason }) => ({ path: unit.unit, reason })));
  // A unit with slots runs one slot at a time. It is behind when no slot runs, or the slot that runs is not running the
  // commit its row builds; the apply then starts the release in the other slot and stops the one that ran (`switchSlots`).
  const switches = [];
  for (const units_ of Object.values(Object.groupBy(units.filter(row => row.slot), row => row.slot.of))) {
    const active = [];
    for (const unit of units_) if (await isActive(unit.unit)) active.push(unit);
    let reason = active.length ? null : 'no slot runs';
    for (const unit of active) {
      if (reason) break;
      if (!unit.source) continue;
      const { commit, program } = sourceOf(unit);
      const from = (await run(machine, `readlink ${q(`${unit.builds}/${unit.current}`)} || true`)).trim();
      if (from !== commit) reason = `${unit.unit} runs ${from || 'no program'}; its row builds ${commit}`;
      else if (!await runsLink(unit, program)) reason = `${unit.unit} is not running ${unit.builds}/${unit.current}, the build its row names`;
    }
    if (active.length > 1) reason ??= `${active.map(unit => unit.unit).join(' and ')} both run`;
    const group = { of: units_[0].slot.of, units: units_, active, reason };
    switches.push(group);
    if (reason) found.push({ path: group.of, reason });
  }
  // A build beyond the newest the unit keeps, that no `current` link runs, is a difference the apply removes (keep-recent-builds.mjs).
  const surplus = await surplusBuilds(machine, units, run, SETTINGS.builds.keep);
  found.push(...surplusDifferences(surplus));
  // A link of `live_links` that does not point at the one slot that runs is a difference the apply puts right.
  const linksOff = [];
  for (const { active } of switches.filter(group => group.active.length === 1)) {
    for (const [link, target] of Object.entries(active[0].live_links ?? {})) {
      const now = (await run(machine, `readlink -- ${q(link)} || true`)).trim();
      if (now !== target) {
        linksOff.push({ link, target });
        found.push({ path: link, reason: `points at ${now || 'nothing'}; the slot that runs, ${active[0].unit}, is at ${target}` });
      }
    }
  }
  return { runs, rendered, live, found, present, strays, usersPresent, portsClosed, builds, stale, switches, keys, surplus, linksOff };
}

/** A unit's `source` with its fields filled from the unit: the git `repository` address the computer fetches from (any host;
 * the address is the row's), the `commit` built, the `build` argv run in its tree, the `output` file it makes, and the
 * `environment` lines it runs with, each `{field}` in them the unit's own value or the `{commit}` built. A private repository
 * names `credential`, the vault name of an SSH key that may read it, and `host_keys`, the known_hosts lines of its host. The
 * program is the unit's own `program` in its `builds` folder. */
export function sourceOf(unit) {
  const { source } = unit, where = `${unit.unit} source`;
  if (!/^[0-9a-f]{40}$/.test(source.commit ?? '')) throw refused(`${where} needs commit, a full commit id.`);
  // A program built elsewhere (`prebuilt`: the BLAKE3 of its bytes) is placed, not built: no repository, build or toolchain on
  // the computer, so a small computer that serves never compiles (Nov 20 2026, 11:00:54-11:02:27 AM CST: an engine build on the
  // 3.8 GB always-on computer stalled its sites for 93 s).
  if (source.prebuilt !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(source.prebuilt?.blake3 ?? '')) throw refused(`${where} prebuilt needs blake3, the 64 hex digits of the program's BLAKE3.`);
    if (!/^[A-Za-z0-9._-]+$/.test(unit.program ?? '') || typeof unit.builds !== 'string' || !isAbsolute(unit.builds)) throw refused(`${where} needs the unit's program and its builds folder.`);
    const current = unit.current ?? 'current';
    if (!/^current[A-Za-z0-9_-]*$/.test(current)) throw refused(`${where}: the build link a unit runs is current, or current- and a slot's name.`);
    return { user: unit.user, builds: unit.builds, commit: source.commit, program: unit.program, current, prebuilt: source.prebuilt.blake3 };
  }
  if (typeof source.repository !== 'string' || !/^(https:\/\/|ssh:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)\S+$/.test(source.repository)) throw refused(`${where} needs repository, the git address the computer fetches the commit from.`);
  if (!Array.isArray(source.build) || !source.build.length || typeof source.output !== 'string') throw refused(`${where} needs build (an argv) and output (the file the build makes).`);
  if (source.credential !== undefined && (typeof source.credential !== 'string' || !Array.isArray(source.host_keys) || !source.host_keys.length)) throw refused(`${where} credential is the vault name of an SSH key, and needs host_keys: the known_hosts lines of the repository's host.`);
  const program = unit.program, current = unit.current ?? 'current';
  if (!/^[A-Za-z0-9._-]+$/.test(program ?? '') || typeof unit.builds !== 'string' || !isAbsolute(unit.builds)) throw refused(`${where} needs the unit's program and its builds folder.`);
  if (!/^current[A-Za-z0-9_-]*$/.test(current)) throw refused(`${where}: the build link a unit runs is current, or current- and a slot's name.`);
  const filled = text => fill(text, { ...unit, commit: source.commit }, where);
  return { user: unit.user, builds: unit.builds, commit: source.commit, program, current, repository: source.repository, credential: source.credential ?? null,
    host_keys: source.host_keys ?? [], output: filled(source.output), build: source.build.map(filled), environment: (source.environment ?? []).map(filled),
    limits: buildLimits(source, where) };
}

/** What a source build may use ({ memory_max, seconds }): settings.json `build_limits` for its kind (the build argv's program
 * name), else that file's `default`, with the source's own `limits` over it. There is no memory_high: a MemoryHigh below the max
 * only slows a build that outgrows it, for ever (Nov 21 2026, 8:07-8:21 PM CST), so the cap ends it and `seconds` bounds it. */
export function buildLimits(source, where = 'source') {
  if (source.memory !== undefined) throw refused(`${where} memory was replaced by limits ({ memory_max, seconds }): a build has one memory cap, which ends it, and a time it may run.`);
  const kind = String(source.build?.[0] ?? '').split('/').pop();
  const { _what, ...kinds } = SETTINGS.build_limits;
  const limits = { ...(kinds[kind] ?? kinds.default), ...(source.limits ?? {}) };
  const unknown = Object.keys(limits).filter(key => !['memory_max', 'seconds'].includes(key));
  if (unknown.length) throw refused(`${where} limits are memory_max and seconds only, not ${unknown.join(', ')}.`);
  if (!/^[1-9][0-9]*[KMGT]?$/.test(limits.memory_max ?? '')) throw refused(`${where} limits.memory_max is a size such as 200M or 2G.`);
  if (!Number.isInteger(limits.seconds) || limits.seconds <= 0) throw refused(`${where} limits.seconds is a whole number of seconds above 0.`);
  return { memory_max: limits.memory_max, seconds: limits.seconds };
}

/** Build a unit's source commit on the computer (do-work/build-from-source.sh): the computer fetches that commit itself from
 * the row's repository address into a copy it keeps in `builds`, builds it as the unit's user and makes it `current`. A key
 * the row names (`credential`) is the value the person's vault holds under that name (`held`); it reaches the computer only
 * on the SSH channel's standard input, into an ssh-agent for that one fetch. A commit already built there is only made
 * `current`. */
export async function buildOnTheComputer(machine, unit, held = {}, run = onMachine, store = prebuiltStore()) {
  const source = sourceOf(unit);
  if (source.prebuilt) return placePrebuilt(machine, source, run, store);
  if (source.credential && (typeof held[source.credential] !== 'string' || !held[source.credential])) throw refused(`${unit.unit} fetches ${source.repository} with the key held under the vault name ${source.credential}: hand it on descriptor 5 as {"${source.credential}": value}, read from the person's vault.`);
  const { credential, ...given } = source;
  return (await run(machine, `sh -c ${q(BUILD)} sh ${q(JSON.stringify({ ...given, keyed: Boolean(credential) }))}`, credential ? `${held[credential]}\n` : '')).trim();
}

/** Where the computer running the apply keeps programs built elsewhere, each file named by the BLAKE3 of its bytes
 * (settings.json `prebuilt_store`, `~` being this computer's home). */
export const prebuiltStore = () => SETTINGS.prebuilt_store.replace(/^~(?=\/)/, homedir());

/** Place a program built elsewhere: the file named by its BLAKE3 in this computer's store is checked against that name, sent on
 * the SSH channel's standard input and kept at `builds/<commit>/<program>` once its sha256 there is the sent bytes' (a cut-off
 * copy is never a build), then `current` moves to it with one rename. A commit already placed with those bytes is only made
 * `current`, and nothing is sent. */
export async function placePrebuilt(machine, { user, builds, commit, program, current, prebuilt }, run = onMachine, store = prebuiltStore()) {
  const file = resolvePath(store, prebuilt);
  let bytes;
  try { bytes = readFileSync(file); } catch { throw refused(`${commit} is placed from ${file}, the program built elsewhere whose BLAKE3 the row names, and this computer has no such file.`); }
  const { blake3 } = await import('@noble/hashes/blake3.js');
  const named = Buffer.from(blake3(bytes)).toString('hex');
  if (named !== prebuilt) throw refused(`${file} holds bytes whose BLAKE3 is ${named}, not the row's ${prebuilt}.`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const at = `${builds}/${commit}`, path = `${at}/${program}`;
  const link = `runuser -u ${q(user)} -- sh -c 'ln -sfn "$0" "$1/$2.new" && mv -T "$1/$2.new" "$1/$2"' ${q(commit)} ${q(builds)} ${q(current)}`;
  const placed = await run(machine, `[ -x ${q(path)} ] && [ "$(sha256sum ${q(path)} | cut -c1-64)" = ${q(sha256)} ] || exit 3`).then(() => true, error => { if (error.code === 3) return false; throw error; });
  // The bytes travel compressed (zstd, about a quarter of an engine's size) when the computer can unpack them: on Nov 20 2026,
  // 3:36-3:45 PM CST, a 44 MB engine sent whole over the applying computer's phone hotspot choked the link and the apply failed.
  // They unpack at the lowest CPU priority, like a build, so the programs the computer serves keep answering meanwhile.
  const unpacks = !placed && await run(machine, 'command -v zstd >/dev/null || exit 3').then(() => true, error => { if (error.code === 3) return false; throw error; });
  const sent = unpacks ? zstdCompressSync(bytes, { params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } }) : bytes;
  if (!placed) await run(machine, `set -e; install -d -o ${q(user)} -g ${q(user)} -m 0755 ${q(at)}; nice -n 19 ${unpacks ? 'zstd -dcq' : 'cat'} > ${q(`${path}.new`)}; ` +
    `[ "$(sha256sum ${q(`${path}.new`)} | cut -c1-64)" = ${q(sha256)} ] || { rm -f ${q(`${path}.new`)}; echo 'the program arrived cut off' >&2; exit 1; }; ` +
    `chown ${q(user)}:${q(user)} ${q(`${path}.new`)}; chmod 0755 ${q(`${path}.new`)}; mv -f ${q(`${path}.new`)} ${q(path)}`, sent);
  await run(machine, link);
  return commit;
}

/** Whether `path` is in a folder some unit of `runs` owns whole (`owned_folders`). */
const ownedFolders = runs => {
  const owned = runs.units.flatMap(unit => unit.owned_folders ?? []).map(folder => `${folder.replace(/\/$/, '')}/`);
  return path => owned.some(folder => path.startsWith(folder));
};

/** One file's text on the computer, or undefined when it is absent. A binary file is read as its base64, the form the computer row renders it in. */
async function readIfPresent(machine, run, path, binary) {
  return run(machine, `if [ -f ${q(path)} ]; then ${binary ? 'base64 -w0' : 'cat'} ${q(path)}; else exit 3; fi`).catch(error => { if (error.code === 3) return undefined; throw error; });
}

/** Whether a credential is held only in the computer's own vault (`held_on: "computer"`), never in the vault of whoever applies. */
const heldOnComputer = (credential, unit) => {
  if (credential.held_on === undefined) return false;
  if (credential.held_on !== 'computer') throw refused(`${unit} credential ${credential.name} says held_on ${JSON.stringify(credential.held_on)}: the one place a credential is held other than the vault of whoever applies is "computer", the vault of the engine on that computer.`);
  return true;
};

/** The sealed credentials a unit loads: its own (`secret_*`) and each of its `credentials` ({ vault_key, name, file, env?, held_on? });
 * each as { unit, secret_vault_key, secret_name, secret_file, on_computer }. One that says `held_on: "computer"` is read and sealed
 * on the computer from its own vault (`vaultReadOf`), never handed on descriptor 5. */
export const secretsOf = unit => [
  unit.secret_file && { unit: unit.unit, secret_vault_key: unit.secret_vault_key, secret_name: unit.secret_name, secret_file: unit.secret_file, on_computer: false },
  ...(unit.credentials ?? []).map(credential => ({ unit: unit.unit, secret_vault_key: credential.vault_key, secret_name: credential.name, secret_file: credential.file, on_computer: heldOnComputer(credential, unit.unit) })),
].filter(Boolean);

/** Whether a unit needs values from the person's vault (descriptor 5): a sealed credential held there, or the key its source is fetched with. */
const needsHeld = unit => secretsOf(unit).some(secret => !secret.on_computer) || Boolean(unit.source?.credential);

/** The shell words that print, on the computer, the value its own vault holds under a vault name: the row's `runs.vault_read`
 * ({ command, user?, answers_on? }), named once as DATA on the computer row like `engine_call`. `command` is the reader's command
 * line, its program first and one argument exactly `{name}`, where the vault name goes; `user` the account it runs as (an engine
 * answers its vault only to its own account); `answers_on` the descriptor it writes the value on (1 when absent; never 2). A reader
 * that answers on another descriptor gets a pipe there made by its own account, so the value reaches only the shell variable that
 * holds it on the computer: never argv, a file, a log or the machine that applies. A reader that fails prints nothing. */
export function vaultReadOf(vaultRead) {
  const { command, user, answers_on: answersOn = 1 } = vaultRead ?? {};
  if (!Array.isArray(command) || command.length < 2 || !command.every(part => typeof part === 'string' && part.length > 0)
    || command.filter(part => part === '{name}').length !== 1 || command[0] === '{name}'
    || (user !== undefined && !/^[a-z_][a-z0-9_-]*$/.test(user ?? '')) || !Number.isInteger(answersOn) || answersOn < 1 || answersOn === 2 || answersOn > 9) {
    throw refused('A credential held_on the computer is read from its own vault by the row\'s runs.vault_read: { command: the reader\'s command line, its program first and one argument exactly {name}; user: the account it runs as, when not root; answers_on: the descriptor it writes the value on, when not 1 }.');
  }
  return name => {
    const argv = command.map(part => q(part === '{name}' ? name : part)).join(' ');
    const read = answersOn === 1 ? argv : `sh -c ${q(`"$@" ${answersOn}>&1 >/dev/null | cat`)} sh ${argv}`;
    return user ? `runuser -u ${q(user)} -- ${read}` : read;
  };
}

/** The command that says whether a credential held on the computer must be sealed: exit 3 when its file is absent or opens to
 * another value than the computer's vault holds, exit 4 when its file is absent and the vault answers nothing, 0 when it is kept
 * (the same value, or a vault that answers nothing while a sealed file is there: the unit keeps running on what it loads). */
export const onComputerState = (readOf, secret) => `v=$(${readOf(secret.secret_vault_key)}); `
  + `if ! test -s ${q(secret.secret_file)}; then [ -n "$v" ] || exit 4; exit 3; fi; `
  + `[ -z "$v" ] || [ "$(systemd-creds decrypt --name=${q(secret.secret_name)} ${q(secret.secret_file)} -)" = "$v" ] || exit 3`;

/** The command that seals a credential held on the computer from its own vault: the value goes from the reader into a shell
 * variable and from there (printf, a shell builtin) into systemd-creds; exit 4 when the vault answers nothing. */
export const onComputerSeal = (readOf, secret) => `install -d -m 0700 ${q(dirname(secret.secret_file))} && umask 077 && { v=$(${readOf(secret.secret_vault_key)}); `
  + `[ -n "$v" ] || exit 4; printf '%s' "$v" | systemd-creds encrypt --name=${q(secret.secret_name)} - ${q(secret.secret_file)}; }`;

const notOnComputer = secret => refused(`${secret.unit} needs the value held under the vault name ${secret.secret_vault_key} in the computer's own vault (held_on computer), and its runs.vault_read answers none.`);

/** Apply what a computer's row says it runs: set it up, seal each secret a unit names that the computer does not hold yet, write only
 * the files that differ from what the row renders, and restart what those change. A computer that already matches gets
 * nothing written, no set-up run and nothing restarted. A file that is replaced keeps its previous bytes beside it as
 * `NAME.bak-STAMP` only for the apply's own rollback: the copies go once every restarted unit passed its boot check, and when
 * the apply fails after it began writing, each is moved back over its file (`putBackTheFiles`).
 * `held` maps a unit's `secret_vault_key` to the value the person's vault holds under that name; the value
 * reaches the computer only on the SSH channel's standard input, sealed there by systemd-creds at the unit's `secret_file`. */
// The error answers (status 400 and up) the access log's unit holds since `since` (epoch seconds): each route (path only), status,
// ip_hash (the BLAKE3 identity of the client address, never the address) and time. Read over the same route as the boot check.
// A journal that cannot be read is said so, never reported as no failures.
const JOURNAL_LINES = 5000;
async function journalErrors(machine, run, accessLogUnit, since) {
  if (!accessLogUnit) return { reachable: false, reason: 'the computer row names no access_log_unit', failures: [] };
  let text;
  try { text = await run(machine, `journalctl -u ${q(accessLogUnit)} --since @${since} -o cat --no-pager | tail -n ${JOURNAL_LINES}`); }
  catch (error) { return { reachable: false, reason: error.message, failures: [] }; }
  const failures = text.split('\n').flatMap(line => {
    let entry;
    try { entry = JSON.parse(line); } catch { return []; }
    const { request = {} } = entry;
    if (!(entry.status >= 400) || !request.uri || !request.remote_ip) return [];
    return [{ route: request.uri.split('?')[0], status: entry.status, ip_hash: makeHashCodeHexFromBytes(new TextEncoder().encode(request.remote_ip)), at: new Date(entry.ts * 1000).toISOString() }];
  });
  return { reachable: true, failures };
}

// The apply-checked fact of one restarted unit: its window (from the apply's start until its check ended), the check's result and the
// error answers in that window. Told before a failed apply throws, so a failure still reports its window.
async function applyCheckedFact(machine, run, { computer, unit, build, accessLogUnit, since, check, reason }) {
  const journal = await journalErrors(machine, run, accessLogUnit, Math.floor(since / 1000));
  return {
    computer, unit, build, down_started: new Date(since).toISOString(), down_ended: new Date().toISOString(), check,
    ...(reason && { reason }), journal_reachable: journal.reachable, ...(journal.reason && { journal_reason: journal.reason }), failures: journal.failures,
  };
}

async function memoryForASlot(machine, group, target, run) {
  const { margin_bytes: margin } = SETTINGS.slot_start;
  let need = target.start_headroom_bytes;
  if (need !== undefined && !(Number.isSafeInteger(need) && need >= 0)) throw refused(`${target.unit} start_headroom_bytes is a whole number of bytes, 0 or more.`);
  if (need === undefined) {
    need = 0;
    for (const unit of group.active) {
      const current = (await run(machine, `systemctl show -p MemoryCurrent --value ${q(unit.unit)}`)).trim();
      if (!/^[0-9]+$/.test(current)) throw refused(`${target.unit} needs the memory ${unit.unit} uses (MemoryCurrent: ${current || 'nothing'}), or its row's start_headroom_bytes, before it can start beside it.`);
      need += Number(current);
    }
    const measured = target.state ? (await run(machine, `cat ${q(`${target.state}/start-peak-bytes`)} 2>/dev/null || true`)).trim() : '';
    if (/^[0-9]+$/.test(measured)) need = Math.max(need, Number(measured));
  }
  const available = Number((await run(machine, "awk '/^MemAvailable:/ { print $2 * 1024 }' /proc/meminfo")).trim());
  if (!Number.isSafeInteger(available)) throw refused(`${target.unit} cannot be checked: the computer's MemAvailable in /proc/meminfo is not a number.`);
  if (available >= need + margin) return;
  throw refused(`${target.unit} was not started: it needs ${need + margin} bytes of MemAvailable and the computer has ${available}. ${group.active.length ? `${group.active.map(unit => unit.unit).join(' and ')} kept serving.` : 'No slot of it serves.'}`);
}

// The one overlap handoff: do not enable or retire anything before the candidate proves it can serve.
async function overlapSlot(machine, group, target, run, { ready, notSwitched, beforeRetire, afterRetire, start = 'restart' }) {
  await memoryForASlot(machine, group, target, run);
  const changeSlot = (unit, phase, command) => run(machine, command).catch(cause => {
    throw slotUnconfirmed(target, unit, phase, cause);
  });
  await changeSlot(target, start, `systemctl ${start} ${q(target.unit)}`);
  try { await ready(); }
  catch (error) {
    await changeSlot(target, 'stop', `systemctl stop ${q(target.unit)}`);
    error.message = `${error.message} Candidate stop succeeded; no incumbent retirement was requested for this unit.`;
    if (await notSwitched()) error.slot_not_switched = { candidate: target.unit, incumbent: group.active[0].unit, candidate_stopped: true };
    throw error;
  }
  await beforeRetire?.();
  await changeSlot(target, 'enable', `systemctl enable ${q(target.unit)} >/dev/null 2>&1`);
  for (const unit of group.units.filter(unit => unit !== target)) await changeSlot(unit, 'retire', `systemctl disable --now ${q(unit.unit)} >/dev/null 2>&1`);
  try { await afterRetire?.(); } catch (cause) { throw slotUnconfirmed(target, target, 'readback', cause); }
  return { to: target.unit, from: group.active.filter(unit => unit !== target).map(unit => unit.unit) };
}

/** Point `link` at `target` with one rename, so a reader finds the old target or the new one and never no file. */
const pointLink = (link, target) => `ln -sfn ${q(target)} ${q(`${link}.link-new`)} && mv -Tf ${q(`${link}.link-new`)} ${q(link)}`;

/** Point each of a slot's `live_links` at that slot's own path; answers the links moved. */
async function pointLiveLinks(machine, slot, run) {
  const links = Object.entries(slot.live_links ?? {});
  for (const [link, target] of links) await run(machine, pointLink(link, target));
  return links.map(([link]) => link);
}

function slotUnconfirmed(target, unit, phase, cause) {
  return Object.assign(new Error(`The apply did not confirm ${phase} for ${unit.unit}; read back the slots before retrying.`, { cause }), {
    exit: SLOT_SWITCH_UNCONFIRMED_EXIT, slot_switch_unconfirmed: { candidate: target.unit, affected_unit: unit.unit, phase },
  });
}

export async function applyWhatItRuns(machine, given, run = onMachine, held = {}, deps = {}) {
  const applyStarted = Date.now();
  const { runs, rendered, live, present, strays, usersPresent, portsClosed, builds, stale, switches, keys, surplus, linksOff } = await runsState(machine, given, run, deps);
  // A sealed key the computer lacks is made, and a plain key it still holds is removed once its unit runs from the sealed one: that unit restarts.
  const keysOwed = keys.filter(({ sealed, plain }) => !sealed || plain).map(({ unit }) => unit.unit);
  const writes = rendered.filter(({ path, text }) => live[path] !== text);
  // A file a unit reads (its settings, access file or script) changes that unit, and each unit that names it; a unit file or
  // drop-in changes its own unit. A file that names `then` is applied by those commands instead (a site file a reload reads,
  // a page nothing needs to read again), so it restarts nothing.
  const unitsOf = path => {
    const readers = runs.units.filter(unit => [unit.settings_file, unit.script_file, ...(unit.files ?? []).filter(file => !file.then).map(file => file.path)].includes(path)).map(unit => unit.unit);
    return readers.length ? readers : [path.match(/\/([^/]+\.(?:service|timer|path))(?:\.d\/[^/]+)?$/)?.[1]];
  };
  const slotted = new Set(runs.units.filter(unit => unit.slot).map(unit => unit.unit));
  const absent = (path, input) => run(machine, `${path} || exit 3`, input).then(() => false, error => { if (error.code === 3) return true; throw error; });
  const nodes = [...new Set(runs.units.map(unit => unit.node_bin).filter(Boolean))];
  const nodeMissing = (await Promise.all(nodes.map(bin => absent(`test -x ${q(`${bin}/node`)}`)))).includes(true);
  // A unit's own state and builds folders are made by set-up like the folders it names: a new unit for an account the computer
  // already has (a second route run by the same user) would otherwise start with no state folder, which systemd refuses (226).
  const foldersMissing = (await Promise.all(runs.units.flatMap(unit => [unit.state, unit.builds, ...(unit.folders ?? [])].filter(Boolean).map(folder => absent(`test -d ${q(folder)}`))))).includes(true);
  const missing = [];
  // A credential the computer does not hold is sealed from the value handed under its vault name; one it holds that differs from the
  // value now handed (the vault is the original, so a changed value is the one to run) is sealed again, and its unit restarts to load it.
  // One held only in the computer's own vault is compared and sealed there from that vault (`runs.vault_read`); a value handed under
  // its name is not used.
  const secrets = runs.units.flatMap(secretsOf);
  const readOf = secrets.some(secret => secret.on_computer) ? vaultReadOf(runs.vault_read) : null;
  for (const secret of secrets) {
    if (secret.on_computer) {
      const state = await run(machine, onComputerState(readOf, secret)).then(() => 'kept', error => { if ([3, 4].includes(error.code)) return error.code; throw error; });
      if (state === 4) throw notOnComputer(secret);
      if (state === 3) missing.push(secret);
      continue;
    }
    const handed = typeof held[secret.secret_vault_key] === 'string' && held[secret.secret_vault_key] !== '';
    if (await absent(`test -s ${q(secret.secret_file)}`)
      || (handed && await absent(`test "$(systemd-creds decrypt --name=${q(secret.secret_name)} ${q(secret.secret_file)} -)" = "$(cat)"`, held[secret.secret_vault_key]))) missing.push(secret);
  }
  for (const unit of missing.filter(secret => !secret.on_computer)) {
    if (typeof held[unit.secret_vault_key] !== 'string' || !held[unit.secret_vault_key]) {
      throw refused(`${unit.unit} needs the value held under the vault name ${unit.secret_vault_key}: hand it on descriptor 5 as {"${unit.secret_vault_key}": value}, read from the person's vault.`);
    }
  }
  // A timer or path unit the row names starts its job only while it is active: one that is not, whether it was just written
  // or stopped, is started.
  const triggersOff = [];
  for (const unit of runs.units.filter(row => /\.(timer|path)$/.test(row.unit))) if (await absent(`systemctl is-active --quiet ${q(unit.unit)}`)) triggersOff.push(unit.unit);
  // The packages and programs the set-up data names (settings.json `machine` with the row's own over it) are made by set-up too.
  const machineData = { ...SETTINGS.machine, ...runs.machine };
  // A program is in place when its path runs and, for a program the row pins by its bytes (`binary_sha256` of this computer's kind),
  // when the bytes there are the pinned ones: a row that pins a new release is set up again (set-up installs it over the old one),
  // where a path that merely runs used to keep the old program while the units started with the new release's settings.
  const downloadInPlace = ({ path, install, files = {} }) => {
    const pinned = install ? [] : Object.entries(files).filter(([, file]) => /^[0-9a-f]{64}$/.test(file?.binary_sha256 ?? ''));
    if (!pinned.length) return `test -x ${q(path)}`;
    const kinds = pinned.map(([kind, file]) => `${q(kind)}) [ "$(sha256sum ${q(path)} | cut -c1-64)" = ${q(file.binary_sha256)} ] ;;`).join(' ');
    return `test -x ${q(path)} && case "$(uname -m)" in ${kinds} *) true ;; esac`;
  };
  const programsMissing = (await Promise.all([
    ...(machineData.packages ?? []).map(name => absent(`dpkg -s ${q(name)} >/dev/null 2>&1`)),
    ...(machineData.downloads ?? []).map(download => absent(downloadInPlace(download))),
  ])).includes(true);
  // A unit with slots switches to its other slot when it is behind (`reason`), or when a file it reads changed or a credential
  // it loads is sealed anew: its running slot read them at its start, so the other slot starts with them.
  const changed = new Set([...writes.flatMap(({ path }) => unitsOf(path)), ...missing.map(unit => unit.unit)]);
  const switching = switches.filter(group => group.reason || group.units.some(unit => changed.has(unit.unit)))
    .map(group => ({ group, target: group.units.find(unit => !group.active.includes(unit)) ?? group.units.at(-1) }));
  if (!writes.length && !missing.length && !nodeMissing && !foldersMissing && !programsMissing && !triggersOff.length && !builds.length && !stale.length && !usersPresent.length && !present.length && !portsClosed.length && !switching.length && !keysOwed.length && !surplus.length && !linksOff.length) return { written: [], restarted: [] };
  // Set-up makes what is missing (packages, node, accounts, folders); a computer whose accounts and node all exist needs
  // none, and running it would refresh the package lists on every apply.
  // A unit that names `uid` needs its account to have that id: one with another id is as missing, so set-up runs and refuses it
  // (it never changes an account's id). Until Nov 25 2026 the uid never reached set-up, and the receiver's account was made
  // with whatever id was free (994, not the row's 1104), so the engine's socket row for 1104 admitted nobody.
  const accounts = await Promise.all(runs.units.map(unit => run(machine, Number.isInteger(unit.uid)
    ? `[ "$(id -u ${q(unit.user)} 2>/dev/null)" = ${q(String(unit.uid))} ] || exit 3`
    : `getent passwd ${q(unit.user)} >/dev/null || exit 3`).then(() => true, error => { if (error.code === 3) return false; throw error; })));
  // The set-up data is settings.json `machine` with the row's own `machine` fields over it (its packages, its firewall). Set-up
  // reads of each unit only what it makes (its account, folders and node), so only those go in its argument: a unit's files
  // and pages (a site's bundles) can be larger than one argument may be.
  // A unit that keeps its key sealed has set-up make no plain key file.
  const setUpUnits = runs.units.map(({ unit, user, uid, state, builds, key_file, key_sealed_file, folders, node_bin }) => ({ unit, user, uid, state, builds, key_file: key_sealed_file ? undefined : key_file, folders, node_bin }));
  const needsSetup = accounts.includes(false) || nodeMissing || foldersMissing || programsMissing || portsClosed.length > 0;
  if (needsSetup) await run(machine, `sh -s -- ${q(JSON.stringify({ units: setUpUnits }))} ${q(JSON.stringify(machineData))}`, readFileSync(SETUP));
  await sealTheKeys(machine, keys, run);
  for (const unit of missing) {
    if (unit.on_computer) { await run(machine, onComputerSeal(readOf, unit)).catch(error => { throw error.code === 4 ? notOnComputer(unit) : error; }); continue; }
    await run(machine, `install -d -m 0700 ${q(dirname(unit.secret_file))} && umask 077 && systemd-creds encrypt --name=${q(unit.secret_name)} - ${q(unit.secret_file)}`, held[unit.secret_vault_key]);
  }
  // The builds a unit keeps no longer go before the next is built: the disk they held may be what a build needs.
  await dropSurplusBuilds(machine, surplus, run);
  // A unit behind its row's source commit is built there once set-up has made its user, builds folder and toolchain.
  const built = [];
  for (const { unit, from } of builds) built.push({ unit: unit.unit, from: from || null, commit: await buildOnTheComputer(machine, unit, held, run) });
  // A slot that takes over gets its release built into its own link (`current-<slot>`) while the running slot still serves.
  for (const { target } of switching.filter(({ target }) => target.source)) built.push({ unit: target.unit, from: null, commit: await buildOnTheComputer(machine, target, held, run) });
  // What the row says is absent goes only now, once every build is made, so a unit it replaces stops for the least time.
  // A unit file the row says is absent is a unit the computer must not run: it is stopped and disabled, and its drop-ins go
  // with its file. A folder the row says is absent (a program an old set-up left) goes with everything in it.
  // A stray in a folder a unit owns whole goes only after the new files are written (below): a page served now may still name it.
  for (const path of present.filter(path => !strays.includes(path))) {
    const unit = path.match(/^\/etc\/systemd\/system\/([A-Za-z0-9@._-]+\.(?:service|timer|path|socket))$/)?.[1];
    if (unit) await run(machine, `systemctl disable --now ${q(unit)} && rm -rf -- ${q(`${path}.d`)}`);
    await run(machine, `rm -rf -- ${q(path)}`);
  }
  if (present.some(path => path.startsWith('/etc/systemd/system/'))) await run(machine, 'systemctl daemon-reload');
  // The ssh server reads its drop-ins at a reload: a removed one stops admitting its user then. A user the row says is absent
  // is removed with its home folder.
  if (present.some(path => path.startsWith('/etc/ssh/sshd_config.d/'))) await run(machine, 'sshd -t && systemctl reload ssh');
  for (const user of usersPresent) await run(machine, `userdel -r ${q(user)}`);
  const removed = present.length || usersPresent.length ? { removed: [...present, ...usersPresent.map(user => `user ${user}`)] } : {};
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // A file in a folder a unit owns whole (a site's page) keeps no copy beside it: the person's own folder holds every page, and a
  // copy there would be a stray the next apply removes.
  // Those files are written in one command too, first, so a site file that names a page finds it.
  const inOwned = ownedFolders(runs);
  await writeAll(machine, run, writes.filter(({ path, check }) => inOwned(path) && !check));
  // The copies kept beside replaced files (`NAME.bak-STAMP`) are this apply's rollback only, never left for a later one: once
  // every restarted unit passed its boot check they go, and if anything fails from the first write on, they are moved back over
  // their files and the units that read them restart on them (Nov 25 2026: 21 copies no row named had piled up under /etc on
  // one computer, and one inside a config folder would be read by whatever binds that folder).
  const backups = [];
  let switched, booted, linked, checked, computer, units;
  try {
    for (const { path, text, binary, check } of writes.filter(({ path, check }) => !inOwned(path) || check)) {
      if (live[path] !== undefined && !inOwned(path)) {
        await run(machine, `cp -p ${q(path)} ${q(`${path}.bak-${stamp}`)}`);
        backups.push({ path, backup: `${path}.bak-${stamp}` });
      }
      // Through a temporary file and one rename: `install /dev/stdin FILE` fails on Ubuntu 26.04's coreutils (uutils 0.10.0)
      // whenever FILE already exists. The destination follows this text as its last word.
      const write = `install -d -m 0755 ${q(dirname(path))} && t=$(mktemp ${q(`${dirname(path)}/.write.XXXXXX`)}) && ${binary ? 'base64 -d' : 'cat'} > "$t" && chmod 0644 "$t" && chown root:root "$t" && mv -f "$t"`;
      // A file that names `check` (an argv, `{file}` the new text's path) is written beside the live one and replaces it only
      // once that command passes: a site file its own server validates, so a bad one never reaches the running program.
      if (check) await run(machine, `${write} ${q(`${path}.new`)} && ${check.map(word => q(word.replaceAll('{file}', `${path}.new`))).join(' ')} >/dev/null && mv ${q(`${path}.new`)} ${q(path)}`, text);
      else await run(machine, `${write} ${q(path)}`, text);
    }
    // The strays of the owned folders go now, in one command: the pages written above no longer name them, and a page served
    // before this apply could load one until its replacement was in place (Nov 20 2026: old workspace bundles were removed one by
    // one, before the new pages, so a page loading then could miss its own scripts).
    if (strays.length) await run(machine, 'while IFS= read -r p; do rm -f -- "$p"; done', `${strays.join('\n')}\n`);
    const builtUnits = [...builds.map(({ unit }) => unit.unit), ...stale.map(({ unit }) => unit.unit)];
    units = [...new Set([...writes.flatMap(({ path }) => unitsOf(path)), ...missing.map(unit => unit.unit), ...keysOwed, ...triggersOff, ...builtUnits].filter(Boolean))]
      .filter(unit => !slotted.has(unit));
    // A unit whose file or drop-in was there before is restarted. A new drop-in changes how a running unit starts, so it restarts
    // it too, unless the unit's own file is new as well: a new unit is enabled and started.
    // (A unit with no template is the computer's own, so it was there.)
    const unitFile = path => path.match(/^(.+)\.d\/[^/]+$/)?.[1];
    const startedBefore = path => live[path] !== undefined || !rendered.some(file => file.path === path);
    const running = new Set([...writes.filter(({ path }) => live[path] !== undefined || (unitFile(path) && startedBefore(unitFile(path)))).flatMap(({ path }) => unitsOf(path)),
      ...[...missing.map(unit => unit.unit), ...keysOwed, ...builtUnits].filter(name => live[`/etc/systemd/system/${name}`] !== undefined)]);
    if (units.length || switching.length) await run(machine, 'systemctl daemon-reload');
    // The boot check: each restarted unit must answer its own health row (`health`, `health_listen`, and the Host its request
    // names, `health.host`), else the one the computer row
    // names, else the tool default, on the machine itself, so a unit that starts and crashes, or a route that is not served, fails the apply instead of passing it.
    const bootCheck = async unit => {
      const row = runs.units.find(given => given.unit === unit) ?? {};
      // A unit that is not an HTTP server names the command that tells it is well (`check_command`, run on the computer, exit 0).
      if (row.check_command) return commandPasses(machine, row.check_command, { run, wait: deps.wait ?? pause, tries: 12 }, `${unit}'s check_command`);
      const health = healthOf(row.health ?? runs.health);
      const listen = row.health_listen ?? runs.health_listen;
      if (!listen) throw refused(`${unit} restarted, and neither it nor its computer's row names health_listen: the address its boot check asks.`);
      // A unit whose first start is long (a slot fetching and installing its own copy) names how long its health may take to
      // answer (`health.wait_seconds`); it is asked every 5 s.
      const tries = Math.max(1, Math.ceil((health.wait_seconds ?? 60) / 5));
      const status = await healthStatus(machine, { listen }, health.host ?? '', { ...health, where: 'machine' }, { fetchImpl: undefined, wait: deps.wait ?? pause, tries, run });
      if (status !== health.status) throw Object.assign(new Error(`${unit} answered ${status ?? 'nothing'} on ${health.path}, not ${health.status}, after its restart.`), { unit, status });
    };
    // A switch starts the other slot, and only once it answers its boot check is it the one that starts with the computer and is
    // the slot that ran stopped: that one stops taking calls and finishes those it holds (its stop_seconds). A slot that never
    // answers is stopped again, and the slot that ran keeps serving.
    // A slot boots beside the one that runs only when the computer has the memory for both (settings.json `slot_start`): the
    // unit's `start_headroom_bytes` (what a new slot takes to start), else the larger of the memory the running slots use now
    // (their MemoryCurrent) and the start peak the last switch measured (the new slot's MemoryPeak once it passed its checks, kept
    // in the unit's state folder as `start-peak-bytes`: a release can outgrow the one it replaces while it starts), and the margin
    // over it, against the computer's MemAvailable. Too little is refused before anything stops, so the slot that
    // runs keeps serving (Nov 21 2026, 9:47 PM CST: the kernel's global out-of-memory killer ended a new slot that had reached 1.32 GB
    // beside an old one holding 1.26 GB on a 4 GB computer, and every site on the box timed out).
    switched = []; booted = []; linked = [];
    for (const { group, target } of switching) {
      const answer = await overlapSlot(machine, group, target, run, {
        ready: async () => {
          await bootCheck(target.unit);
          if (target.switch_check_command) {
            const filled = target.switch_check_command.replaceAll('{unit}', target.unit).replaceAll('{listen}', target.health_listen ?? '');
            await commandPasses(machine, filled, { run, wait: deps.wait ?? pause, tries: Math.max(1, Math.ceil((target.switch_check_seconds ?? 60) / 5)) }, `${target.unit}'s switch_check_command`);
          }
        },
        notSwitched: async () => switching.length === 1 && group.active.length === 1 && !needsSetup && !writes.length && !present.length &&
          !usersPresent.length && !missing.length && !keysOwed.length && !builds.length,
        beforeRetire: async () => {
          // The new slot answers and the one that ran still serves: its fixed paths move to the new slot now, so no reader is
          // sent to a slot that is stopping.
          linked.push(...await pointLiveLinks(machine, target, run));
          if (!target.state) return;
          const peak = (await run(machine, `systemctl show -p MemoryPeak --value ${q(target.unit)}`).catch(() => '')).trim();
          if (/^[0-9]+$/.test(peak)) await run(machine, `printf '%s\\n' ${q(peak)} > ${q(`${target.state}/start-peak-bytes`)}`).catch(() => {});
        },
      });
      booted.push(target.unit);
      switched.push(answer);
    }
    // A link that is off while no switch moves it (a link the row names for the first time, or one changed by hand) is put back.
    const switchedGroups = new Set(switching.map(({ group }) => group.of));
    for (const { link, target } of linksOff) {
      if (switchedGroups.has(runs.units.find(unit => Object.hasOwn(unit.live_links ?? {}, link))?.slot?.of)) continue;
      await run(machine, pointLink(link, target));
      linked.push(link);
    }
    for (const unit of units) {
      await run(machine, running.has(unit) ? `systemctl restart ${q(unit)}` : `systemctl enable --now ${q(unit)} >/dev/null 2>&1`);
    }
    // A file that names commands to run once it changed (`then`: a server's reload of its site file, the meeting point's user
    // and its ssh server's reload) runs them, each once, in order, once every unit it may send to has started.
    const thens = [...new Map(writes.flatMap(({ then }) => then ?? []).map(argv => [JSON.stringify(argv), argv])).values()];
    for (const argv of thens) await run(machine, argv.map(q).join(' '));
    computer = deps.computer ?? machine.address; checked = [];
    for (const unit of units) {
      const common = { computer, unit, build: runs.units.find(given => given.unit === unit)?.commit ?? null, accessLogUnit: runs.access_log_unit, since: applyStarted };
      try { await bootCheck(unit); }
      catch (error) {
        error.apply_checked = [...checked, await applyCheckedFact(machine, run, { ...common, check: 'failed', reason: error.message })];
        throw error;
      }
      checked.push(await applyCheckedFact(machine, run, { ...common, check: 'passed' }));
      booted.push(unit);
    }
  } catch (error) {
    error.rolled_back = await putBackTheFiles(machine, run, backups, { unitsOf, slotted, writes });
    throw error;
  }
  const backupsLeft = await dropTheBackups(machine, run, backups);
  const plainKeysRemoved = await removeThePlainKeys(machine, keys, booted, run);
  return { written: writes.map(({ path }) => path), restarted: units, booted, ...(plainKeysRemoved.length ? { plain_keys_removed: plainKeysRemoved } : {}), ...(switched.length ? { switched } : {}), ...(linked.length ? { linked } : {}), ...(missing.length ? { sealed: missing.map(unit => unit.secret_name) } : {}), ...(built.length ? { built } : {}), ...(surplus.length ? { builds_removed: surplus.flatMap(({ builds, commits }) => commits.map(commit => `${builds}/${commit}`)) } : {}), ...removed, ...(checked.length ? { apply_checked: checked } : {}), ...(backupsLeft.length ? { backups_left: backupsLeft } : {}) };
}

/** Puts back the files an apply replaced, from the copies it kept beside them, once the apply failed after it began writing:
 * each copy is moved over its file (so the copy is gone too), systemd reloads when a unit file or drop-in came back, each unit
 * that reads a restored file restarts on it (a slotted unit is left to its own switch, which keeps the slot that ran), and a
 * restored file's `then` commands run once more. A file the apply made new has no previous bytes and stays; what the apply
 * removed, sealed or built is not undone here. Returns the paths put back, and each one that could not be with why (its copy
 * is kept, and named, for whoever looks next). */
export async function putBackTheFiles(machine, run, backups, { unitsOf, slotted, writes }) {
  const restored = [], failed = [];
  for (const { path, backup } of backups) {
    try { await run(machine, `mv -f ${q(backup)} ${q(path)}`); restored.push(path); }
    catch (error) { failed.push({ path, backup, reason: error.message }); }
  }
  const restart = [...new Set(restored.flatMap(unitsOf).filter(unit => unit && !slotted.has(unit)))];
  const thens = [...new Map(writes.filter(({ path }) => restored.includes(path)).flatMap(({ then }) => then ?? []).map(argv => [JSON.stringify(argv), argv])).values()];
  const steps = [
    ...(restored.some(path => path.startsWith('/etc/systemd/system/')) ? ['systemctl daemon-reload'] : []),
    ...restart.map(unit => `systemctl restart ${q(unit)}`),
    ...thens.map(argv => argv.map(q).join(' ')),
  ];
  for (const command of steps) {
    try { await run(machine, command); }
    catch (error) { failed.push({ command, reason: error.message }); }
  }
  return { restored, restarted: restart, ...(failed.length ? { failed } : {}) };
}

/** Removes the copies an apply kept for its rollback, once its checks passed, in one command. A copy that could not be removed
 * does not fail an apply that worked: it is returned, so the answer names it. */
export async function dropTheBackups(machine, run, backups) {
  if (!backups.length) return [];
  try { await run(machine, 'while IFS= read -r p; do rm -f -- "$p"; done', `${backups.map(({ backup }) => backup).join('\n')}\n`); return []; }
  catch { return backups.map(({ backup }) => backup); }
}

const refused = message => Object.assign(new Error(message), { exit: 2 });

/** The health check a unit or computer declares (`health`; the default is SETTINGS.health): the path and the status it must
 * answer, asked `public`ly (through its host name) or on the `machine` itself (the listen address, Host set to the name). */
export function healthOf(given = {}) {
  const health = { ...SETTINGS.health, ...given };
  if (!/^\/[A-Za-z0-9._~\/-]*$/.test(health.path) || !Number.isInteger(health.status) || health.status < 100 || health.status > 599 || !['public', 'machine'].includes(health.where)
    || (health.host !== undefined && !/^[a-z0-9.-]{1,253}$/.test(health.host))) {
    throw refused('health takes a path that starts with /, a status from 100 to 599, where: public or machine, and optionally the host name its request names (host).');
  }
  return health;
}

/** A command run on the computer until it exits 0, tried `tries` times; the last failure is the error. */
async function commandPasses(machine, command, { run, wait, tries }, what) {
  for (let i = 1; ; i++) {
    try { await run(machine, command); return; }
    catch (error) {
      if (i >= tries) throw Object.assign(new Error(`${what} did not pass after the restart: ${error.message}`), { code: error.code });
      await wait(5000);
    }
  }
}

/** Ask the place its health check once per try: its status, or null when nothing answers. */
async function healthStatus(machine, config, host, health, { fetchImpl, wait, tries, run }) {
  let status = null;
  for (let i = 1; i <= tries; i++) {
    try {
      status = health.where === 'machine'
        ? Number((await run(machine, `curl -s -o /dev/null -w '%{http_code}' ${host ? `-H ${q(`Host: ${host}`)} ` : ''}${q(`http://${config.listen}${health.path}`)} || true`)).trim()) || null
        : (await fetchImpl(`https://${host}${health.path}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) })).status;
    } catch { status = null; }
    if (status === health.status) return status;
    if (i < tries) await wait(5000);
  }
  return status;
}

/** Cap the one log a computer keeps, the system journal, at the size every place keeps (settings `journal.system_max_use`) and stop the second copy rsyslog wrote, on a new machine. */
export async function capTheJournal(machine, run = onMachine, root = '') {
  await run(machine, `env ROOT=${q(root)} JOURNAL_MAX=${q(SETTINGS.journal.system_max_use)} sh -s`, readFileSync(CAP_JOURNAL));
}

/** The lease kept in LEASE_FILE. */
const leaseOf = leaseFile => readLease(fileStore(absolute(leaseFile, 'LEASE_FILE')));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Rent (or adopt) the request's machine, point its name and wait for SSH: the machine any other tool may then set up. */
export async function rentAMachine(request, { machineToken, nameToken, fetchImpl = fetch, wait = pause, run = onMachine } = {}) {
  const machines = readProvider(request.machine.provider), names = request.name.provider ? readProvider(request.name.provider) : null;
  const machineRequest = machines.base ? providerClient(machines, machineToken, { fetchImpl }) : null;
  const file = absolute(request.lease_file, 'lease_file'), m = request.machine;
  const publicKey = m.public_key ?? (m.public_key_file && readFileSync(absolute(m.public_key_file, 'machine.public_key_file'), 'utf8'));
  const lease = await rentMachine({ request: machineRequest, store: fileStore(file), provider: machines, name: m.name, placement: m.placement, expiresAt: m.expires_at, firstBoot: m.first_boot, publicKey, wait });
  const price = await readPrice({ request: machineRequest, provider: machines, placement: m.placement });
  const terms_url = machines.terms_url ?? null;
  // A machine nobody can reach waits for the line to be run on it; its name and set-up follow once it has registered.
  if (lease.state === 'waiting') return { machine: null, price, arch: null, lease: { provider: lease.provider, name: lease.name, serverId: null, address: null, state: lease.state }, host_name: request.name.host_name, line: lease.line, terms_url };
  if (names) await pointName({ request: providerClient(names, nameToken, { fetchImpl }), store: fileStore(file), provider: names, zone: request.name.zone, hostName: request.name.host_name });
  const machine = { ssh: request.ssh, address: lease.address };
  const arch = (await untilSsh(machine, { wait, run })).trim();
  return { machine, price, arch, lease: { provider: lease.provider, name: lease.name, serverId: lease.serverId, address: lease.address, state: lease.state }, host_name: request.name.host_name, terms_url };
}

/** Rent (or adopt) the request's machine and apply its computer row to it: set-up, the units' source builds, the files the row
 * renders and the restarts, then the row's health page (`runs.health`) asked through its public name. */
export async function startAComputer(request, { machineToken, nameToken, held = {}, fetchImpl = fetch, wait = pause, tries = 48, run = onMachine } = {}) {
  if (Object.hasOwn(request, 'scope')) throw refused('engine scope is not supported by start; use the row apply owner.');
  const runs = runsOf(request);
  const rented = await rentAMachine(request, { machineToken, nameToken, fetchImpl, wait, run });
  if (rented.lease.state === 'waiting') return rented;
  const { machine, price, arch, lease, host_name } = rented;
  const applied = await applyWhatItRuns(machine, runs, run, held, { pages: readPages(request), wait, computer: request.machine.name });
  await capTheJournal(machine, run);
  const status = await healthStatus(machine, {}, host_name, { ...healthOf(runs.health), where: 'public' }, { fetchImpl, wait, tries, run });
  return { lease, host_name, arch, price, applied, health_status: status };
}

/** A unit's verdict from its `systemctl show` values: an alert when it is not active, or has restarted past the budget
 * (`read-data/settings.json` `unit_restarts.budget`). NRestarts counts restarts since the unit was loaded. */
export function unitVerdict(show, budget = SETTINGS.unit_restarts.budget) {
  const nrestarts = Number(show.NRestarts);
  if (!Number.isInteger(nrestarts) || !show.Id) throw refused('systemctl show did not name the unit or its restart count.');
  const alert = show.ActiveState !== 'active' || nrestarts > budget;
  return { unit: show.Id, active: show.ActiveState, sub: show.SubState, nrestarts, budget, alert };
}

/** Read a running computer's unit over SSH (`request.unit`, the unit's name) and give its verdict. */
export async function unitStatus(leaseFile, request, { run = onMachine } = {}) {
  const lease = await leaseOf(leaseFile), machine = { ssh: request.ssh, address: lease.address };
  const { unit } = request;
  if (typeof unit !== 'string' || !/^[A-Za-z0-9@._-]+\.service$/.test(unit)) throw refused('unit reads request.unit, a service name such as example.service.');
  const show = Object.fromEntries((await run(machine, `systemctl show ${q(unit)} -p Id -p ActiveState -p SubState -p NRestarts`)).trim().split('\n').map(line => line.split('=')));
  return unitVerdict(show);
}

/** The monthly price the request's machine would cost, read before anything is rented. */
export async function priceOfAComputer(request, { machineToken, fetchImpl = fetch } = {}) {
  const row = readProvider(request.machine.provider);
  return { provider: row.id, terms_url: row.terms_url ?? null, placement: { ...row.placement, ...request.machine.placement }, price: await readPrice({ request: row.base ? providerClient(row, machineToken, { fetchImpl }) : null, provider: row, placement: request.machine.placement }) };
}

export async function computerStatus(leaseFile, { machineToken, fetchImpl = fetch } = {}) {
  const store = fileStore(absolute(leaseFile, 'LEASE_FILE')), lease = await readLease(store), row = readProvider(lease.providerFile);
  const machine = await readMachine({ request: row.base ? providerClient(row, machineToken, { fetchImpl }) : null, store, provider: row });
  const health = healthOf();
  if (health.where !== 'public') throw refused('A status reads the public health row only: the place is not asked on its machine.');
  const status = lease.hostName ? await healthStatus(machine, {}, lease.hostName, health, { fetchImpl, wait: pause, tries: 1 }) : null;
  return { name: lease.name, provider: lease.provider, lease_state: lease.state, machine, host_name: lease.hostName ?? null, health_status: status };
}

/** Forget the public name, then give the machine back (an adopted machine is only forgotten). */
export async function removeAComputer(leaseFile, { machineToken, nameToken, fetchImpl = fetch } = {}) {
  const store = fileStore(absolute(leaseFile, 'LEASE_FILE')), lease = await readLease(store), row = readProvider(lease.providerFile);
  if (lease.recordId) await forgetName({ request: providerClient(readProvider(lease.namesFile), nameToken, { fetchImpl }), store });
  const done = await releaseMachine({ request: row.base ? providerClient(row, machineToken, { fetchImpl }) : null, store, provider: row });
  return { name: done.name, provider: done.provider, state: done.state, adopted: Boolean(done.adopted) };
}

/** What the computer runs: `request.computer_row` is the computer's own row (a `record:computer`: its address, name and
 * `runs`, the units and set-up it runs), handed in with the request; this tool reads no store for it. */
export function runsOf(request) {
  const runs = request.computer_row?.runs;
  if (!runs || typeof runs !== 'object' || !Array.isArray(runs.units)) throw refused('computer_row is the computer\'s own row: its `runs` names the units the computer runs.');
  return runs;
}

/** The pages a web server answers itself, handed in as `pages_folder` (the person's own folder, resolved against the request
 * file): every file of it, as { name, bytes }; undefined when the request names none. A link in it is followed, so a folder
 * kept where its owner keeps it (a site's own repository) is handed in by a link, never copied. */
export function readPages(request) {
  if (request.pages_folder === undefined) return undefined;
  const folder = absolute(request.pages_folder, 'pages_folder');
  const walk = at => readdirSync(at).flatMap(name => {
    const path = `${at}/${name}`, kind = statSync(path);
    return kind.isDirectory() ? walk(path) : kind.isFile() ? [{ name: relative(folder, path), bytes: readFileSync(path) }] : [];
  });
  return walk(folder);
}

/** A unit may declare `pages_hosts`: the host names whose pages it was built with. Each host's link in the request's
 * pages_folder (realpath) must point into the unit's `source.commit`, so the pages and the program that serves them switch
 * together; a missing link, or one pointing elsewhere, refuses the apply before any write. A unit without the field is not checked. */
export function checkPagesFollowCommit(request) {
  for (const unit of runsOf(request).units.filter(given => given.pages_hosts !== undefined)) {
    const { unit: name, pages_hosts: hosts } = unit, commit = unit.source?.commit ?? '';
    if (!Array.isArray(hosts) || !hosts.every(host => typeof host === 'string' && /^[A-Za-z0-9.-]+$/.test(host))) throw refused(`${name} pages_hosts is a list of host names.`);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw refused(`${name} pages_hosts needs source.commit, the full commit id its pages were built with.`);
    for (const host of hosts) {
      if (request.pages_folder === undefined) throw refused(`${name} pages_hosts names ${host}: the request needs pages_folder, the folder holding that host's link.`);
      const link = `${absolute(request.pages_folder, 'pages_folder')}/${host}`;
      let target;
      try { target = realpathSync(link); } catch { throw refused(`${host} has no link at ${link} in pages_folder; ${name} pages_hosts needs it to point at source.commit ${commit}. Apply refused before any write.`); }
      if (!target.includes(commit)) throw refused(`${host} pages: ${link} points at ${target}, not ${name}'s source.commit ${commit}. Apply refused before any write.`);
    }
  }
}

/** Apply a computer's row to the computer the request names (`machine.address`, `ssh`), already running: the same
 * apply a start does, with the values its units name by vault name (`held`). */
export const ROW_ENGINE_SCOPE_PROTOCOL = 1;
const ENGINE_TEMPLATE = 'tools/keep-an-engine-on-a-computer/serve-computer.service';
const service = /^[A-Za-z0-9@._-]+\.service$/;
const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

function pinnedEngineSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.commit !== 'string' || !/^[0-9a-f]{40}$/.test(source.commit) ||
      !exactKeys(source.prebuilt, ['blake3']) || typeof source.prebuilt.blake3 !== 'string' || !/^[0-9a-f]{64}$/.test(source.prebuilt.blake3)) {
    throw refused('the engine scope needs a full commit and BLAKE3 pin for both the candidate and the retained rollback.');
  }
  return source;
}

const withReleasePins = (source, { commit, prebuilt }) => ({ ...source, commit, prebuilt });

export function readEngineScope(scope, internal = false) {
  if (!exactKeys(scope, internal ? ['kind', 'unit', 'incumbent', 'rollback'] : ['kind', 'unit', 'incumbent']) ||
      scope.kind !== 'engine-slot' || typeof scope.unit !== 'string' || !service.test(scope.unit) ||
      !exactKeys(scope.incumbent, ['unit', 'pid', 'invocation']) || typeof scope.incumbent.unit !== 'string' || !service.test(scope.incumbent.unit) ||
      !Number.isSafeInteger(scope.incumbent.pid) || scope.incumbent.pid < 1 || typeof scope.incumbent.invocation !== 'string' || !/^(?!0{32}$)[0-9a-f]{32}$/.test(scope.incumbent.invocation)) {
    throw refused('unsupported apply scope; engine-slot needs one declared unit and its incumbent unit, PID and invocation.');
  }
  if (internal) pinnedEngineSource(scope.rollback);
  return scope;
}

const outsideEngine = ['prepare', 'site', 'owned_folders', 'files', 'script', 'switch_check_command'];

function selectedEngine(row, scope) {
  const actual = row?.runs?.units;
  const selected = Array.isArray(actual) ? actual.filter(unit => unit.unit === scope.unit) : [];
  const engine = selected[0];
  if (selected.length !== 1 || engine.template !== ENGINE_TEMPLATE || !engine.slots || Object.keys(engine.slots).length !== 2 ||
      outsideEngine.some(key => Object.hasOwn(engine, key))) {
    throw refused('the engine scope needs one two-slot engine without a program prepare, owned files or custom switch commands.');
  }
  const effective = withSlots({ units: [engine] }).units;
  const all = withSlots({ units: actual }).units;
  const source = pinnedEngineSource(engine.source);
  for (const slot of effective) {
    if (slot.template !== ENGINE_TEMPLATE || outsideEngine.some(key => Object.hasOwn(slot, key)) || !isDeepStrictEqual(slot.parts, engine.parts) ||
        !isDeepStrictEqual(slot.source, source) || all.filter(other => other.unit === slot.unit).length !== 1 ||
        !/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(slot.health_listen ?? '')) throw refused('the engine scope needs unique slots with the same release pin and their own loopback readiness addresses.');
    sourceOf(slot);
  }
  if (effective[0].health_listen === effective[1].health_listen || !effective.some(slot => slot.unit === scope.incumbent.unit)) {
    throw refused('the scope does not name the incumbent of two distinct engine slots.');
  }
  return { engine, effective, source };
}

const engineDoorSitePointers = { app_host: '/app_host', site_host: '/site_host', server_name: '/name', command_word: '/cli' };

/** The selected engine may read door labels from the exact file the owner row binds to the `site` setting, nowhere else. */
export function engineScopeSiteFile(row, scope) {
  const { engine } = selectedEngine(row, scope);
  if (engine.parts === undefined) return undefined;
  if (engine.parts === null || typeof engine.parts !== 'object' || Array.isArray(engine.parts)) throw refused('engine site parts must be an object.');
  const bindings = row.runs.units.filter(unit => unit.parts && Object.hasOwn(unit.parts, '/settings/site')).map(unit => unit.parts['/settings/site']);
  const file = bindings[0]?.file;
  if (bindings.length !== 1 || !exactKeys(bindings[0], ['file']) || typeof file !== 'string' ||
      !/^(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_-]+\.json$/.test(file)) {
    throw refused('engine site parts need one relative owner file bound to the entire site setting.');
  }
  for (const [at, part] of Object.entries(engine.parts)) {
    const field = /^\/settings\/doors\/(?:0|[1-9][0-9]*)\/(app_host|site_host|server_name|command_word)$/.exec(at)?.[1];
    if (!field || !exactKeys(part, ['file', 'pointer']) || part.file !== file || part.pointer !== engineDoorSitePointers[field]) {
      throw refused('engine site parts may fill only the declared door fields from their owner site setting.');
    }
  }
  return file;
}

/** The fact that this is an engine release, not a partial whole-row reconcile, is proved by comparing the complete rows. */
export function engineScopeForEdit(before, after, asked) {
  const scope = readEngineScope(asked);
  const old = selectedEngine(before, scope), next = selectedEngine(after, scope);
  engineScopeSiteFile(after, scope);
  const expected = structuredClone(before);
  expected.runs.units.find(unit => unit.unit === scope.unit).source = withReleasePins(old.source, next.source);
  if (!isDeepStrictEqual(expected, after) || old.source.commit === next.source.commit || old.source.prebuilt.blake3 === next.source.prebuilt.blake3) {
    throw refused('an engine-slot apply changes just the selected unit’s source pin, not another field or the last whole-render pin.');
  }
  return { ...scope, rollback: old.source };
}

function checkedEngineRequest(request) {
  const allowed = new Set(['machine', 'ssh', 'computer_row', 'scope']);
  if (Object.keys(request).some(key => !allowed.has(key))) throw refused('the engine scope does not accept page, name or other apply arguments.');
  const scope = readEngineScope(request.scope, true);
  const next = selectedEngine(request.computer_row, scope);
  if (next.engine.parts !== undefined) throw refused('the selected engine’s site parts were not hydrated by its request reader.');
  if (!isDeepStrictEqual(withReleasePins(scope.rollback, next.source), next.source)) {
    throw refused('the engine scope cannot change source metadata other than the commit and prebuilt byte pin.');
  }
  if (scope.rollback.commit === next.source.commit || scope.rollback.prebuilt.blake3 === next.source.prebuilt.blake3 ||
      request.machine?.address !== request.computer_row.address) throw refused('the engine scope needs distinct pins and its owner row’s machine address.');
  const incumbent = next.effective.find(unit => unit.unit === scope.incumbent.unit), candidate = next.effective.find(unit => unit !== incumbent);
  const units = [incumbent, candidate];
  const before = { ...incumbent, source: scope.rollback };
  const rendered = renderWhatItRuns({ units: [before, candidate] });
  if (!isDeepStrictEqual(rendered, renderWhatItRuns({ units }))) throw refused('the engine scope would change a rendered file; use its owner to reconcile that drift separately.');
  return { scope, machine: { address: request.machine.address, ssh: request.ssh }, units, incumbent: before, candidate, rendered };
}

const slotFields = ['Id', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'MainPID', 'InvocationID', 'NeedDaemonReload', 'Job', 'FragmentPath', 'DropInPaths'];
async function scopeSlotState(machine, unit, run) {
  const output = await run(machine, `systemctl show ${slotFields.map(field => `-p ${field}`).join(' ')} ${q(unit.unit)}`);
  const state = Object.fromEntries(output.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const fragment = `/etc/systemd/system/${unit.unit}`;
  const dropIns = (unit.drop_ins ?? []).map(path => `${fragment}.d/${dropInName(path)}.conf`).sort();
  if (state.Id !== unit.unit || state.LoadState !== 'loaded' || state.NeedDaemonReload !== 'no' || !['0', ''].includes(state.Job) ||
      state.FragmentPath !== fragment || !isDeepStrictEqual(state.DropInPaths?.split(/\s+/).filter(Boolean).sort(), dropIns)) {
    throw refused(`${unit.unit} has unmanaged unit or job drift; no scoped change is admitted.`);
  }
  return state;
}

async function scopedSlotProof(machine, unit, run, { running, enabled, expected }) {
  const state = await scopeSlotState(machine, unit, run);
  const { MainPID: pid, InvocationID: invocation } = state;
  const process = running ? /^[1-9][0-9]*$/.test(pid) && /^(?!0{32}$)[0-9a-f]{32}$/.test(invocation) : pid === '0';
  if (!process || state.ActiveState !== (running ? 'active' : 'inactive') || state.SubState !== (running ? 'running' : 'dead') ||
      state.UnitFileState !== (enabled ? 'enabled' : 'disabled') || (expected && (Number(pid) !== expected.pid || invocation !== expected.invocation))) {
    throw refused(`${unit.unit} does not match the expected running or standby identity.`);
  }
  const source = sourceOf(unit), file = `${source.builds}/${source.commit}/${source.program}`, link = `${source.builds}/${source.current}`;
  const selected = (await run(machine, `readlink -- ${q(link)}`)).trim();
  if (selected !== source.commit) throw refused(`${unit.unit} does not select the required resident release.`);
  const actual = (await run(machine, `test -x ${q(file)} && [ "$(realpath -- ${q(file)})" = ${q(file)} ] && b3sum --no-names < ${q(file)}`)).trim();
  if (actual !== source.prebuilt) throw refused(`${unit.unit} resident executable does not match the row’s BLAKE3 pin.`);
  if (running && (await run(machine, `readlink -f -- /proc/${pid}/exe`)).trim() !== file) throw refused(`${unit.unit} does not run its selected resident executable.`);
  if (!isDeepStrictEqual(state, await scopeSlotState(machine, unit, run))) throw refused(`${unit.unit} changed while its process and bytes were checked.`);
  return { unit: unit.unit, pid: Number(pid), invocation, commit: source.commit, blake3: source.prebuilt };
}

async function admitScopedEngine(request, run) {
  const planned = checkedEngineRequest(request);
  const { scope, machine, incumbent, candidate, rendered } = planned;
  const observed = await readAll(machine, run, rendered);
  if (rendered.some(({ path, text }) => observed[path] !== text)) throw refused('the selected engine’s existing rendered files differ; the scoped apply does not write files.');
  const incumbentProof = await scopedSlotProof(machine, incumbent, run, { running: true, enabled: true, expected: scope.incumbent });
  const candidateProof = await scopedSlotProof(machine, candidate, run, { running: false, enabled: false });
  return { ...planned, incumbentProof, candidateProof };
}

/** A read-only check of the exact renderer and the two resident pins. It does not prepare or select any bytes. */
export async function checkScopedEngine(request, { run = onMachine } = {}) {
  const { machine, incumbent, candidate, incumbentProof, candidateProof } = await admitScopedEngine(request, run);
  await memoryForASlot(machine, { active: [incumbent] }, candidate, run);
  return { incumbent: incumbentProof, candidate: candidateProof };
}

async function applyScopedEngine(request, run, wait) {
  const { machine, units, scope, incumbent, candidate, incumbentProof } = await admitScopedEngine(request, run);
  const final = async (unit, enabled, expected) => scopedSlotProof(machine, unit, run, { running: true, enabled, expected });
  const standby = (unit, enabled = false) => scopedSlotProof(machine, unit, run, { running: false, enabled });
  let running, confirmed, linked = [];
  const switched = await overlapSlot(machine, { units, active: [units[0]] }, candidate, run, {
    start: 'start',
    ready: async () => {
      await commandPasses(machine, `curl --fail --silent --max-time 5 ${q(`http://${candidate.health_listen}/readyz`)}`, {
        run: async (target, command) => {
          const body = JSON.parse(await run(target, command));
          if (body.release_commit !== candidate.source.commit || body.draining !== false) throw refused('the candidate readiness response did not prove the requested release.');
        }, wait, tries: Math.max(1, Math.ceil((candidate.health?.wait_seconds ?? 60) / 5)),
      }, `${candidate.unit} readiness`);
      running = await final(candidate, false);
      await final(incumbent, true, incumbentProof);
    },
    notSwitched: async () => {
      await final(incumbent, true, incumbentProof);
      await standby(candidate);
      return true;
    },
    beforeRetire: async () => { linked = await pointLiveLinks(machine, candidate, run); },
    afterRetire: async () => {
      confirmed = await final(candidate, true, running);
      await standby(incumbent);
    },
  });
  return { written: [], restarted: [], booted: [candidate.unit], switched: [switched], ...(linked.length ? { linked } : {}), engine_scope: { unit: scope.unit, incumbent: incumbentProof, candidate: confirmed } };
}

function checkOrdinaryApplyFields(request) {
  if (Object.keys(request).some(key => !['machine', 'ssh', 'computer_row', 'pages_folder', 'engine_call'].includes(key))) throw refused('unknown apply request field.');
}

export async function applyAComputerRow(request, { held = {}, run = onMachine, fetchImpl = fetch, wait = pause } = {}) {
  if (Object.hasOwn(request, 'scope')) return applyScopedEngine(request, run, wait);
  checkOrdinaryApplyFields(request);
  checkPagesFollowCommit(request);
  const applied = await applyWhatItRuns({ ssh: request.ssh, address: request.machine.address }, runsOf(request), run, held, { pages: readPages(request), computer: request.machine.name });
  try {
    const names = await keepTheNames(request, { held, fetchImpl, apply: true });
    return names.length ? { ...applied, names } : applied;
  } catch (error) {
    // Successful unit apply is distinct from names that the provider did not confirm.
    return { ...applied, names_unconfirmed: error instanceof Error ? error.message : 'DNS failed without a verified result.' };
  }
}

export const ROW_APPLY_RESULT_PROTOCOL = 1;
export const SLOT_SWITCH_UNCONFIRMED_EXIT = 5;
export const computerRowApplyExit = answer => answer.names_unconfirmed !== undefined || (answer.names ?? []).some(name => name.unanswered) ? 4 : 0;
export const computerRowApplyReceipt = answer => ({ ...answer, row_apply_protocol: ROW_APPLY_RESULT_PROTOCOL });

export function computerRowApplyFailure(error) {
  const { apply_checked, slot_not_switched, slot_switch_unconfirmed, rolled_back } = error;
  if (apply_checked || slot_not_switched || slot_switch_unconfirmed) {
    return computerRowApplyReceipt({ apply_checked, slot_not_switched, slot_switch_unconfirmed, ...(rolled_back ? { rolled_back } : {}), error: error.message });
  }
}

/** What the computer the request names runs that its row does not render: [] when it matches. A name of the row that does not
 * answer with the row's address alone is one difference (its provider's key on descriptor 5, as for apply). */
export async function computerRowDifferences(request, { run = onMachine, held = {}, fetchImpl = fetch } = {}) {
  const units = await runsDifferences({ ssh: request.ssh, address: request.machine.address }, runsOf(request), run, { pages: readPages(request) });
  const names = (await keepTheNames(request, { held, fetchImpl, apply: false })).filter(name => !name.matches || name.records_match === false)
    .map(name => ({ path: name.host_name, reason: name.records_match === false && name.matches ? 'its record sets differ from its row' : name.unanswered ? `not known: ${name.unanswered}` : `answers ${name.answers.join(', ') || 'no address'}; its row says ${name.address}` }));
  return { differences: [...units, ...names] };
}

/** The names a computer's row says answer at its address (`runs.names`): each `{ host_name, provider, adopt? }`, where
 * `provider` is the DNS provider description (an absolute path of the person's own file, or one published in this Workshop such
 * under this tool's providers/) and its key is the value descriptor 5 holds under the description's
 * `vault_key`. The name is kept answering with the row's `address` alone (tools/move-the-public-door keepHealthyRecords): the
 * address is added when missing, records this row made for other addresses are removed, and a record nobody marked is left
 * untouched and refused unless the row says `adopt`; with `adopt` the name is the row's, so every other address record of the
 * name is removed too (named in `removed`), and a record the provider cannot list or remove is named in `unremovable`.
 * Nothing here names a provider or a domain. */
export function namesOf(request) {
  const row = request.computer_row ?? {}, names = row.runs?.names ?? [];
  if (!Array.isArray(names)) throw refused('runs.names is a list of { host_name, provider, adopt? }.');
  return names.map((name, n) => {
    if (typeof name?.host_name !== 'string' || typeof name.provider !== 'string') throw refused(`runs.names[${n}] names its host_name and its DNS provider description (provider).`);
    return { host_name: name.host_name.toLowerCase(), provider: readProvider(publishedFile(name.provider, `runs.names[${n}] provider`)), adopt: name.adopt === true, address: row.address, records: recordsOf(name.records, n) };
  });
}

/** The engine call a `transport: "engine"` DNS provider is sent through: the request's `engine_call`, the command line of the
 * engine that holds the person's connections (its program and every argument, one of them exactly `{run}`, where the run's JSON
 * goes), run with no shell and its answer read as JSON. This tool names no engine: whoever applies says which one answers. The run
 * carries no credential: the engine holds it and refreshes it. */
export function engineCallOf(command) {
  if (!Array.isArray(command) || command.length < 2 || !command.every(part => typeof part === 'string' && part.length > 0)
    || command.filter(part => part === '{run}').length !== 1 || command[0] === '{run}') {
    throw refused('The engine call needs engine_call: the engine\'s command line, its program first and one argument exactly {run}.');
  }
  return async run => {
    const argv = command.slice(1).map(part => (part === '{run}' ? JSON.stringify(run) : part));
    let stdout;
    try {
      ({ stdout } = await execFileAsync(command[0], argv, { maxBuffer: 16 * 1024 * 1024, timeout: 150000 }));
    } catch (error) { throw refused(`The engine call to ${run.tool} failed (exit ${error.code ?? 'none'}).`); }
    try { return JSON.parse(stdout); } catch { throw refused(`The engine call to ${run.tool} answered without JSON.`); }
  };
}

/** Each name of the row read (apply false: { matches, answers }) or kept (apply true: what changed). A name kept through an engine
 * provider needs an engine call: the request's `engine_call` when it gives one, else the row's own `runs.engine_call` (named once as DATA
 * on the computer row, so every apply and differences of the row keeps its names with nothing more), checked for every name before any
 * call is sent; `call` is the engine call (tests give a fake; default: engineCallOf of that command line). A name through a held-key provider needs its key under its vault name. */
export async function keepTheNames(request, { held = {}, fetchImpl = fetch, apply, call, waits = [3000, 10000] }) {
  const named = namesOf(request);
  const engineCall = request.engine_call ?? request.computer_row?.runs?.engine_call;
  for (const name of named) if (name.provider.transport === 'engine' && !engineCall) throw refused(`${name.host_name} is kept through ${name.provider.name} by the engine: the computer row names its runs.engine_call (or the request its engine_call).`);
  const kept = [];
  for (const name of named) {
    let dns;
    if (name.provider.transport === 'engine') dns = dnsClient(null, { provider: name.provider, call: call ?? engineCallOf(engineCall) });
    else {
      const key = held[name.provider.vault_key];
      if (typeof key !== 'string' || !key) throw refused(`${name.host_name} is kept through ${name.provider.name} with the key held under the vault name ${name.provider.vault_key}: hand it on descriptor 5 as {"${name.provider.vault_key}": value}, read from the person's vault.`);
      dns = dnsClient(key, { fetchImpl, provider: name.provider });
    }
    // A provider that does not answer is asked again after each of `waits`; one still silent after that leaves the name as it is
    // and is reported as `unanswered`, never as a failed apply: the units are already applied, and nothing was changed at the name.
    // Every other refusal (a record this row does not own, a name that is not one A record) still ends the apply.
    let outcome;
    for (let attempt = 0; ; attempt++) {
      try {
        if (!apply) {
          const answers = await addressesOfName({ hostname: name.host_name, request: dns, provider: name.provider });
          outcome = { host_name: name.host_name, address: name.address, answers, matches: answers.length === 1 && answers[0] === name.address };
        } else {
          const answer = await keepHealthyRecords({ hostname: name.host_name, candidates: [{ address: name.address }], check: () => true, request: dns, provider: name.provider, adopt: name.adopt });
          outcome = { host_name: name.host_name, address: name.address, added: answer.added.map(row => row.address), removed: answer.removed.map(row => row.content), ...(answer.unremovable.length ? { unremovable: answer.unremovable } : {}) };
        }
        break;
      } catch (error) {
        if (!/did not answer/.test(error.message)) throw error;
        if (attempt >= waits.length) { outcome = { host_name: name.host_name, address: name.address, unanswered: error.message, ...(apply ? {} : { matches: false }) }; break; }
        await new Promise(resolve => setTimeout(resolve, waits[attempt]));
      }
    }
    if (name.records.length && !outcome.unanswered) {
      if (apply) outcome.records = await keepRecordSets({ hostname: name.host_name, declared: name.records, request: dns, provider: name.provider });
      else outcome.records_match = JSON.stringify(await recordSetsOf({ hostname: name.host_name, declared: name.records, request: dns, provider: name.provider })) === JSON.stringify(declaredSetsOf(name.records));
    }
    kept.push(outcome);
  }
  return kept;
}

/** A names entry's own record sets beside its address record: `records` is a list of { type, value, priority? } rows (an MX's
 * priority is its own key). The address record (A) and CNAME are the row's address, never a record set here. */
function recordsOf(records, n) {
  if (records === undefined) return [];
  if (!Array.isArray(records) || !records.every(record => typeof record?.type === 'string' && /^[A-Z]+$/.test(record.type) && typeof record.value === 'string' && record.value && (record.priority === undefined || Number.isInteger(record.priority)))) throw refused(`runs.names[${n}] records is a list of { type, value, priority? } rows.`);
  if (records.some(record => record.type === 'A' || record.type === 'CNAME')) throw refused(`runs.names[${n}] records names an A or CNAME record: the address is the row's own address record.`);
  return records;
}

/** A request read from its file, each of its paths resolved against the file's own folder. */
export function readRequest(file) {
  const request = JSON.parse(readFileSync(absolute(file, 'REQUEST_FILE'), 'utf8')), here = dirname(file);
  const resolveIn = (holder, key) => { if (holder && typeof holder[key] === 'string') holder[key] = resolvePath(here, holder[key]); };
  resolveIn(request, 'lease_file');
  resolveIn(request, 'pages_folder');
  // The computer's row may be its own file (`computer_row_file`): the row is that file's JSON, read here.
  let rowHere = here;
  const scoped = Object.hasOwn(request, 'scope');
  if (scoped) readEngineScope(request.scope, true);
  if (typeof request.computer_row_file === 'string') {
    const rowFile = resolvePath(here, request.computer_row_file);
    request.computer_row = JSON.parse(readFileSync(rowFile, 'utf8'));
    rowHere = dirname(rowFile);
    delete request.computer_row_file;
  }
  // A unit's `parts` fill it from what the person keeps (any file: their own description, a provider's): each key is a JSON
  // Pointer (RFC 6901) into the unit (its settings, a web server's site, any field), each value `{ file, pointer }`, the value at
  // that pointer of the file's JSON (pointer "" or none: the whole file), read relative to the computer row's file. The tool
  // names no setting and no field: which value goes where is the person's.
  const scopeSiteFile = scoped ? engineScopeSiteFile(request.computer_row, request.scope) : undefined;
  let ownerSite;
  if (scopeSiteFile) {
    const source = resolvePath(realpathSync(rowHere), scopeSiteFile);
    if (realpathSync(source) !== source) throw refused('the engine’s owner site setting file may not be redirected.');
    ownerSite = JSON.parse(readFileSync(source, 'utf8'));
  }
  const partsUnits = scoped ? request.computer_row.runs.units.filter(unit => unit.unit === request.scope.unit) : request.computer_row?.runs?.units ?? [];
  for (const unit of partsUnits) {
    for (const [target, part] of Object.entries(unit.parts ?? {})) {
      const where = `${unit.unit} parts ${target}`;
      if (!target.startsWith('/') || !part || typeof part.file !== 'string' || (part.pointer !== undefined && typeof part.pointer !== 'string')) {
        throw refused(`${where}: each key is a JSON Pointer into the unit (it starts with /) and each value { file, pointer }.`);
      }
      const content = scoped ? ownerSite : JSON.parse(readFileSync(resolvePath(rowHere, part.file), 'utf8'));
      const value = pointed(content, part.pointer ?? '', `${where} reads ${part.file}`);
      if (scoped && (typeof value !== 'string' || !value)) throw refused('the engine door field must be nonempty text in the owner site setting.');
      const keys = pointerKeys(target), last = keys.pop();
      const holder = keys.reduce((held, key) => held?.[key], unit);
      if (!holder || typeof holder !== 'object') throw refused(`${where}: the unit holds nothing at ${target.slice(0, target.lastIndexOf('/')) || '/'} to put it in.`);
      holder[Array.isArray(holder) ? Number(last) : last] = value;
    }
    delete unit.parts;
  }
  resolveIn(request.machine, 'provider');
  resolveIn(request.name, 'provider');
  resolveIn(request.machine, 'public_key_file');
  resolveIn(request.ssh, 'known_hosts');
  resolveIn(request.ssh, 'identity_file');
  return request;
}

/** The reference tokens of a JSON Pointer (RFC 6901): `~1` is `/` and `~0` is `~`. */
const pointerKeys = pointer => pointer === '' ? [] : pointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));

/** The value at `pointer` in `whole`; a pointer that names nothing is refused with where it was read. */
function pointed(whole, pointer, where) {
  if (pointer !== '' && !pointer.startsWith('/')) throw refused(`${where}: ${pointer} is not a JSON Pointer.`);
  let at = whole;
  for (const key of pointerKeys(pointer)) {
    if (at === null || typeof at !== 'object' || !(key in at)) throw refused(`${where}: nothing is at ${pointer}.`);
    at = at[key];
  }
  return at;
}

/** The values descriptor 5 hands, as one JSON object of vault name to value; anything else is refused without echoing it. */
function heldValues(text) {
  let values;
  try { values = JSON.parse(text || '{}'); } catch { throw refused('Descriptor 5 holds no JSON object of vault name to value.'); }
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(value => typeof value !== 'string')) throw refused('Descriptor 5 holds no JSON object of vault name to value.');
  return values;
}

async function pipe(fd) {
  let text = '';
  try { for await (const bytes of createReadStream(null, { fd, autoClose: false })) { text += bytes; if (text.length > 65536) throw new Error(`Descriptor ${fd} exceeds its private input bound.`); } }
  catch (error) { if (error.code === 'EBADF') return ''; throw error; }
  return text.trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, first, second, third] = process.argv.slice(2);
  const usage = 'usage: start-a-computer.mjs price REQUEST_FILE | rent REQUEST_FILE | start REQUEST_FILE | apply REQUEST_FILE | differences REQUEST_FILE | status LEASE_FILE | unit LEASE_FILE REQUEST_FILE | remove LEASE_FILE | register LEASE_FILE ADDRESS (the one-time token from the rent line on fd 3) (machine credential on fd 3, name credential on fd 4, the values a computer row names by vault name on fd 5)';
  const json = path => {
    const request = readRequest(resolvePath(path));
    if (operation !== 'apply' && Object.hasOwn(request, 'scope')) throw refused('engine scope is not supported by this operation.');
    return request;
  };
  try {
    if (operation === 'register') {
      if (!first || !second || third) throw Object.assign(new Error(usage), { exit: 2 });
      const lease = await registerMachine({ store: fileStore(resolvePath(first)), token: await pipe(3), address: second });
      process.stdout.write(`${JSON.stringify({ name: lease.name, provider: lease.provider, state: lease.state, address: lease.address })}\n`);
      process.exit(0);
    }
    if (operation === 'apply' || operation === 'differences') {
      if (!first || second) throw Object.assign(new Error(usage), { exit: 2 });
      const request = json(first), scoped = Object.hasOwn(request, 'scope');
      if (!scoped && operation === 'apply') checkOrdinaryApplyFields(request);
      const runs = scoped ? null : await withPrepared(runsOf(request), { pages: readPages(request) });
      const named = !scoped && (request.computer_row?.runs?.names ?? []).length > 0;
      const held = !scoped && ((operation === 'apply' && runs.units.some(needsHeld)) || named) ? heldValues(await pipe(5)) : {};
      const answer = operation === 'apply' ? await applyAComputerRow(request, { held }) : await computerRowDifferences(request, { held });
      process.stdout.write(`${JSON.stringify(operation === 'apply' ? computerRowApplyReceipt(answer) : answer)}\n`);
      process.exit(operation === 'apply' ? computerRowApplyExit(answer) : 0);
    }
    if (!first || third || !['price', 'rent', 'start', 'status', 'unit', 'remove'].includes(operation) || (operation === 'unit') !== Boolean(second)) throw Object.assign(new Error(usage), { exit: 2 });
    const asked = ['price', 'rent', 'start'].includes(operation), lease = asked ? null : await readLease(fileStore(resolvePath(first)));
    const needsName = ['rent', 'start'].includes(operation) ? Boolean(json(first).name?.provider) : operation === 'remove' && Boolean(lease.recordId);
    const needsMachine = operation !== 'unit' && Boolean(readProvider(asked ? json(first).machine.provider : lease.providerFile).base);
    const startRuns = operation === 'start' ? await withPrepared(runsOf(json(first)), { pages: readPages(json(first)) }) : null;
    const tokens = { machineToken: needsMachine ? await pipe(3) : '', nameToken: needsName ? await pipe(4) : '', held: (startRuns?.units ?? []).some(needsHeld) ? heldValues(await pipe(5)) : {} };
    const answer = operation === 'price' ? await priceOfAComputer(json(first), tokens)
      : operation === 'rent' ? await rentAMachine(json(first), tokens).then(({ lease, host_name, arch, price, line, terms_url }) => ({ lease, host_name, arch, price, terms_url, ...(line && { line }) }))
      : operation === 'start' ? await startAComputer(json(first), tokens)
      : operation === 'status' ? await computerStatus(resolvePath(first), tokens)
        : operation === 'unit' ? await unitStatus(resolvePath(first), json(second))
          : await removeAComputer(resolvePath(first), tokens);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    if (answer.alert === true) process.exitCode = 3;
  } catch (error) {
    const receipt = computerRowApplyFailure(error);
    if (receipt) process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
