// tools/carry-a-computer-to-a-meeting-point/do-work/carry-a-computer.mjs
//
// Carries a computer to a meeting point: a program the computer starts that dials out to a public host, so a computer
// behind a router is reached with no inbound port. Which program, with which files and arguments, is a way row
// (read-data/ways.json); this file is the one runner for every row. It names no program, no operating system and no host:
// each is a row, and a new way is a new row. The meeting-point side port of a computer is a stable hash of its id.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { fill } from '../../start-a-computer/do-work/fill-fields.mjs';
import { INIT_ROWS, holds, installInit, removeInit, selectInit } from '../../start-a-computer/do-work/install-init.mjs';

const DATA = name => JSON.parse(readFileSync(new URL(`../read-data/${name}.json`, import.meta.url), 'utf8'));
export const WAYS = DATA('ways').rows;
export const PORT_RANGE = (({ min, max }) => ({ min, max }))(DATA('ports'));
export const CARRIER_FILES = DATA('carrier-files');

const hex = text => bytesToHex(blake3(new TextEncoder().encode(text)));
const encoder = new TextEncoder();
const here = () => ({ platform: process.platform, arch: process.arch });
const octal = text => parseInt(text ?? '0600', 8);

/** The port a computer listens on at the meeting point: BLAKE3 of `salt:id`, its first four bytes, modulo the range's width. */
export function portFor(computerId, { min, max } = PORT_RANGE, salt = '') {
  if (typeof computerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(computerId)) throw new Error('a computer id is letters, digits, - and _');
  const word = new DataView(blake3(encoder.encode(`${salt}:${computerId}`)).buffer).getUint32(0);
  return min + (word % (max - min + 1));
}

/** The values a way row's text and arguments are filled with, for one computer at one relay host. */
export function valuesFor({ way, relay_host: relayHost, computer_id: computerId, salt = '', local_port: localPort, ports = PORT_RANGE, values = {} }) {
  const base = { computer_id: computerId, salt, short_id: hex(computerId).slice(0, 16), remote_port: portFor(computerId, ports, salt), host: relayHost.hostname, ...(relayHost.params ?? {}), ...values };
  if (localPort !== undefined) base.local_port = localPort;
  const own = Object.fromEntries(Object.entries(way.params ?? {}).map(([key, value]) => [key, typeof value === 'string' ? fill(value, base, `way ${way.id} params.${key}`) : value]));
  return { ...base, ...own };
}

/** The first artifact of a program row that holds for this computer's facts. */
export function pickArtifact(program, have = here()) {
  const artifact = program.artifacts.find(candidate => holds(candidate.where, have));
  if (!artifact) throw new Error(`no build of the program fits ${JSON.stringify(have)}`);
  return artifact;
}

/** The path of the program a row names for this computer: a command already there, or the pinned download, checked against
 * its BLAKE3 before anything is unpacked, kept in <state>/programs/<blake3> and never fetched again once it is there. */
export async function ensureProgram(program, { have = here(), state, fetchBytes = async url => new Uint8Array(await (await fetch(url)).arrayBuffer()), run = execFileSync } = {}) {
  const artifact = pickArtifact(program, have);
  if (artifact.command) return artifact.command;
  const dir = join(state, 'programs', artifact.blake3), exe = join(dir, artifact.exe);
  if (existsSync(exe)) return exe;
  const bytes = await fetchBytes(artifact.url);
  if (bytes.length !== artifact.size || bytesToHex(blake3(bytes)) !== artifact.blake3) throw new Error(`the download from ${artifact.url} is not the pinned file`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'download');
  writeFileSync(file, bytes);
  const [command, ...args] = artifact.extract.map(part => fill(part, { file, dir }, 'the program row'));
  run(command, args, { stdio: 'pipe' });
  chmodSync(exe, 0o755);
  return exe;
}

/** The files and arguments the client gets for one computer. `dir` is the private folder the files are written in; the
 * secret may be in a file's text and never in an argument. */
export function renderClient(way, values, { secret, dir }) {
  const files = way.client.files.map(file => ({ name: file.name, mode: octal(file.mode), text: fill(file.text, { ...values, secret, dir }, `way ${way.id} file ${file.name}`) }));
  const argv = way.client.argv.map(part => fill(part, { ...values, dir }, `way ${way.id} argument`));
  return { files, argv };
}

/** Runs a way's `key.make` in `dir`, which is the folder its private and public files are left in. */
function runKeyMake(way, dir, run) {
  const [command, ...args] = way.key.make.map(part => fill(part, { dir }, `way ${way.id} key`));
  run(command, args, { stdio: 'ignore' });
}

/** The private and public texts a way's key files hold in `dir`. */
const readKey = (way, dir) => ({ private: readFileSync(join(dir, way.key.private), 'utf8'), public: readFileSync(join(dir, way.key.public), 'utf8').trim() });

/** A new key for a way that says how one is made (`key`): its command runs in a private folder that is removed after, and the
 * private and public texts are answered, for the caller to keep where it keeps credentials. */
export function makeKey(way, { state, run = execFileSync } = {}) {
  if (!way.key) throw new Error(`way ${way.id} makes no key`);
  mkdirSync(join(state, 'run'), { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(state, 'run', 'key-'));
  try {
    runKeyMake(way, dir, run);
    return readKey(way, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The carrier's own key for a config that names no credential_command: kept in <state>/key (the folder 0700, its files 0600).
 * The way's `key.make` runs there on the first start, and every later start reads the same key back. */
export function keptKey(way, { state, run = execFileSync } = {}) {
  if (!way.key) throw new Error(`way ${way.id} makes no key`);
  const dir = join(state, 'key');
  if (!existsSync(join(dir, way.key.private)) || !existsSync(join(dir, way.key.public))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    runKeyMake(way, dir, run);
    for (const name of [way.key.private, way.key.public]) chmodSync(join(dir, name), 0o600);
  }
  return readKey(way, dir);
}

/** A credential's text without the one line end a key file or a vault value ends with: the client's file adds its own. */
const credentialText = text => text.replace(/\n$/, '');

/** The credential the client dials with, read from the descriptor 3 of a vault command, never from its output. */
export function credentialFrom(command) {
  return () => new Promise((done, fail) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdio[3].on('data', chunk => chunks.push(chunk));
    child.once('error', fail);
    child.once('exit', code => (code === 0 && chunks.length ? done(credentialText(Buffer.concat(chunks).toString('utf8'))) : fail(new Error('the credential command gave no value'))));
  });
}

/** The JSON a command prints on its standard output, or null when it fails or prints something else. */
function answerOf(spawnImpl, argv) {
  return new Promise(done => {
    const child = spawnImpl(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
    let said = '';
    child.stdout?.on('data', bytes => { if (said.length < 65536) said += bytes.toString(); });
    child.once('error', () => done(null));
    child.once('exit', code => { try { done(code === 0 ? JSON.parse(said) : null); } catch { done(null); } });
  });
}

/** Keeps one computer carried: starts the way's client, and starts it again two seconds after it ends, until aborted. With no
 * `credential` (the config names no credential_command), the carrier's own key (keptKey) is the credential, and its public half
 * is the announced key unless the config gives one. */
export async function serveCarrier(given, { credential, state, have = here(), spawnImpl = spawn, fetchBytes, run, wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms)), signal, report = () => {} }) {
  const own = credential ? null : keptKey(given.way, { state, run });
  const config = own && given.values?.public_key === undefined ? { ...given, values: { ...given.values, public_key: own.public } } : given;
  const credentialOf = credential ?? (async () => credentialText(own.private));
  const { way } = config;
  const exe = await ensureProgram(way.client.program, { have, state, fetchBytes, run });
  const gives = config.announce?.gives;
  // A try that failed (the meeting point refused the port, or the client ended before it was carried) moves to another salt,
  // so a port that collides with another person's is left for the next one the meeting point derives.
  let failed = 0;
  while (!signal?.aborted) {
    let values = valuesFor({ ...config, salt: failed ? `${config.salt ?? ''}${failed}` : config.salt });
    const announceArgv = carried => config.announce.argv.map(part => fill(part, { ...values, carried }, 'announce'));
    // An announcement whose answer the client needs (`announce.gives`: a value name for each answer field, such as the port the
    // meeting point gives this computer and a certificate that may listen on it alone) is asked before the client starts.
    if (gives) {
      const answer = await answerOf(spawnImpl, announceArgv(false));
      const given = answer && Object.entries(gives).map(([name, field]) => [name, answer[field]]);
      if (!given || given.some(([, value]) => value === undefined || value === null)) {
        failed += 1;
        report({ way: way.id, ended: true, exit_code: null, said: 'the meeting point did not answer the announcement' });
        if (!signal?.aborted) await wait(2000);
        continue;
      }
      values = { ...values, ...Object.fromEntries(given) };
    }
    const secret = await credentialOf();
    mkdirSync(join(state, 'run'), { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(state, 'run', 'carrier-'));
    try {
      const { files, argv } = renderClient(way, values, { secret, dir });
      for (const file of files) writeFileSync(join(dir, file.name), file.text, { mode: file.mode });
      const child = spawnImpl(exe, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
      // While the carrier runs, the meeting point is told whose computer is at this port (`announce`, with {remote_port} and
      // {carried} filled) every `every_seconds`, so the announcement lasts only while carried. One the meeting point answers
      // (`gives`) is first told once the client has held its port for `settle_seconds`, and a refused one ends the client: a
      // computer is never announced at a port it does not hold.
      let carried = false;
      const announce = () => {
        if (!gives) { spawnImpl(config.announce.argv[0], announceArgv(true).slice(1), { stdio: 'ignore' }).on?.('error', () => {}); return; }
        answerOf(spawnImpl, announceArgv(true)).then(answer => { if (answer) carried = true; else child.kill('SIGTERM'); });
      };
      const timers = [];
      if (config.announce) {
        const every = () => timers.push(setInterval(announce, config.announce.every_seconds * 1000));
        if (gives) timers.push(setTimeout(() => { announce(); every(); }, (config.announce.settle_seconds ?? 3) * 1000));
        else { announce(); every(); }
      }
      child.once('exit', () => timers.forEach(timer => clearInterval(timer)));
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      let said = '';
      child.stderr.on('data', bytes => { if (said.length < 4096) said += bytes.toString().slice(0, 4096 - said.length); });
      const code = await new Promise(resolveExit => { child.once('error', () => resolveExit(null)); child.once('exit', resolveExit); });
      signal?.removeEventListener('abort', abort);
      if (gives && !carried) failed += 1;
      report({ way: way.id, ended: true, exit_code: code, said: said.trim().split('\n').at(-1) ?? '' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
    if (!signal?.aborted) await wait(2000);
  }
}

/** What a meeting point's host is given for the computers carried to it, from the way's `server` row: ordered steps, each a
 * file to write or a command to run, with every `each` repeated per computer, and the arguments of its program. A computer
 * is { id, salt?, server_value } (the token or public key the host needs to admit it). Two computers that hash to one
 * port are refused: give one of them a salt. */
export function renderMeetingPoint({ way, relay_host: relayHost, computers, values = {}, ports = PORT_RANGE }) {
  if (!way.server) throw new Error(`way ${way.id} has no server half`);
  const taken = new Map();
  const perComputer = computers.map(computer => {
    const own = valuesFor({ way, relay_host: relayHost, computer_id: computer.id, salt: computer.salt, ports });
    if (taken.has(own.remote_port)) throw new Error(`computers ${taken.get(own.remote_port)} and ${computer.id} share port ${own.remote_port}; give one a salt`);
    taken.set(own.remote_port, computer.id);
    return { ...values, ...own, server_value: computer.server_value };
  });
  const at = (text, field, where) => fill(text, field, `way ${way.id} ${where}`);
  const hostValues = { ...values, host: relayHost.hostname, ...(relayHost.params ?? {}) };
  // A step for the host as a whole (no `each`) is filled with the way's own params too, such as the one user every computer uses.
  const base = { ...hostValues, ...Object.fromEntries(Object.entries(way.params ?? {}).filter(([, value]) => typeof value === 'string' && !/\{(computer_id|short_id|remote_port)\}/.test(value)).map(([key, value]) => [key, at(value, hostValues, `params.${key}`)])) };
  const file = (spec, field, extra = {}) => ({ file: { path: at(spec.path, field, 'file path'), mode: spec.mode ?? '0600', text: at(spec.text, { ...field, ...extra }, `file ${spec.path}`) } });
  const one = (step, field) => (step.run ? { run: step.run.map(part => at(part, field, 'step')) } : file(step.file, field));
  const steps = way.server.steps.flatMap(step => {
    if (Array.isArray(step.each)) return perComputer.flatMap(field => step.each.map(sub => one(sub, field)));
    if (step.each) return [file(step.file, base, { services: perComputer.map(field => at(step.each, field, 'each')).join('') })];
    return [one(step, base)];
  });
  return { steps, argv: (way.server.argv ?? []).map(part => at(part, base, 'argument')), program: way.server.program ?? null };
}

/** Removes a carrier copy, whose folders may have come read-only: each folder is made writable by its owner first. */
function removeCopy(folder) {
  if (!existsSync(folder)) return;
  const open = path => { chmodSync(path, 0o700); for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) open(join(path, entry.name)); };
  open(folder);
  rmSync(folder, { recursive: true, force: true });
}

const copyInto = (source, target) => { mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { recursive: true }); };

/** Puts the files a running carrier needs in <state>/carrier (same layout as the Workshop's tools/ folder). The copy is made
 *  whole in a fresh folder beside it and then takes its name, so an earlier copy's files, which come read-only from the engine's
 *  installed Workshop copy, are never written over (that refused a reinstall with EACCES on Nov 18 2026), and a running carrier
 *  never reads a half-made copy. */
export function copyCarrier(state) {
  const tools = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const target = join(state, 'carrier');
  const fresh = `${target}.next`, before = `${target}.before`;
  for (const old of [fresh, before]) removeCopy(old);
  for (const path of [...CARRIER_FILES.tools, ...CARRIER_FILES.tool_folders]) copyInto(join(tools, path), join(fresh, 'tools', path));
  const module = dirname(fileURLToPath(import.meta.resolve(`${CARRIER_FILES.module.name}/blake3.js`)));
  for (const file of CARRIER_FILES.module.files) copyInto(join(module, file), join(fresh, 'node_modules', CARRIER_FILES.module.name, file));
  if (existsSync(target)) renameSync(target, before);
  renameSync(fresh, target);
  removeCopy(before);
  return join(target, 'tools', 'carry-a-computer-to-a-meeting-point', 'do-work', 'carry-a-computer.mjs');
}

const SERVE_ARGUMENT = 'serve';
function installValues(config, state, entry, configFile) {
  return { label: config.label, command: [process.execPath, entry, SERVE_ARGUMENT, configFile], home: homedir(), uid: process.getuid?.() ?? 0, user: userInfo().username, state, log_file: join(state, `${config.label}.log`), description: `Carries computer ${config.computer_id} to its meeting point`, ...(config.init_values ?? {}) };
}

/** Installs the carrier as the init row the way names (scope) for this computer, and loads it. */
export function installCarrier(config, state, { have = here(), rows = INIT_ROWS, run, pause, now } = {}) {
  if (!/^[a-z][a-z0-9.-]+$/.test(config.label ?? '')) throw new Error('config.label is lowercase letters, digits, dots and hyphens');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const entry = copyCarrier(state), configFile = join(state, `${config.label}.json`);
  writeFileSync(configFile, `${JSON.stringify({ ...config, state })}\n`, { mode: 0o600 });
  const row = selectInit(rows, have, config.way.install.scope);
  return { ...installInit(row, installValues(config, state, entry, configFile), { run, pause, now }), way: config.way.id, port: config.announce?.gives?.remote_port ? 'given by the meeting point at each start' : valuesFor(config).remote_port };
}

export function removeCarrier(config, state, { have = here(), rows = INIT_ROWS, run, pause, now } = {}) {
  const row = selectInit(rows, have, config.way.install.scope);
  return removeInit(row, installValues(config, state, join(state, 'carrier'), join(state, `${config.label}.json`)), { run, pause, now });
}

export async function runCLI(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (command === SERVE_ARGUMENT && rest.length === 1) {
    const config = JSON.parse(readFileSync(rest[0], 'utf8'));
    const stop = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
    await serveCarrier(config, { credential: config.credential_command ? credentialFrom(config.credential_command) : undefined, state: config.state, signal: stop.signal, report: row => process.stderr.write(`${JSON.stringify(row)}\n`) });
  } else if (command === 'install' && rest.length === 2) out(installCarrier(JSON.parse(readFileSync(rest[0], 'utf8')), resolve(rest[1])));
  else if (command === 'remove' && rest.length === 2) out(removeCarrier(JSON.parse(readFileSync(rest[0], 'utf8')), resolve(rest[1])));
  else if (command === 'render-meeting-point' && rest.length === 0) {
    const request = JSON.parse(readFileSync(0, 'utf8'));
    const way = request.ways?.find(row => row.id === request.way_id) ?? WAYS.find(row => row.id === request.way_id);
    if (!way) throw new Error(`no way row ${request.way_id}`);
    out(renderMeetingPoint({ ...request, way: { ...way, relay_host_ref: request.relay_host.id } }));
  } else throw new Error('usage: carry-a-computer.mjs serve CONFIG_FILE | install CONFIG_FILE STATE_FOLDER | remove CONFIG_FILE STATE_FOLDER | render-meeting-point (the request on standard input)');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runCLI();
