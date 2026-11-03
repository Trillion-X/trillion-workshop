// Build the existing receptionist on its actual Linux host from one immutable committed source tree.
// Git archive transfers declared source only; no home, Git configuration, credentials, local state or account DB travels.
// Moved here from Trillion-X/trillion scripts/portable-receptionist-build.mjs, with the build-machine part of
// scripts/portable-service-host-setup.sh (lines 2-4 and 26-35). The receptionist is trillion-rust
// src/bin/trillion-mcp-receptionist.rs; nothing here changes it. Every host path, port, user and the Rust toolchain
// version is the request's (config); this file names no host. The administration key reaches ssh only as the held file
// the engine mounts.
//
// Four operations, one per row: prepare (packages, the source folder, swap, the pinned Rust toolchain), inspect (read the
// host), build (send git archive of one commit and build it there) and install (check the built file, make it runnable,
// and copy it to install_path when one is given). Run as: node receptionist-build.mjs <operation> <held key file>, with
// the request on stdin; the last line is { result } or { error }. "dry_run": true answers what it would run, and runs
// nothing.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { administrationArguments, checkedHost, knownHostsLine, port } from '../../administer-a-rented-host/do-work/administration-arguments.mjs';

// What this tool builds. These name the receptionist itself, not the host, so they are written here.
export const BINARY = 'trillion-mcp-receptionist';
export const BOOTSTRAP_TEST = 'bootstrap_consumes_and_closes_the_original_credential_descriptor';
export const OPERATIONS = ['prepare', 'inspect', 'build', 'install'];

const COMMIT = /^[a-f0-9]{40}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const TOOLCHAIN = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/;
const PACKAGE = /^[a-z0-9][a-z0-9+.-]{0,99}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SIZE = /^[1-9][0-9]{0,5}[MG]$/;

// An absolute host path with no quote, space, `.`/`..` part or trailing slash: safe inside single quotes on the host.
function path(value, field) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9._/-]{1,255}$/.test(value) || value.endsWith('/') || value.includes('//') || value.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`${field} was refused: give an absolute path on the host with letters, digits, . _ - and /, and no .. (for example /srv/receptionist).`);
  }
  return value;
}
const q = value => `'${value}'`;
const sourceRoot = config => path(config.source_root, 'source_root');

function rust(config) {
  const r = config.rust;
  if (!r || typeof r !== 'object') throw new Error('rust is missing: give { toolchain, cargo_home, rustup_home }, for example { "toolchain": "1.93.0", "cargo_home": "/srv/rust/cargo", "rustup_home": "/srv/rust/rustup" }.');
  if (typeof r.toolchain !== 'string' || !TOOLCHAIN.test(r.toolchain)) throw new Error('rust.toolchain was refused: give an exact Rust version such as "1.93.0", not a channel name.');
  return { toolchain: r.toolchain, cargo_home: path(r.cargo_home, 'rust.cargo_home'), rustup_home: path(r.rustup_home, 'rust.rustup_home') };
}
const rustEnvironment = r => `export CARGO_HOME=${q(r.cargo_home)} RUSTUP_HOME=${q(r.rustup_home)};`;

// The built file for `commit` under the request's source_root.
export const executableOf = (config, commit) => `${sourceRoot(config)}/${commit}/target/release/${BINARY}`;

// prepare: the build-machine setup from the old host setup's lines 2-4 (packages) and 26-35 (folders, swap, Rust). The
// service user and sshd lines of that file are the door tunnel's, not this tool's.
export function prepareCommand(config) {
  const packages = config.build_packages;
  if (!Array.isArray(packages) || !packages.length || !packages.every(name => typeof name === 'string' && PACKAGE.test(name))) throw new Error('build_packages was refused: give the Debian package names the build needs, for example ["build-essential", "pkg-config", "libssl-dev", "ca-certificates", "curl"].');
  const root = sourceRoot(config);
  const swap = config.swap;
  if (!swap || typeof swap !== 'object' || typeof swap.size !== 'string' || !SIZE.test(swap.size)) throw new Error('swap was refused: give { path, size } with size like "4G" or "512M", for example { "path": "/srv/build-swap", "size": "4G" }.');
  const swapPath = path(swap.path, 'swap.path');
  const r = rust(config);
  const rustup = `${r.cargo_home}/bin/rustup`;
  return ['set -eu', 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update -qq', `apt-get install -y -qq ${packages.join(' ')}`,
    `install -d -m 755 ${q(root)} ${q(dirname(swapPath))}`,
    `if [ ! -f ${q(swapPath)} ]; then fallocate -l ${swap.size} ${q(swapPath)}; chmod 600 ${q(swapPath)}; mkswap ${q(swapPath)} >/dev/null; fi`,
    `swapon --show=NAME --noheadings | grep -Fxq ${q(swapPath)} || swapon ${q(swapPath)}`,
    rustEnvironment(r),
    `if [ ! -x ${q(rustup)} ]; then curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain ${r.toolchain}; else ${q(rustup)} toolchain install ${r.toolchain} --profile minimal; fi`,
    `${q(`${r.cargo_home}/bin/rustc`)} +${r.toolchain} --version`,
    `printf 'receptionist-build-host-prepared: rust ${r.toolchain}, source under %s\\n' ${q(root)}`, ''].join('\n');
}

// inspect: what the host has now, with the request's toolchain, ports and service user.
export function inspectCommand(config) {
  const root = sourceRoot(config);
  const r = rust(config);
  const ports = config.ports ?? [];
  if (!Array.isArray(ports) || !ports.every(port)) throw new Error('ports was refused: give a list of whole numbers from 1 to 65535, for example [443, 9443].');
  if (config.service_user !== undefined && (typeof config.service_user !== 'string' || !USER.test(config.service_user))) throw new Error('service_user was refused: give a Linux user name (lowercase letters, digits, _ or -, at most 32), or leave it out.');
  return [rustEnvironment(r), 'uname -a', `${q(`${r.cargo_home}/bin/rustc`)} +${r.toolchain} --version || true`, 'free -h',
    "ps -eo pid,ppid,etime,comm | grep -E '(cargo|rustc|rustup|cc1|ld)' || true",
    `find ${q(root)} -maxdepth 2 -name Cargo.toml -printf '%h\\n' 2>/dev/null || true`,
    `find ${q(root)} -type f -name ${BINARY} -exec readelf -h '{}' \\; 2>/dev/null | head -20`,
    ...(ports.length ? [`ss -ltnp | grep -E '(${ports.map(n => `:${n}\\b`).join('|')})' || true`] : []),
    ...(config.service_user ? [`passwd -S ${config.service_user} || true`, `journalctl -u ssh --since '-5 minutes' --no-pager | grep -F ${q(config.service_user)} | tail -6 || true`] : [])].join('; ');
}

// build: unpack the archive on stdin into the commit's folder and build there, then run the test that proves the
// receptionist consumes and closes its bootstrap credential descriptor.
export function buildCommand(config, commit, directory) {
  const r = rust(config);
  const cargo = `${q(`${r.cargo_home}/bin/cargo`)} +${r.toolchain}`;
  const executable = executableOf(config, commit);
  return `set -eu; umask 077; ${rustEnvironment(r)} install -d ${q(directory)}; tar -xf - -C ${q(directory)}; cd ${q(directory)}; `
    + `${cargo} build --locked --release --bin ${BINARY} >build.log 2>&1 || { tail -120 build.log; exit 1; }; `
    + `${cargo} test --locked --release --bin ${BINARY} ${BOOTSTRAP_TEST} >>build.log 2>&1 || { tail -120 build.log; exit 1; }; `
    + `tail -8 build.log; printf '\\nsource-commit: ${commit}\\n'; readelf -h ${q(executable)} | sed -n '1,18p'; ls -l ${q(executable)}`;
}

export function prepareReceptionistHost(config, { run = execFileSync } = {}) {
  return run('/usr/bin/ssh', [...administrationArguments(config), '/bin/sh', '-s'], { input: prepareCommand(config), encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
}

export function prepareReceptionistArtifact(config, readback, { run = execFileSync } = {}) {
  if (readback.state !== 'built' || !/^[a-f0-9]{40}$/.test(readback.commit) || readback.executable !== executableOf(config, readback.commit)) throw new Error('The qualified Linux artifact was refused: give the full commit the build answered.');
  return run('/usr/bin/ssh', [...administrationArguments(config), `set -eu; test -f '${readback.executable}'; chmod 0755 '${readback.executable}'; ls -l '${readback.executable}'`], { encoding: 'utf8', timeout: 10000, maxBuffer: 64000 });
}

// The runnable copy at install_path, swapped in with one rename so a running receptionist never sees half a file.
export function placeReceptionist(config, readback, { run = execFileSync } = {}) {
  const target = path(config.install_path, 'install_path');
  return run('/usr/bin/ssh', [...administrationArguments(config), `set -eu; install -d -m 755 ${q(dirname(target))}; install -m 0755 ${q(readback.executable)} ${q(`${target}.new`)}; mv -f ${q(`${target}.new`)} ${q(target)}; ls -l ${q(target)}`], { encoding: 'utf8', timeout: 10000, maxBuffer: 64000 });
}

export function inspectReceptionistHost(config, { run = execFileSync } = {}) {
  return run('/usr/bin/ssh', [...administrationArguments(config), inspectCommand(config)], { encoding: 'utf8', timeout: 15000, maxBuffer: 64000 });
}

export function buildReceptionist(config, { repository, revision = 'HEAD', receiptFile, run = execFileSync } = {}) {
  if (!repository) throw new Error('The source repository was refused.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(revision)) throw new Error('The source revision was refused.');
  const commit = run('/usr/bin/git', ['-C', repository, 'rev-parse', '--verify', `${revision}^{commit}`], { encoding: 'utf8', timeout: 10000 }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('The source commit was refused.');
  const archive = run('/usr/bin/git', ['-C', repository, 'archive', '--format=tar', commit], { timeout: 30000, maxBuffer: 128 * 1024 * 1024 });
  const directory = `${sourceRoot(config)}/${commit}`;
  if (receiptFile) writeFileSync(receiptFile, `${JSON.stringify({ state: 'building', commit, directory })}\n`, { mode: 0o600 });
  const command = buildCommand(config, commit, directory);
  try {
    const output = run('/usr/bin/ssh', [...administrationArguments(config), command], { input: archive, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    return { state: 'built', commit, directory, executable: `${directory}/target/release/trillion-mcp-receptionist`, output };
  } catch (error) {
    if (receiptFile) writeFileSync(receiptFile, `${JSON.stringify({ state: 'failed', commit, directory, exitCode: error.status ?? null, output: String(error.stdout ?? '').slice(-16000) })}\n`, { mode: 0o600 });
    throw error;
  }
}

// Every field an operation reads, checked before anything runs, so a refusal names the field and how to fix it.
function checkedRequest(operation, input) {
  if (!OPERATIONS.includes(operation)) throw new Error(`operation ${operation} was refused: give one of ${OPERATIONS.join(', ')}.`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The request was refused: give one JSON object.');
  knownHostsLine(checkedHost(input.host));
  if (operation === 'prepare') prepareCommand(input);
  if (operation === 'inspect') inspectCommand(input);
  if (operation === 'build') {
    rust(input);
    sourceRoot(input);
    if (typeof input.repository !== 'string' || !input.repository.startsWith('/')) throw new Error('repository was refused: give the full path of a local trillion-rust checkout.');
    if (input.revision !== undefined && (typeof input.revision !== 'string' || !REVISION.test(input.revision))) throw new Error('revision was refused: give a branch, tag or commit (letters, digits, . _ / -), or leave it out for HEAD.');
    if (input.dry_run === true && !COMMIT.test(input.revision ?? '')) throw new Error('A dry run of build reads no repository: give revision as the full 40-character commit to plan.');
  }
  if (operation === 'install') {
    if (typeof input.commit !== 'string' || !COMMIT.test(input.commit)) throw new Error('commit was refused: give the full 40-character commit id the build answered.');
    sourceRoot(input);
    if (input.install_path !== undefined) path(input.install_path, 'install_path');
  }
  return input;
}

// What an execFileSync failure said, for the refusal.
const said = error => [error.stdout, error.stderr].map(part => String(part ?? '').trim()).filter(Boolean).join('\n').slice(-4000) || error.message;

// Run one operation. `run` is execFileSync unless a test gives its own; a dry run gives a recorder instead.
export function receptionistBuild(operation, input, keyFile, { run = execFileSync } = {}) {
  checkedRequest(operation, input);
  const dryRun = input.dry_run === true;
  const planned = [];
  const recorder = (file, args, options) => {
    if (file === '/usr/bin/git') return args.includes('rev-parse') ? `${input.revision}\n` : Buffer.alloc(0);
    planned.push({ args, input: options.input });
    return '';
  };
  const folder = dryRun ? null : mkdtempSync(`${tmpdir()}/receptionist-build-`);
  const config = { ...input, ...input.host, adminKeyFile: keyFile, knownHostsFile: dryRun ? '<pinned known_hosts>' : `${folder}/known_hosts` };
  const options = { run: dryRun ? recorder : run };
  try {
    if (!dryRun) writeFileSync(config.knownHostsFile, knownHostsLine(input.host), { mode: 0o600 });
    let answer;
    if (operation === 'prepare') answer = { operation, output: prepareReceptionistHost(config, options) };
    else if (operation === 'inspect') answer = { operation, output: inspectReceptionistHost(config, options) };
    else if (operation === 'build') answer = { operation, ...buildReceptionist(config, { ...options, repository: input.repository, revision: input.revision ?? 'HEAD' }) };
    else {
      const readback = { state: 'built', commit: input.commit, executable: executableOf(config, input.commit) };
      let output = prepareReceptionistArtifact(config, readback, options);
      if (input.install_path !== undefined) output += placeReceptionist(config, readback, options);
      answer = { operation, state: 'installed', commit: input.commit, executable: input.install_path ?? readback.executable, output };
    }
    if (!dryRun) return answer;
    const sent = planned.map(({ args, input: stdin }) => (args.at(-1) === '-s' ? stdin : args.at(-1)));
    return { operation, dry_run: true, ...(answer.commit ? { commit: answer.commit } : {}), ssh: administrationArguments(config), remote_command: sent.join('\n') };
  } catch (error) {
    if (error.status === undefined && error.signal === undefined) throw error;
    if (/^Command failed: \S*git /.test(error.message)) throw new Error(`revision ${input.revision ?? 'HEAD'} could not be read from ${input.repository}: ${said(error)}. Name a commit, branch or tag that is committed there.`);
    throw new Error(`${operation} on ${input.host.address} failed (exit ${error.status ?? error.signal}): ${said(error)}. Read it, fix the host or the request, and run ${operation} again.`);
  } finally {
    if (folder) rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, keyFile] = process.argv.slice(2);
  try {
    if (!keyFile) throw new Error('usage: receptionist-build.mjs <prepare|inspect|build|install> <held key file>, with the request on stdin.');
    let input;
    try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { throw new Error('The request was refused: standard input is not JSON.'); }
    process.stdout.write(`${JSON.stringify({ result: receptionistBuild(operation, input, keyFile) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  }
}
