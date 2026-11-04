<<<<<<< origin/main
#!/usr/bin/env node
// tools/start-a-place/do-work/start-a-place.mjs
//
// Make and start one Trillion place on this computer, from one JSON request on standard input:
//   1. check the request: folders absolute, listen an IP and port, public_origin https and bare, router host:port,
//      report fields the engine's, default_places a valid places list (holders 1 to most_places, each place id 64
//      lowercase hex or the word for this place, no place twice in a list, answering among holders);
//   2. make the place key file in the folder when it is not there (key_bytes random bytes, base64 on one line, private),
//      never overwriting or reading one that is;
//   3. write the place config (the engine's shape, trillion-rust src/native_entry/place.rs) and ask the engine for this
//      place's id: `trillion-local place id CONFIG`;
//   4. with default_places, put this place's id where the request said the word for it, refuse unless this place is
//      among both holders and answering (a sign-up here makes the account's door here), and write the config again
//      with them;
//   5. start `trillion-local serve CONFIG` in the background, its output in the folder's log, and watch it for
//      settle_ms: a place that stops at once is refused with its log's last lines.
// Prints { result } or { error } as its last line. The engine's program is the request's trillion_local, or found on
// the PATH; it is never built here. The key's bytes are never printed, logged or put in an answer.
//
// Numbers and names are read-data/settings.json; every refusal's words are read-data/words.json.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const readData = new URL('../read-data/', import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, readData), 'utf8'));
export const settings = json('settings.json');
export const words = json('words.json');

const FIELDS = ['folder', 'accounts', 'listen', 'public_origin', 'report', 'router', 'default_places', 'access', 'sign_in', 'sign_up', 'new_accounts', 'trillion_local', 'start'];
const LISTS = ['holders', 'answering', 'voters'];

/** A refusal: what was wrong and what to send instead, in read-data/words.json's words. */
export class Refusal extends Error {}

function say(key, fill = {}) {
  return String(words[key]).replace(/\{(\w+)\}/g, (whole, name) => (name in fill ? String(fill[name]) : whole));
}
const refuse = (key, fill) => { throw new Refusal(say(key, { this_place: settings.this_place, most: settings.most_places, ...fill })); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isWhole = value => Number.isSafeInteger(value) && value >= 0;

// An absolute path with no `.` or `..` part, as the engine reads the folders and the key file (`plain_absolute`).
function plainAbsolute(field, value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')
    || value.split(/[\\/]/).some(part => part === '.' || part === '..')) refuse('not_absolute', { field });
  return value;
}

function port(text) {
  if (!/^[0-9]{1,5}$/.test(text)) return false;
  const number = Number(text);
  return number >= 1 && number <= 65535;
}

// The engine reads listen as a socket address: an IP literal and a fixed port.
function listenOf(value) {
  if (typeof value !== 'string') refuse('listen');
  const v6 = /^\[([^\]]+)\]:([^:]+)$/.exec(value);
  const v4 = /^([^:[\]]+):([^:]+)$/.exec(value);
  const ok = v6 ? isIPv6(v6[1]) && port(v6[2]) : v4 ? isIPv4(v4[1]) && port(v4[2]) : false;
  if (!ok) refuse('listen');
  return value;
}

// The scheme and host only (and an optional port): what URL calls the origin, written exactly that way.
function originOf(value) {
  if (typeof value !== 'string') refuse('origin_bare');
  let url;
  try { url = new URL(value); } catch { refuse('origin_bare'); }
  if (url.protocol !== settings.origin_scheme) refuse('origin_scheme');
  if (!url.hostname || url.username || url.password || url.origin !== value) refuse('origin_bare');
  return value;
}

function routerOf(value) {
  if (value === undefined) return undefined;
  const match = typeof value === 'string' && /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):([^:]+)$/.exec(value);
  if (!match || !port(match[2]) || (match[1].startsWith('[') && !isIPv6(match[1].slice(1, -1)))) refuse('router');
  return value;
}

function reportOf(given, origin) {
  if (given !== undefined && !isObject(given)) refuse('object_field', { field: 'report' });
  const report = { ...settings.report, reach: origin, ...(given ?? {}) };
  for (const field of Object.keys(report)) if (!settings.report_fields.includes(field)) refuse('report_field', { field });
  const storage = report.storage;
  const [kind, ...more] = isObject(storage) ? Object.keys(storage) : [];
  if (more.length || !['keep_free_bytes', 'bytes'].includes(kind) || !isWhole(storage[kind]) || (kind === 'bytes' && storage[kind] === 0)) refuse('report_storage');
  const wrong = [
    ['reach', typeof report.reach !== 'string' || !report.reach],
    ['cost_per_month_cents', !isWhole(report.cost_per_month_cents)],
    ['contained_tools', typeof report.contained_tools !== 'boolean'],
    ['takes_new_accounts', typeof report.takes_new_accounts !== 'boolean'],
    ['always_on', report.always_on !== undefined && typeof report.always_on !== 'boolean'],
    ['model_pool', report.model_pool !== undefined && !(Number.isSafeInteger(report.model_pool) && report.model_pool >= 1 && report.model_pool <= 65535)],
    ['program_folders', report.program_folders !== undefined && !(Array.isArray(report.program_folders)
      && report.program_folders.every(folder => typeof folder === 'string' && folder.startsWith('/') && !folder.split('/').some(part => part === '.' || part === '..')))],
  ].find(([, bad]) => bad);
  if (wrong) refuse('report_value', { field: wrong[0] });
  return report;
}

/**
 * default_places checked as a places list (trillion-rust src/account/places.rs `DefaultPlaces::valid`): holders one to
 * most_places, voters at most that, each a place id (64 lowercase hex) or the word for this place, no place twice in a
 * list, answering among holders. Answers the lists as given, voters [] when left out.
 */
export function checkDefaultPlaces(given) {
  if (given === undefined) return undefined;
  if (!isObject(given) || Object.keys(given).some(key => !LISTS.includes(key))) refuse('default_places_shape');
  const id = new RegExp(`^[0-9a-f]{${settings.place_id_hex_length}}$`);
  const lists = {};
  for (const list of LISTS) {
    const named = given[list] ?? (list === 'voters' ? [] : undefined);
    if (!Array.isArray(named)) refuse(named === undefined ? 'default_places_shape' : 'default_places_list', { list });
    if (named.length > settings.most_places) refuse('default_places_most', { list });
    const seen = new Set();
    for (const value of named) {
      if (typeof value !== 'string' || !(id.test(value) || value === settings.this_place)) refuse('default_places_id', { list, value: JSON.stringify(value) });
      if (seen.has(value)) refuse('default_places_repeat', { list, value });
      seen.add(value);
    }
    lists[list] = [...named];
  }
  if (lists.holders.length === 0) refuse('default_places_holders');
  for (const value of lists.answering) if (!lists.holders.includes(value)) refuse('default_places_answering', { value });
  return lists;
}

/**
 * default_places with this place's id where the word for it was, checked again (a list that named the id and the word
 * names one place twice), and refused unless this place is among both holders and answering.
 */
export function placesFor(lists, placeId) {
  if (lists === undefined) return undefined;
  const named = Object.fromEntries(LISTS.map(list => [list, lists[list].map(value => (value === settings.this_place ? placeId : value))]));
  const checked = checkDefaultPlaces(named);
  if (!checked.holders.includes(placeId) || !checked.answering.includes(placeId)) refuse('default_places_here', { place_id: placeId });
  return checked;
}

/**
 * The checked request: the place config to write (the engine's shape, with no default_places yet) and what the start
 * needs. Nothing is read from or written to disk here.
 */
export function planOf(request, newAccounts = json(settings.new_accounts)) {
  if (!isObject(request)) refuse('not_an_object');
  for (const field of Object.keys(request)) if (!FIELDS.includes(field)) refuse('unknown_field', { field });
  const folder = plainAbsolute('folder', request.folder);
  const origin = originOf(request.public_origin);
  for (const field of ['access', 'sign_in', 'sign_up', 'new_accounts']) {
    if (request[field] !== undefined && !isObject(request[field])) refuse('object_field', { field });
  }
  if (request.start !== undefined && typeof request.start !== 'boolean') refuse('start');
  if (request.trillion_local !== undefined) plainAbsolute('trillion_local', request.trillion_local);
  const config = {
    listen: listenOf(request.listen),
    accounts: plainAbsolute('accounts', request.accounts),
    place_key_file: join(folder, settings.files.key),
    public_origin: origin,
    report: reportOf(request.report, origin),
    sign_in: request.sign_in ?? settings.sign_in,
    sign_up: request.sign_up ?? settings.sign_up,
    new_accounts: request.new_accounts ?? newAccounts,
  };
  if (request.access !== undefined) config.access = request.access;
  const router = routerOf(request.router);
  if (router !== undefined) config.router = router;
  return {
    folder,
    config,
    defaults: checkDefaultPlaces(request.default_places),
    files: { config: join(folder, settings.files.config), key: config.place_key_file, log: join(folder, settings.files.log) },
    program: request.trillion_local,
    start: request.start ?? true,
  };
}

// The engine's program: the one the request names, else the first on the PATH.
export function programOf(named, env = process.env) {
  const runnable = path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  };
  if (named !== undefined) {
    if (!runnable(named)) refuse('not_a_program', { path: named });
    return named;
  }
  for (const folder of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = join(folder, settings.program);
    if (runnable(path)) return path;
  }
  return refuse('no_program');
}

function folderAt(field, path) {
  if (existsSync(path) && !statSync(path).isDirectory()) refuse('not_a_folder', { field, path });
  mkdirSync(path, { recursive: true });
}

// The place key: made once, never overwritten, never read here.
function keyAt(path) {
  if (existsSync(path) || isLink(path)) {
    if (!lstatSync(path).isFile()) refuse('key_not_a_file', { path });
    return false;
  }
  writeFileSync(path, randomBytes(settings.key_bytes).toString('base64'), { flag: 'wx', mode: settings.private_file_mode });
  return true;
}
function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function writeConfig(path, config) {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: settings.private_file_mode });
  chmodSync(path, settings.private_file_mode);
}

const lastLine = text => String(text ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';
function lastLines(path) {
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).slice(-settings.log_lines_told).join(' / '); } catch { return ''; }
}

// `trillion-local serve CONFIG`, in the background with its output in the log; watched for settle_ms.
function serve(program, files, env) {
  const log = openSync(files.log, 'a', settings.private_file_mode);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(program, ['serve', files.config], { detached: true, stdio: ['ignore', log, log], env });
    } catch (error) {
      closeSync(log);
      reject(new Refusal(say('serve_failed', { said: error.message })));
      return;
    }
    closeSync(log);
    const settled = setTimeout(() => { child.removeAllListeners(); child.unref(); resolve(child.pid); }, settings.settle_ms);
    child.once('error', error => { clearTimeout(settled); reject(new Refusal(say('serve_failed', { said: error.message }))); });
    child.once('exit', (code, signal) => {
      clearTimeout(settled);
      reject(new Refusal(say('serve_stopped', { code: code ?? signal, said: lastLines(files.log) || 'it printed nothing', log: files.log })));
    });
  });
}

/** Make and start the place the request describes; answers what was made and how to stop it. */
export async function startAPlace(request, { env = process.env } = {}) {
  const plan = planOf(request);
  const program = programOf(plan.program, env);
  folderAt('folder', plan.folder);
  folderAt('accounts', plan.config.accounts);
  const keyMade = keyAt(plan.files.key);
  writeConfig(plan.files.config, plan.config);

  const asked = spawnSync(program, ['place', 'id', plan.files.config], { encoding: 'utf8', timeout: settings.id_timeout_ms, env });
  if (asked.error) refuse('id_failed', { said: asked.error.message });
  if (asked.status !== 0) refuse('id_failed', { said: lastLine(asked.stderr) || lastLine(asked.stdout) || `exit ${asked.status}` });
  const placeId = String(asked.stdout).trim();
  if (!new RegExp(`^[0-9a-f]{${settings.place_id_hex_length}}$`).test(placeId)) refuse('id_shape');

  const defaults = placesFor(plan.defaults, placeId);
  if (defaults) writeConfig(plan.files.config, { ...plan.config, default_places: defaults });

  const result = {
    place_id: placeId,
    folder: plan.folder,
    config_file: plan.files.config,
    key_file: plan.files.key,
    key_made: keyMade,
    accounts: plan.config.accounts,
    listen: plan.config.listen,
    public_origin: plan.config.public_origin,
    ...(plan.config.router ? { router: plan.config.router } : {}),
    ...(defaults ? { default_places: defaults } : {}),
    started: false,
  };
  if (!plan.start) return result;
  const pid = await serve(program, plan.files, env);
  return { ...result, started: true, pid, log_file: plan.files.log, stop: `kill -TERM ${pid}` };
}

async function main() {
  let request;
  try {
    const text = readFileSync(0, 'utf8');
    try { request = JSON.parse(text); } catch { throw new Refusal(say('not_an_object')); }
    console.log(JSON.stringify({ result: await startAPlace(request) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Refusal ? error.message : `start-a-place stopped: ${error.message}` }));
    process.exitCode = 1;
  }
}

const ranAsCommand = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && ranAsCommand()) await main();
=======
// tools/start-a-place/do-work/start-a-place.mjs
//
// `tool:start-a-place` and its siblings (tool-rows.json): make a machine into a place that keeps people's accounts.
// The machine comes from a `machines` row in ../read-data/providers.json (rented, or one the person already runs over
// SSH); its public name from a `names` row. Then set-up-the-machine.sh prepares it over SSH, the engine release is
// installed, the place config is written, the engine starts serving, and the answer is what was read back: the place
// id the engine reports, the sign-up page's HTTP status at the public name, and the provider's monthly price.
//
// The engine is input (its file name, data folder and the argv that prints the place id); this tool names none.
// A path in a request file is read relative to that file; ssh uses the person's own SSH agent and settings unless
// the request names an identity file. Credentials arrive on private pipes only: descriptor 3 holds the machine
// provider's credential (the row's vault_key), descriptor 4 the name provider's. They never reach argv, a file, the
// environment or the answer.
//
// usage: start-a-place.mjs price REQUEST_FILE | start REQUEST_FILE | status LEASE_FILE | install LEASE_FILE REQUEST_FILE | remove LEASE_FILE
import { readFileSync, createReadStream } from 'node:fs';
import { isAbsolute, dirname, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  machineProvider, nameProvider, providerClient, rentMachine, readMachine, releaseMachine, readPrice, pointName,
  forgetName, readLease,
} from './rent-a-machine.mjs';

const SETUP = fileURLToPath(new URL('./set-up-the-machine.sh', import.meta.url));
const q = text => `'${String(text).replace(/'/g, `'\\''`)}'`;
const absolute = (path, what) => {
  if (typeof path !== 'string' || !isAbsolute(path)) throw Object.assign(new Error(`${what} must be an absolute path.`), { exit: 2 });
  return path;
};

/** Run one command on the machine as root; `input` is a string, a Buffer or a readable stream. Answers stdout. */
export function onMachine({ ssh, address }, command, input, spawnImpl = spawn) {
  const identity = ssh.identity_file ? ['-i', absolute(ssh.identity_file, 'ssh.identity_file'), '-o', 'IdentitiesOnly=yes'] : [];
  const args = ['-T', ...identity, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${absolute(ssh.known_hosts, 'ssh.known_hosts')}`, `root@${address}`, command];
  return new Promise((resolve, reject) => {
    const child = spawnImpl('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', bytes => { out += bytes; });
    child.stderr.on('data', bytes => { err += bytes; });
    child.on('error', reject);
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

/** Copy the release onto the machine as /opt/place/releases/NAME and point /opt/place/current at it. */
export async function installRelease(machine, engine, run = onMachine) {
  const name = engine.release_name, dir = `/opt/place/releases/${name}`;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name ?? '')) throw new Error('The release needs a release_name of letters, digits, dot, dash or underscore.');
  if (engine.release?.tarball) await run(machine, `install -d -m 0755 ${q(dir)} && tar -C ${q(dir)} -xzf -`, createReadStream(absolute(engine.release.tarball, 'engine.release.tarball')));
  else if (engine.release?.on_machine) await run(machine, `rm -rf ${q(dir)} && cp -a ${q(engine.release.on_machine)} ${q(dir)}`);
  else throw new Error('The release is either { tarball: a .tar.gz on this computer } or { on_machine: a folder already on the machine }.');
  await run(machine, `chmod -R a+rX ${q(dir)} && test -x ${q(`${dir}/${engine.file}`)} && ln -sfn ${q(dir)} /opt/place/current.new && mv -T /opt/place/current.new /opt/place/current`);
  return dir;
}

/** The place config with the machine's own fields set, plus values read from files in the release. */
export async function placeConfig(machine, request, price, run = onMachine) {
  const origin = `https://${request.name.host_name}`, config = structuredClone(request.place_config ?? {});
  Object.assign(config, { listen: `127.0.0.1:${request.port}`, accounts: '/var/lib/place/accounts', place_key_file: '/var/lib/place/place.key', public_origin: origin });
  config.report = { ...config.report, reach: origin, ...(price && { cost_per_month_cents: price.cents }) };
  for (const from of request.config_from_release ?? []) {
    const value = JSON.parse(await run(machine, `cat ${q(`/opt/place/current/${from.file}`)}`))[from.key];
    if (value === undefined) throw new Error(`The release's ${from.file} has no ${from.key}.`);
    let at = config;
    for (const key of from.at.slice(0, -1)) at = at[key] ??= {};
    at[from.at.at(-1)] = value;
  }
  return config;
}

async function signUpStatus(hostName, { fetchImpl, wait, tries }) {
  let status = null;
  for (let i = 1; i <= tries; i++) {
    try { status = (await fetchImpl(`https://${hostName}/sign-up`, { redirect: 'manual', signal: AbortSignal.timeout(10000) })).status; }
    catch { status = null; }
    if (status === 200) return status;
    if (i < tries) await wait(5000);
  }
  return status;
}

const asEngine = (engine, argv) => `runuser -u place -- env ${engine.data_env}=/opt/place/current/${q(engine.data_dir)} /opt/place/current/${q(engine.file)} ${argv.map(q).join(' ')}`;

/** Set the machine up, install the release, write the config, start serving, and read it all back. */
async function serve(machine, request, price, { run, ...deps }) {
  const engine = request.engine;
  await run(machine, `sh -s -- ${[request.name.host_name, request.port, engine.file, engine.data_env, engine.data_dir].map(q).join(' ')}`, readFileSync(SETUP));
  const release = await installRelease(machine, engine, run);
  const config = await placeConfig(machine, request, price, run);
  await run(machine, 'install -o place -g place -m 0600 /dev/stdin /var/lib/place/place.json', `${JSON.stringify(config, null, 1)}\n`);
  const placeId = engine.id_argv ? (await run(machine, `cd /var/lib/place && ${asEngine(engine, [...engine.id_argv, '/var/lib/place/place.json'])}`)).trim() : null;
  await run(machine, 'systemctl enable place.service >/dev/null 2>&1; systemctl restart place.service && sleep 3 && systemctl is-active place.service');
  return { release, placeId, signUp: await signUpStatus(request.name.host_name, deps) };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function startAPlace(request, { machineToken, nameToken, fetchImpl = fetch, wait = pause, tries = 48, run = onMachine } = {}) {
  const machines = machineProvider(request.machine.provider), names = request.name.provider ? nameProvider(request.name.provider) : null;
  const machineRequest = machines.base ? providerClient(machines, machineToken, { fetchImpl }) : null;
  const file = absolute(request.lease_file, 'lease_file'), m = request.machine;
  const publicKey = m.public_key ?? (m.public_key_file && readFileSync(absolute(m.public_key_file, 'machine.public_key_file'), 'utf8'));
  const lease = await rentMachine({ request: machineRequest, file, provider: machines, name: m.name, placement: m.placement, lifetime: m.lifetime, expiresAt: m.expires_at, publicKey });
  const price = await readPrice({ request: machineRequest, provider: machines, placement: m.placement });
  if (names) await pointName({ request: providerClient(names, nameToken, { fetchImpl }), file, provider: names, zone: request.name.zone, hostName: request.name.host_name });
  const machine = { ssh: request.ssh, address: lease.address };
  const arch = (await untilSsh(machine, { wait, run })).trim();
  const served = await serve(machine, request, price, { run, fetchImpl, wait, tries });
  return { lease: { provider: lease.provider, name: lease.name, serverId: lease.serverId, address: lease.address, state: lease.state }, host_name: request.name.host_name, arch, price, place_id: served.placeId, release: served.release, sign_up_status: served.signUp };
}

/** A new release on a running place: install, point current at it, restart, read back. */
export async function installOnPlace(leaseFile, request, { fetchImpl = fetch, wait = pause, tries = 24, run = onMachine } = {}) {
  const lease = readLease(absolute(leaseFile, 'LEASE_FILE')), machine = { ssh: request.ssh, address: lease.address };
  const release = await installRelease(machine, request.engine, run);
  await run(machine, 'systemctl restart place.service && sleep 3 && systemctl is-active place.service');
  return { release, sign_up_status: await signUpStatus(lease.hostName ?? request.name.host_name, { fetchImpl, wait, tries }) };
}

/** The monthly price the request's machine would cost, read before anything is rented. */
export async function priceOfAPlace(request, { machineToken, fetchImpl = fetch } = {}) {
  const row = machineProvider(request.machine.provider);
  return { provider: row.id, placement: { ...row.placement, ...request.machine.placement }, price: await readPrice({ request: row.base ? providerClient(row, machineToken, { fetchImpl }) : null, provider: row, placement: request.machine.placement }) };
}

export async function placeStatus(leaseFile, { machineToken, fetchImpl = fetch } = {}) {
  const file = absolute(leaseFile, 'LEASE_FILE'), lease = readLease(file), row = machineProvider(lease.provider);
  const machine = await readMachine({ request: row.base ? providerClient(row, machineToken, { fetchImpl }) : null, file, provider: row });
  const signUp = lease.hostName ? await signUpStatus(lease.hostName, { fetchImpl, wait: pause, tries: 1 }) : null;
  return { name: lease.name, provider: lease.provider, lease_state: lease.state, machine, host_name: lease.hostName ?? null, sign_up_status: signUp };
}

/** Forget the public name, then give the machine back (an adopted machine is only forgotten). */
export async function removeAPlace(leaseFile, { machineToken, nameToken, fetchImpl = fetch } = {}) {
  const file = absolute(leaseFile, 'LEASE_FILE'), lease = readLease(file), row = machineProvider(lease.provider);
  if (lease.recordId) await forgetName({ request: providerClient(nameProvider(lease.names), nameToken, { fetchImpl }), file });
  const done = await releaseMachine({ request: row.base ? providerClient(row, machineToken, { fetchImpl }) : null, file, provider: row });
  return { name: done.name, provider: done.provider, state: done.state, adopted: Boolean(done.adopted) };
}

/** A request read from its file, each of its paths resolved against the file's own folder. */
export function readRequest(file) {
  const request = JSON.parse(readFileSync(absolute(file, 'REQUEST_FILE'), 'utf8')), here = dirname(file);
  const place = (holder, key) => { if (holder && typeof holder[key] === 'string') holder[key] = resolvePath(here, holder[key]); };
  place(request, 'lease_file');
  place(request.machine, 'public_key_file');
  place(request.ssh, 'known_hosts');
  place(request.ssh, 'identity_file');
  place(request.engine?.release, 'tarball');
  return request;
}

async function pipe(fd) {
  let text = '';
  try { for await (const bytes of createReadStream(null, { fd, autoClose: false })) { text += bytes; if (text.length > 65536) throw new Error(`Descriptor ${fd} exceeds its private input bound.`); } }
  catch (error) { if (error.code === 'EBADF') return ''; throw error; }
  return text.trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, first, second] = process.argv.slice(2);
  const usage = 'usage: start-a-place.mjs price REQUEST_FILE | start REQUEST_FILE | status LEASE_FILE | install LEASE_FILE REQUEST_FILE | remove LEASE_FILE (machine credential on fd 3, name credential on fd 4)';
  const json = path => readRequest(resolvePath(path));
  try {
    if (!first || !['price', 'start', 'status', 'install', 'remove'].includes(operation) || (operation === 'install') !== Boolean(second)) throw Object.assign(new Error(usage), { exit: 2 });
    const asked = ['price', 'start'].includes(operation), lease = asked ? null : readLease(resolvePath(first));
    const needsName = operation === 'start' ? Boolean(json(first).name?.provider) : operation === 'remove' && Boolean(lease.recordId);
    const needsMachine = operation !== 'install' && Boolean(machineProvider(asked ? json(first).machine.provider : lease.provider).base);
    const tokens = { machineToken: needsMachine ? await pipe(3) : '', nameToken: needsName ? await pipe(4) : '' };
    const answer = operation === 'price' ? await priceOfAPlace(json(first), tokens)
      : operation === 'start' ? await startAPlace(json(first), tokens)
      : operation === 'status' ? await placeStatus(resolvePath(first), tokens)
        : operation === 'install' ? await installOnPlace(resolvePath(first), json(second))
          : await removeAPlace(resolvePath(first), tokens);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
>>>>>>> 8ccc2b84
