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

const refused = message => Object.assign(new Error(message), { exit: 2 });

/** Where the place adopts new engine releases from (engine job J1): feed urls, the keys a release must be signed by, and its releases. */
export function releaseFeed(feed) {
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) throw refused('release_feed must be { urls, public_keys, releases }.');
  const extra = Object.keys(feed).filter(key => !['urls', 'public_keys', 'releases'].includes(key));
  if (extra.length) throw refused(`release_feed takes urls, public_keys and releases only, not ${extra.join(', ')}.`);
  if (!Array.isArray(feed.urls) || !feed.urls.length || !feed.urls.every(url => typeof url === 'string' && /^https:\/\/[^/\s]+\/\S*$/.test(url))) throw refused('release_feed.urls must be a list of one or more https addresses of feed.json, like https://releases.example.com/engine-releases/feed.json.');
  if (!Array.isArray(feed.public_keys) || !feed.public_keys.length || !feed.public_keys.every(key => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key))) throw refused('release_feed.public_keys must be a list of one or more Ed25519 public keys as 64 lowercase hex (what the builder\'s install printed).');
  if (feed.releases === undefined || feed.releases === null) throw refused('release_feed.releases must be given: it is the engine\'s releases setting for the adopted releases.');
  return structuredClone(feed);
}

/** The places a new account's rows name by default, as the request gives them. */
export function defaultPlaces(places) {
  if (!places || typeof places !== 'object' || Array.isArray(places)) throw refused('default_places must be { holders: [place ids], answering: [place ids], voters?: [place ids] }.');
  for (const list of ['holders', 'answering', 'voters']) {
    if (places[list] !== undefined && !(Array.isArray(places[list]) && places[list].every(id => typeof id === 'string' && id))) throw refused(`default_places.${list} must be a list of place ids.`);
  }
  if (!places.holders?.length) throw refused('default_places.holders must name at least one place.');
  return structuredClone(places);
}

/** The place config with the machine's own fields set, the request's release feed and default places, plus values read
 * from files in the release. The machine is reached at its own name (`report.reach`); people reach its accounts at
 * `public_origin` when the request names one (a forwarder in front of several machines), else at that same name. */
export async function placeConfig(machine, request, price, run = onMachine) {
  const reach = `https://${request.name.host_name}`, config = structuredClone(request.place_config ?? {});
  Object.assign(config, { listen: `127.0.0.1:${request.port}`, accounts: '/var/lib/place/accounts', place_key_file: '/var/lib/place/place.key', public_origin: request.public_origin ?? reach });
  config.report = { ...config.report, reach, ...(price && { cost_per_month_cents: price.cents }) };
  if (request.release_feed !== undefined) config.release_feed = releaseFeed(request.release_feed);
  if (request.default_places !== undefined) config.default_places = defaultPlaces(request.default_places);
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
  if (request.release_feed !== undefined) releaseFeed(request.release_feed);
  if (request.default_places !== undefined) defaultPlaces(request.default_places);
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
