// tools/carry-a-computer-to-a-meeting-point/do-work/carry-a-computer.mjs
//
// Carries a computer to a meeting point: a program the computer starts that dials out to a public host, so a computer
// behind a router is reached with no inbound port. Which program, with which files and arguments, is a way row
// (read-data/ways.json); this file is the one runner for every row. It names no program, no operating system and no host:
// each is a row, and a new way is a new row. The meeting-point side port of a computer is a stable hash of its id.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
export function valuesFor({ way, relay_host: relayHost, computer_id: computerId, salt = '', local_port: localPort, ports = PORT_RANGE }) {
  const base = { computer_id: computerId, short_id: hex(computerId).slice(0, 16), remote_port: portFor(computerId, ports, salt), host: relayHost.hostname, ...(relayHost.params ?? {}) };
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

/** The credential the client dials with, read from the descriptor 3 of a vault command, never from its output. */
export function credentialFrom(command) {
  return () => new Promise((done, fail) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdio[3].on('data', chunk => chunks.push(chunk));
    child.once('error', fail);
    child.once('exit', code => (code === 0 && chunks.length ? done(Buffer.concat(chunks).toString('utf8').replace(/\n$/, '')) : fail(new Error('the credential command gave no value'))));
  });
}

/** Keeps one computer carried: starts the way's client, and starts it again two seconds after it ends, until aborted. */
export async function serveCarrier(config, { credential, state, have = here(), spawnImpl = spawn, fetchBytes, run, wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms)), signal, report = () => {} }) {
  const { way } = config;
  const values = valuesFor(config);
  const exe = await ensureProgram(way.client.program, { have, state, fetchBytes, run });
  while (!signal?.aborted) {
    const secret = await credential();
    mkdirSync(join(state, 'run'), { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(state, 'run', 'carrier-'));
    try {
      const { files, argv } = renderClient(way, values, { secret, dir });
      for (const file of files) writeFileSync(join(dir, file.name), file.text, { mode: file.mode });
      const child = spawnImpl(exe, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
      // While the carrier runs, the meeting point is told whose computer is at this port (`announce`: a command the person's own
      // sign-in runs, with {remote_port} filled), at once and every `every_seconds`, so the announcement lasts only while carried.
      const announce = () => { if (config.announce) spawnImpl(config.announce.argv[0], config.announce.argv.slice(1).map(part => fill(part, values, 'announce')), { stdio: 'ignore' }).on?.('error', () => {}); };
      const announcing = config.announce ? setInterval(announce, config.announce.every_seconds * 1000) : null;
      announce();
      child.once('exit', () => clearInterval(announcing));
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      let said = '';
      child.stderr.on('data', bytes => { if (said.length < 4096) said += bytes.toString().slice(0, 4096 - said.length); });
      const code = await new Promise(resolveExit => { child.once('error', () => resolveExit(null)); child.once('exit', resolveExit); });
      signal?.removeEventListener('abort', abort);
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
  const base = { ...values, host: relayHost.hostname, ...(relayHost.params ?? {}) };
  const at = (text, field, where) => fill(text, field, `way ${way.id} ${where}`);
  const file = (spec, field, extra = {}) => ({ file: { path: at(spec.path, field, 'file path'), mode: spec.mode ?? '0600', text: at(spec.text, { ...field, ...extra }, `file ${spec.path}`) } });
  const one = (step, field) => (step.run ? { run: step.run.map(part => at(part, field, 'step')) } : file(step.file, field));
  const steps = way.server.steps.flatMap(step => {
    if (Array.isArray(step.each)) return perComputer.flatMap(field => step.each.map(sub => one(sub, field)));
    if (step.each) return [file(step.file, base, { services: perComputer.map(field => at(step.each, field, 'each')).join('') })];
    return [one(step, base)];
  });
  return { steps, argv: (way.server.argv ?? []).map(part => at(part, base, 'argument')), program: way.server.program ?? null };
}

const copyInto = (source, target) => { mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { recursive: true }); };

/** Puts the files a running carrier needs in <state>/carrier (same layout as the Workshop's tools/ folder). */
export function copyCarrier(state) {
  const tools = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const target = join(state, 'carrier');
  for (const path of [...CARRIER_FILES.tools, ...CARRIER_FILES.tool_folders]) copyInto(join(tools, path), join(target, 'tools', path));
  const module = dirname(fileURLToPath(import.meta.resolve(`${CARRIER_FILES.module.name}/blake3.js`)));
  for (const file of CARRIER_FILES.module.files) copyInto(join(module, file), join(target, 'node_modules', CARRIER_FILES.module.name, file));
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
  return { ...installInit(row, installValues(config, state, entry, configFile), { run, pause, now }), way: config.way.id, port: valuesFor(config).remote_port };
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
    await serveCarrier(config, { credential: credentialFrom(config.credential_command), state: config.state, signal: stop.signal, report: row => process.stderr.write(`${JSON.stringify(row)}\n`) });
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
