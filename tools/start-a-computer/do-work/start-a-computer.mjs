// tools/start-a-computer/do-work/start-a-computer.mjs
//
// `tool:start-a-computer` and its siblings (tool-rows.json): make a machine into a computer that keeps people's accounts.
// The machine comes from a `machines` row in ../read-data/providers.json (rented, or one the person already runs over
// SSH); its public name from a `names` row. Then set-up-the-machine.sh prepares it over SSH, the engine release is
// installed, the computer config is written, the engine starts serving, and the answer is what was read back: the computer
// id the engine reports, the sign-up page's HTTP status at the public name, and the provider's monthly price.
//
// The engine is input (its file name, data folder and the argv that prints the computer id); this tool names none.
// A path in a request file is read relative to that file; ssh uses the person's own SSH agent and settings unless
// the request names an identity file. Credentials arrive on private pipes only: descriptor 3 holds the machine
// provider's credential (the row's vault_key), descriptor 4 the name provider's. They never reach argv, a file, the
// environment or the answer.
//
// The caller names its product data: the trillion-apps manifest computer/product-data.json (`product_data`), whose settings file
// and static files are checked by content identity before anything is written. The same settings snapshot supplies the starting
// account rows and the remote settings file, and its page look names the static folder beside that file. The caller also supplies
// an optional signed release feed. Updates retain a backup and can roll back.
//
// usage: start-a-computer.mjs price REQUEST_FILE | rent REQUEST_FILE | start REQUEST_FILE | status LEASE_FILE | install LEASE_FILE REQUEST_FILE | update LEASE_FILE REQUEST_FILE | rollback LEASE_FILE REQUEST_FILE BACKUP | remove LEASE_FILE
import { differences, renderLayout } from './render-layout.mjs';
import { readFileSync, createReadStream } from 'node:fs';
import { isAbsolute, dirname, basename, resolve as resolvePath, posix } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import {
  machineProvider, nameProvider, providerClient, rentMachine, readMachine, releaseMachine, readPrice, pointName,
  forgetName, readLease,
} from './rent-a-machine.mjs';

const SETUP = fileURLToPath(new URL('./set-up-the-machine.sh', import.meta.url));
const CAP_JOURNAL = fileURLToPath(new URL('./cap-the-journal.sh', import.meta.url));
const UPDATE = fileURLToPath(new URL('./update-a-computer.sh', import.meta.url));
const SETTINGS = JSON.parse(readFileSync(new URL('../read-data/settings.json', import.meta.url), 'utf8'));
// Each name's Caddy site block: the wrapper with every route block the settings name, in order, each its own file.
export const SITE_BLOCK = readFileSync(new URL('../read-data/caddy-site-block.caddy', import.meta.url), 'utf8').trimEnd()
  .replace('{ROUTES}', () => SETTINGS.caddy_routes.map(name => readFileSync(new URL(`../read-data/caddy-routes/${name}.caddy`, import.meta.url), 'utf8').trimEnd()).join('\n'));
/** The launch setting that names the product settings file, and where that file is on the machine. */
export const productSettings = { launch_setting: SETTINGS.product_settings.launch_setting, file: SETTINGS.product_settings.file };
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

/** Compare a computer's host layout row with what it runs now (`request.host_layout`): every file the row renders, every
 * drop-in the row does not declare, and every unmanaged user and folder the row keeps. Answers the differences, [] when the
 * computer matches. An absent file is a difference; a failed connection is an error, not an absence. */
export async function hostLayoutDifferences(machine, layout, run = onMachine) {
  const { rendered, live, found } = await hostLayoutState(machine, layout, run);
  return [...differences(rendered, live), ...found];
}

/** What a layout renders, what the computer has at those paths, and what the computer keeps that the layout does not name. */
export async function hostLayoutState(machine, layout, run = onMachine) {
  const units = layout.units;
  const rendered = renderLayout(layout, SITE_BLOCK);
  const live = {};
  for (const { path } of rendered) live[path] = await readIfPresent(machine, run, path);
  const found = [];
  for (const unit of units) {
    const dir = `/etc/systemd/system/${unit.unit}.d`;
    const names = (await run(machine, `if [ -d ${q(dir)} ]; then ls -1 ${q(dir)}; fi`)).split('\n').filter(Boolean);
    found.push(...names.filter(name => !(unit.drop_ins ?? []).includes(name.replace(/\.conf$/, ''))).map(name => ({ path: `${dir}/${name}`, reason: 'not in the layout' })));
  }
  for (const item of layout.unmanaged ?? []) {
    const gone = { path: item.user ? `user ${item.user}` : item.path, reason: 'unmanaged, kept, and missing on the computer' };
    const test = item.user ? `getent passwd ${q(item.user)} >/dev/null` : `test -e ${q(item.path)}`;
    const present = await run(machine, `${test} || exit 3`).then(() => true, error => { if (error.code === 3) return false; throw error; });
    if (!present) found.push(gone);
  }
  return { rendered, live, found };
}

/** One file's text on the computer, or undefined when it is absent. */
async function readIfPresent(machine, run, path) {
  return run(machine, `if [ -f ${q(path)} ]; then cat ${q(path)}; else exit 3; fi`).catch(error => { if (error.code === 3) return undefined; throw error; });
}

/** Apply a computer's layout row: set it up, write only the files that differ from what the row renders, and restart what
 * those files change. A computer that already matches gets nothing written, no set-up run and nothing restarted. A file
 * that is replaced keeps its previous bytes beside it as `NAME.bak-STAMP`. */
export async function applyHostLayout(machine, layout, run = onMachine) {
  const { rendered, live } = await hostLayoutState(machine, layout, run);
  const writes = rendered.filter(({ path, text }) => live[path] !== text);
  if (!writes.length) return { written: [], restarted: [] };
  await run(machine, `sh -s -- ${q(JSON.stringify(layout))}`, readFileSync(SETUP));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const { path, text } of writes) {
    if (live[path] !== undefined) await run(machine, `cp -p ${q(path)} ${q(`${path}.bak-${stamp}`)}`);
    if (path === CADDYFILE) {
      await run(machine, `install -m 0644 -o root -g root /dev/stdin ${q(`${path}.new`)}`, text);
      await run(machine, `caddy validate --config ${q(`${path}.new`)} --adapter caddyfile >/dev/null && mv ${q(`${path}.new`)} ${q(path)}`);
    } else {
      await run(machine, `install -d -m 0755 ${q(dirname(path))} && install -m 0644 -o root -g root /dev/stdin ${q(path)}`, text);
    }
  }
  const units = [...new Set(writes.map(({ path }) => path.match(/\/([^/]+\.service)(?:\.d\/[^/]+)?$/)?.[1]).filter(Boolean))];
  if (units.length) await run(machine, 'systemctl daemon-reload');
  for (const unit of units) {
    await run(machine, `if systemctl is-active --quiet ${q(unit)}; then systemctl restart ${q(unit)}; else systemctl enable ${q(unit)} >/dev/null 2>&1; fi`);
  }
  if (writes.some(({ path }) => path === CADDYFILE)) await run(machine, 'systemctl reload caddy');
  return { written: writes.map(({ path }) => path), restarted: units };
}

const CADDYFILE = '/etc/caddy/Caddyfile';

/** Copy the release onto the machine as /opt/place/releases/NAME (under `root`, empty on a machine), pointing nothing
 * at it. */
export async function copyRelease(machine, engine, run = onMachine, root = '') {
  const name = engine.release_name, dir = `${engine.releases ?? SETTINGS.layout.releases}/${name}`, at = q(`${root}${dir}`);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name ?? '')) throw new Error('The release needs a release_name of letters, digits, dot, dash or underscore.');
  if (engine.release?.tarball) await run(machine, `install -d -m 0755 ${at} && tar -C ${at} -xzf -`, createReadStream(absolute(engine.release.tarball, 'engine.release.tarball')));
  else if (engine.release?.on_machine) await run(machine, `rm -rf ${at} && cp -a ${q(`${root}${engine.release.on_machine}`)} ${at}`);
  else throw new Error('The release is either { tarball: a .tar.gz on this computer } or { on_machine: a folder already on the machine }.');
  await run(machine, `chmod -R a+rX ${at} && test -x ${q(`${root}${dir}/${engine.file}`)}`);
  return dir;
}

/** Copy the release onto the machine as /opt/place/releases/NAME and point /opt/place/current at it. */
export async function installRelease(machine, engine, run = onMachine) {
  const dir = await copyRelease(machine, engine, run);
  await run(machine, `ln -sfn ${q(dir)} /opt/place/current.new && mv -T /opt/place/current.new /opt/place/current`);
  return dir;
}

const refused = message => Object.assign(new Error(message), { exit: 2 });

/** The folder beside a computer's product settings file that holds the static files its sign-in pages name (the page
 * look's `static_root`, trillion-rust src/account/sign_in/shell.rs). */
export const staticFolderOf = settingsFile => `${dirname(settingsFile)}/static`;

/** The product data the request's `product_data` manifest names (computer/product-data.json,
 * `{product_settings: {file, identity}, static: [{name, file, identity}]}`, each `file` read beside the manifest), read once
 * and checked: every file's bytes must hash to its `identity` (the BLAKE3 content identity, tools/content-identity) or nothing
 * is written. A caller takes this snapshot before anything else runs, so the files it later changes are not the ones written. */
export function readProductData(request) {
  const manifestFile = absolute(request.product_data, 'product_data');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const folder = dirname(manifestFile);
  const verified = entry => {
    if (typeof entry?.file !== 'string' || typeof entry.identity !== 'string') throw refused('product_data rows name a file and its identity.');
    const bytes = readFileSync(resolvePath(folder, entry.file));
    if (makeHashCodeHexFromBytes(bytes) !== entry.identity) throw refused(`${entry.file} is not the product data its manifest names (identity ${entry.identity}).`);
    return bytes;
  };
  const source = verified(manifest.product_settings);
  const statics = (manifest.static ?? []).map(entry => {
    if (typeof entry?.name !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(entry.name) || entry.name.split('/').some(part => part === '' || part === '.' || part === '..')) throw refused('product_data static names are relative paths of letters, digits, dot, dash, underscore and slash.');
    return { name: entry.name, bytes: verified(entry) };
  });
  return { source, statics };
}

/** The bytes a computer's product settings file gets from a snapshot (`readProductData`): the settings the engine reads, checked
 * for their sections and bounded in size. The page look names the static folder beside `settingsFile` on this computer. */
export function productSettingsOf(snapshot, settingsFile = productSettings.file) {
  if (snapshot.source.length > SETTINGS.product_settings.most_bytes) throw refused('product_settings exceeds the engine settings file byte limit.');
  const data = JSON.parse(snapshot.source);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(data) || !object(data.new_accounts)) throw refused('product_settings.new_accounts must supply the starting account rows.');
  for (const key of ['sign_in', 'sign_in_ways', 'sign_in_words', 'copies_rules']) {
    if (!object(data.new_accounts[key])) throw refused(`product_settings.new_accounts.${key} must be an object.`);
  }
  copiesPolicy(data.new_accounts.copies);
  if (object(data.page_look)) data.page_look.static_root = staticFolderOf(settingsFile);
  return { bytes: Buffer.from(`${JSON.stringify(data, null, 2)}\n`), data, statics: snapshot.statics };
}

/** Install the static files the sign-in pages name into `folder` on the machine, owned by the service's user (mode 0644), each as
 * the bytes its product data identity names. `root` is empty on a machine; tests use made-up folders. */
export async function installStatics(machine, folder, statics, owner, run = onMachine, root = '') {
  for (const { name, bytes } of statics) {
    const at = `${root}${folder}/${name}`;
    await run(machine, `install -d -m 0755 ${q(dirname(at))} && install -o ${owner} -g ${owner} -m 0644 /dev/stdin ${q(at)}`, bytes);
  }
}

/** Where the computer adopts new engine releases from (engine job J1): feed urls, the keys a release must be signed by, and its releases. */
export function releaseFeed(feed) {
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) throw refused('release_feed must be { urls, public_keys, releases }.');
  const extra = Object.keys(feed).filter(key => !['urls', 'public_keys', 'releases'].includes(key));
  if (extra.length) throw refused(`release_feed takes urls, public_keys and releases only, not ${extra.join(', ')}.`);
  if (!Array.isArray(feed.urls) || !feed.urls.length || !feed.urls.every(url => typeof url === 'string' && /^https:\/\/[^/\s]+\/\S*$/.test(url))) throw refused('release_feed.urls must be a list of one or more https addresses of feed.json, like https://releases.example.com/engine-releases/feed.json.');
  if (!Array.isArray(feed.public_keys) || !feed.public_keys.length || !feed.public_keys.every(key => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key))) throw refused('release_feed.public_keys must be a list of one or more Ed25519 public keys as 64 lowercase hex (what the builder\'s install printed).');
  if (feed.releases === undefined || feed.releases === null) throw refused('release_feed.releases must be given: it is the engine\'s releases setting for the adopted releases.');
  const folder = typeof feed.releases === 'string' && feed.releases.startsWith('/') ? feed.releases : null;
  if (folder && (!/^(\/[A-Za-z0-9._-]+)+\/?$/.test(folder) || folder.split('/').some(part => part === '.' || part === '..'))) throw refused('release_feed.releases, as a folder, must be an absolute path of letters, digits, dot, dash or underscore, with no . or .. part.');
  return structuredClone(feed);
}

/** No signed release feed is selected unless the caller supplies one. */
export const feedOf = request => (request.release_feed == null ? null : releaseFeed(request.release_feed));

/** A copies row (trillion-rust src/account/computers/copy_rule.rs `valid`): at least one copy keeper, and no more
 * computers that may answer than keep a copy. */
export function copiesPolicy(copies) {
  const names = ['least_copy_keepers', 'least_voters', 'least_may_answer', 'least_always_on'];
  if (!copies || typeof copies !== 'object' || Object.keys(copies).some(key => !names.includes(key)) || !names.every(key => Number.isSafeInteger(copies[key]) && copies[key] >= 0 && copies[key] <= SETTINGS.copies.most_admitted_computers)) throw refused(`copies must be { ${names.join(', ')} }, each a whole number from 0 to ${SETTINGS.copies.most_admitted_computers}.`);
  if (copies.least_copy_keepers < 1 || copies.least_may_answer > copies.least_copy_keepers) throw refused('copies needs least_copy_keepers of at least 1, and least_may_answer no more than least_copy_keepers.');
  if (copies.least_always_on > copies.least_may_answer) throw refused('copies least_always_on must be no more than least_may_answer.');
  return { ...copies };
}

/** Bound the caller's desired counts to the number of computers available at account creation. */
export function copiesFor(config, most) {
  copiesPolicy(most);
  const computers = Math.max(1, new Set(config.default_places?.holders ?? []).size);
  return copiesPolicy(Object.fromEntries(Object.entries(most).map(([key, value]) => [key, Math.min(value, computers)])));
}

/** Preserve configured rows and fill missing ones from the same caller settings written to the computer. */
export function startingRows(config, request, product = productSettingsOf(readProductData(request))) {
  const rows = { ...structuredClone(product.data.new_accounts), ...structuredClone(config.new_accounts ?? {}) };
  rows.copies = request.copies === undefined ? copiesFor(config, product.data.new_accounts.copies) : copiesPolicy(request.copies);
  return rows;
}

/** The computers a new account's rows name by default, as the request gives them. */
export function defaultComputers(computers) {
  if (!computers || typeof computers !== 'object' || Array.isArray(computers)) throw refused('default_places must be { holders: [computer ids], answering: [computer ids], voters?: [computer ids] }.');
  for (const list of ['holders', 'answering', 'voters']) {
    if (computers[list] !== undefined && !(Array.isArray(computers[list]) && computers[list].every(id => typeof id === 'string' && id))) throw refused(`default_places.${list} must be a list of computer ids.`);
  }
  if (!computers.holders?.length) throw refused('default_places.holders must name at least one computer.');
  return structuredClone(computers);
}

/** The computer config with the machine's own fields set, the request's release feed and default computers, plus values read
 * from files in the release. The machine is reached at its own name (`report.reach`); people reach its accounts at
 * `public_origin` when the request names one (a forwarder in front of several machines), else at that same name. */
export async function computerConfig(machine, request, price, run = onMachine, product = productSettingsOf(readProductData(request))) {
  const reach = `https://${request.name.host_name}`, config = structuredClone(request.place_config ?? {});
  Object.assign(config, { listen: `127.0.0.1:${request.port}`, accounts: '/var/lib/place/accounts', place_key_file: '/var/lib/place/place.key', public_origin: request.public_origin ?? reach });
  config.report = { ...config.report, reach, ...(price && { cost_per_month_cents: price.cents }) };
  const feed = feedOf(request);
  if (feed) config.release_feed = feed;
  if (request.default_places !== undefined) config.default_places = defaultComputers(request.default_places);
  for (const from of request.config_from_release ?? []) {
    const value = JSON.parse(await run(machine, `cat ${q(`/opt/place/current/${from.file}`)}`))[from.key];
    if (value === undefined) throw new Error(`The release's ${from.file} has no ${from.key}.`);
    let at = config;
    for (const key of from.at.slice(0, -1)) at = at[key] ??= {};
    at[from.at.at(-1)] = value;
  }
  // A copies row this computer's accounts can meet, whatever the release's or the request's place_config carried.
  config.new_accounts = startingRows(config, request, product);
  return config;
}

/** The after-switch health check a place declares (`health` in its config; the default is SETTINGS.health): the path and the
 * status it must answer, asked `public`ly (through its host name) or on the `machine` itself (the listen address, Host set to the name). */
export function healthOf(config, request = {}) {
  const given = request.health ?? config.health ?? {};
  const health = { ...SETTINGS.health, ...given };
  if (!/^\/[A-Za-z0-9._~\/-]*$/.test(health.path) || !Number.isInteger(health.status) || health.status < 100 || health.status > 599 || !['public', 'machine'].includes(health.where)) {
    throw refused('health takes a path that starts with /, a status from 100 to 599, and where: public or machine.');
  }
  return health;
}

/** Ask the place its health check once per try: its status, or null when nothing answers. */
async function healthStatus(machine, config, host, health, { fetchImpl, wait, tries, run }) {
  let status = null;
  for (let i = 1; i <= tries; i++) {
    try {
      status = health.where === 'machine'
        ? Number((await run(machine, `curl -s -o /dev/null -w '%{http_code}' -H ${q(`Host: ${host}`)} ${q(`http://${config.listen}${health.path}`)} || true`)).trim()) || null
        : (await fetchImpl(`https://${host}${health.path}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) })).status;
    } catch { status = null; }
    if (status === health.status) return status;
    if (i < tries) await wait(5000);
  }
  return status;
}

const asEngine = (engine, argv) => `runuser -u place -- env ${productSettings.launch_setting}=${q(productSettings.file)} ${engine.data_env}=/opt/place/current/${q(engine.data_dir)} /opt/place/current/${q(engine.file)} ${argv.map(q).join(' ')}`;

/** The folder the engine adopts feed releases into, when the request's release_feed names one by absolute path: the
 * `place` service runs with ProtectSystem=strict, so set-up makes this folder writable for it. */
export const adoptFolder = request => {
  const releases = request.release_feed?.releases;
  return typeof releases === 'string' && releases.startsWith('/') ? releases.replace(/(.)\/$/, '$1') : null;
};

/** Cap the system journal at the one size every place keeps (settings `journal.system_max_use`), on a new machine or an update. */
export async function capTheJournal(machine, run = onMachine, root = '') {
  await run(machine, `env ROOT=${q(root)} JOURNAL_MAX=${q(SETTINGS.journal.system_max_use)} sh -s`, readFileSync(CAP_JOURNAL));
}

/** Set the machine up, install the release, write the config, start serving, and read it all back. */
async function serve(machine, request, price, { run, product, ...deps }) {
  const engine = request.engine;
  if (!request.host_layout) throw refused('A start needs host_layout: the computer\'s layout row (units, caddy, unmanaged).');
  await applyHostLayout(machine, request.host_layout, run);
  await capTheJournal(machine, run);
  const release = await installRelease(machine, engine, run);
  const config = await computerConfig(machine, request, price, run, product);
  await installStatics(machine, staticFolderOf(productSettings.file), product.statics, 'place', run);
  await run(machine, `install -o place -g place -m 0600 /dev/stdin ${q(productSettings.file)}`, product.bytes);
  await run(machine, 'install -o place -g place -m 0600 /dev/stdin /var/lib/place/place.json', `${JSON.stringify(config, null, 1)}\n`);
  const computerId = engine.id_argv ? (await run(machine, `cd /var/lib/place && ${asEngine(engine, [...engine.id_argv, '/var/lib/place/place.json'])}`)).trim() : null;
  await run(machine, 'systemctl enable place.service >/dev/null 2>&1; systemctl restart place.service && sleep 3 && systemctl is-active place.service');
  const host = request.name.host_name, health = healthOf(config, request);
  return { release, computerId, signUp: await healthStatus(machine, config, host, health, { ...deps, run }) };
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Rent (or adopt) the request's machine, point its name and wait for SSH: the machine any other tool may then set up. */
export async function rentAMachine(request, { machineToken, nameToken, fetchImpl = fetch, wait = pause, run = onMachine } = {}) {
  const machines = machineProvider(request.machine.provider), names = request.name.provider ? nameProvider(request.name.provider) : null;
  const machineRequest = machines.base ? providerClient(machines, machineToken, { fetchImpl }) : null;
  const file = absolute(request.lease_file, 'lease_file'), m = request.machine;
  const publicKey = m.public_key ?? (m.public_key_file && readFileSync(absolute(m.public_key_file, 'machine.public_key_file'), 'utf8'));
  const lease = await rentMachine({ request: machineRequest, file, provider: machines, name: m.name, placement: m.placement, lifetime: m.lifetime, expiresAt: m.expires_at, publicKey });
  const price = await readPrice({ request: machineRequest, provider: machines, placement: m.placement });
  if (names) await pointName({ request: providerClient(names, nameToken, { fetchImpl }), file, provider: names, zone: request.name.zone, hostName: request.name.host_name });
  const machine = { ssh: request.ssh, address: lease.address };
  const arch = (await untilSsh(machine, { wait, run })).trim();
  return { machine, price, arch, lease: { provider: lease.provider, name: lease.name, serverId: lease.serverId, address: lease.address, state: lease.state }, host_name: request.name.host_name };
}

export async function startAComputer(request, { machineToken, nameToken, fetchImpl = fetch, wait = pause, tries = 48, run = onMachine } = {}) {
  const product = productSettingsOf(readProductData(request));
  if (request.copies !== undefined) copiesPolicy(request.copies);
  feedOf(request);
  if (request.default_places !== undefined) defaultComputers(request.default_places);
  const { machine, price, arch, lease, host_name } = await rentAMachine(request, { machineToken, nameToken, fetchImpl, wait, run });
  const served = await serve(machine, request, price, { run, product, fetchImpl, wait, tries });
  return { lease, host_name, arch, price, place_id: served.computerId, release: served.release, sign_up_status: served.signUp };
}

/** A new release on a running computer: install, point current at it, restart, read back. */
export async function installOnPlace(leaseFile, request, { fetchImpl = fetch, wait = pause, tries = 24, run = onMachine } = {}) {
  const lease = readLease(absolute(leaseFile, 'LEASE_FILE')), machine = { ssh: request.ssh, address: lease.address };
  const release = await installRelease(machine, request.engine, run);
  await run(machine, 'systemctl restart place.service && sleep 3 && systemctl is-active place.service');
  const config = JSON.parse(await run(machine, 'cat /var/lib/place/place.json'));
  const host = lease.hostName ?? request.name.host_name;
  return { release, sign_up_status: await healthStatus(machine, config, host, healthOf(config, request), { fetchImpl, wait, tries, run }) };
}

/** The update of a running computer, in a backup folder named for this moment, inside its own state folder. */
const backupFolder = (state, now = new Date()) => `${state}/${SETTINGS.update.backups}/update-${now.toISOString().replace(/[:.]/g, '-')}`;
/** The release feed the bootstrap follows: its first URL and its first key (the request's release_feed, already checked). */
const feedEnv = feed => (feed ? [`FEED_URL=${q(feed.urls[0])}`, `PUBLIC_KEY=${q(feed.public_keys[0])}`] : []);
const updateScript = (args, { root, settle, layout, feed = null }) => {
  const set = [root && `ROOT=${q(root)}`, `SETTLE=${q(settle)}`, ...(layout ? Object.entries(layoutEnv(layout)).map(([key, value]) => `${key}=${q(value)}`) : []), ...feedEnv(feed)].filter(Boolean);
  return `env ${set.join(' ')} sh -s -- ${args.map(q).join(' ')}`;
};
const layoutEnv = layout => ({ CONFIG: layout.config, UNIT_FILE: layout.unit_file, UNIT: layout.unit, CURRENT: layout.current, STATE: layout.state, OWNER: layout.owner });
const PATH_PART = /^(\/[A-Za-z0-9._@-]+)+$/;
const LAYOUT_FIELDS = ['unit', 'unit_file', 'config', 'current', 'state', 'owner', 'releases'];

/** What a computer's service unit says about its layout: the computer config its `serve` names, the `current` link it
 * starts the engine through, the folder it works in (else the config's folder) and the user it runs as. */
export function parseUnit(text) {
  const exec = text.match(/^ExecStart=(.*)$/m)?.[1] ?? '';
  const config = exec.match(/\bserve\s+['"]?(\/[^\s'"]+)/)?.[1];
  const current = exec.match(/(\/[A-Za-z0-9._@/-]*\/current)(?![A-Za-z0-9._-])/)?.[1];
  const state = text.match(/^WorkingDirectory=(\S+)$/m)?.[1] ?? (config && dirname(config));
  return { config, current, state, owner: text.match(/^User=(\S+)$/m)?.[1] ?? 'root' };
}

/** The computer's own layout: the request's `layout` fields first (a per-computer DATA row), the rest read from the
 * computer. The unit is the one named, else the one unit under /etc/systemd/system that serves a config through a
 * `current` link; the releases folder is the folder `current` points into. No layout is assumed. */
export async function readLayout(machine, request, run = onMachine, root = '') {
  const given = request.layout ?? {};
  const extra = Object.keys(given).filter(key => !LAYOUT_FIELDS.includes(key));
  if (extra.length) throw refused(`layout takes ${LAYOUT_FIELDS.join(', ')} only, not ${extra.join(', ')}.`);
  let unitFile = given.unit_file ?? (given.unit && `/etc/systemd/system/${given.unit}`);
  if (!unitFile) {
    const found = (await run(machine, `for f in ${q(`${root}/etc/systemd/system`)}/*.service; do [ -f "$f" ] && grep -q ' serve ' "$f" && grep -q '/current' "$f" && echo "$f"; done; true`)).split('\n').filter(Boolean);
    if (found.length !== 1) throw refused(`Found ${found.length ? found.map(f => basename(f)).join(', ') : 'no unit'} serving a computer through a current link; name it in the request's layout.unit.`);
    unitFile = found[0].slice(root.length);
  }
  const unit = parseUnit(await run(machine, `cat ${q(`${root}${unitFile}`)}`));
  const layout = { unit: basename(unitFile), unit_file: unitFile, ...unit, ...Object.fromEntries(Object.entries(given).filter(([key]) => key !== 'releases')) };
  if (PATH_PART.test(layout.current ?? '')) {
    const target = (await run(machine, `readlink ${q(`${root}${layout.current}`)} || true`)).trim().replace(/\/$/, '');
    layout.release_dir = target ? posix.resolve(dirname(layout.current), target) : null;
  }
  layout.releases = given.releases ?? (layout.release_dir && dirname(layout.release_dir));
  for (const key of ['unit_file', 'config', 'current', 'state', 'releases']) {
    if (!PATH_PART.test(layout[key] ?? '') || layout[key].split('/').some(part => part === '..' || part === '.')) throw refused(`The computer's layout has no usable ${key} (${layout[key] ?? 'none found'}); give it in the request's layout.${key}.`);
  }
  if (!/^[a-z_][a-z0-9_-]*$/.test(layout.owner) || !/^[A-Za-z0-9@._-]+\.service$/.test(layout.unit)) throw refused('The layout\'s owner must be a user name and its unit a .service name.');
  return layout;
}

/** A releases folder another user owns belongs to another unit: the update refuses to adopt into it, so each unit keeps its own
 * releases folder (its layout's releases, a DATA field of the unit). */
async function refuseSharedFolder(machine, folder, owner, run, root) {
  const found = (await run(machine, `ls -ld ${q(`${root}${folder}`)} 2>/dev/null | awk '{print $3}' || true`)).trim();
  if (found && found !== owner) throw refused(`The releases folder ${folder} belongs to ${found}, not the unit's owner ${owner}: give each unit its own releases folder in the request's layout.releases.`);
}

/** Bring a running computer to what a new one gets, in its own layout (`readLayout`): copy the request's release
 * (one that reads product settings and knows release_feed, such as the feed's newest) or keep the one `current` names
 * when the request gives none, write the product settings file into its state folder, add the feed (adopting into the
 * computer's own releases folder) and a copies policy it can meet (`copiesFor`) to its computer config, name the file in
 * its service, point `current` at the release and restart, all from one backup folder (do-work/update-a-computer.sh).
 * A service that is not active after the restart, or a sign-up page that does not answer 200, puts everything back.
 * `root` is for made-up computer folders in tests. */
export async function updateAComputer(leaseFile, request, { fetchImpl = fetch, wait = pause, tries = 24, run = onMachine, root = '', settle = SETTINGS.update.settle_seconds, now = new Date() } = {}) {
  const snapshot = readProductData(request);
  if (request.copies !== undefined) copiesPolicy(request.copies);
  const lease = readLease(absolute(leaseFile, 'LEASE_FILE')), machine = { ssh: request.ssh, address: lease.address };
  const named = feedOf(request);
  if (!named) throw refused('An update needs the caller\'s release_feed.');
  if (!request.engine?.file) throw refused('An update needs engine.file: the engine program inside a release.');
  const layout = await readLayout(machine, request, run, root);
  const feed = { ...named, releases: typeof request.release_feed?.releases === 'string' ? named.releases : layout.releases };
  const adopt = adoptFolder({ release_feed: feed });
  if (adopt) await refuseSharedFolder(machine, adopt, layout.owner, run, root);
  const release = request.engine.release ? await copyRelease(machine, { ...request.engine, releases: layout.releases }, run, root) : layout.release_dir;
  if (!release) throw refused('The computer\'s current link names no release, and the request gives none.');
  const config = JSON.parse(await run(machine, `cat ${q(`${root}${layout.config}`)}`));
  config.release_feed = feed;
  if (request.health !== undefined) config.health = healthOf(config, request);
  const health = healthOf(config);
  const settingsFile = `${layout.state}/${basename(productSettings.file)}`;
  const product = productSettingsOf(snapshot, settingsFile);
  config.new_accounts = startingRows(config, request, product);
  await installStatics(machine, staticFolderOf(settingsFile), product.statics, layout.owner, run, root);
  const backup = backupFolder(layout.state, now), staged = `${root}${backup}/new`, options = { root, settle, layout };
  await run(machine, `install -d -m 0700 ${q(staged)}`);
  await run(machine, `install -m 0600 /dev/stdin ${q(`${staged}/place.json`)}`, `${JSON.stringify(config, null, 1)}\n`);
  await run(machine, `install -m 0600 /dev/stdin ${q(`${staged}/product-settings.json`)}`, product.bytes);
  try {
    await run(machine, updateScript(['apply', backup, release, request.engine.file, productSettings.launch_setting, settingsFile, adopt], { ...options, feed: named }), readFileSync(UPDATE));
    await capTheJournal(machine, run, root);
  } catch (error) {
    throw Object.assign(new Error(`The update was put back from ${backup}: ${error.message}`), { backup });
  }
  const host = lease.hostName ?? request.name?.host_name, signUp = host ? await healthStatus(machine, config, host, health, { fetchImpl, wait, tries, run }) : null;
  if (host && signUp !== health.status) {
    await run(machine, updateScript(['rollback', backup], { root, settle, feed: named }), readFileSync(UPDATE));
    throw Object.assign(new Error(`${host}${health.path} answered ${signUp ?? 'nothing'} after the update, not ${health.status}, so it was put back from ${backup}.`), { backup });
  }
  return {
    layout: { unit: layout.unit, config: layout.config, current: layout.current, state: layout.state, releases: layout.releases },
    release, backup, product_settings: settingsFile, release_feed: { urls: feed.urls, releases: feed.releases },
    copies: config.new_accounts?.copies ?? null, sign_up_status: signUp,
  };
}

/** Put a computer back from the backup an update made (its answer's `backup`); the backup keeps the layout. */
export async function rollBackAComputer(leaseFile, request, backup, { run = onMachine, root = '', settle = SETTINGS.update.settle_seconds } = {}) {
  const lease = readLease(absolute(leaseFile, 'LEASE_FILE')), machine = { ssh: request.ssh, address: lease.address };
  if (!new RegExp(`^(/[A-Za-z0-9._@-]+)+/${SETTINGS.update.backups}/update-[0-9TZ-]+$`).test(backup ?? '') || backup.includes('/../')) throw refused(`BACKUP is a folder an update answered, like /var/lib/place/${SETTINGS.update.backups}/update-2026-11-04T17-15-00-000Z.`);
  const said = await run(machine, updateScript(['rollback', backup], { root, settle, feed: feedOf(request) }), readFileSync(UPDATE));
  return { backup, rolled_back: said.trim() };
}

/** The monthly price the request's machine would cost, read before anything is rented. */
export async function priceOfAPlace(request, { machineToken, fetchImpl = fetch } = {}) {
  const row = machineProvider(request.machine.provider);
  return { provider: row.id, placement: { ...row.placement, ...request.machine.placement }, price: await readPrice({ request: row.base ? providerClient(row, machineToken, { fetchImpl }) : null, provider: row, placement: request.machine.placement }) };
}

export async function placeStatus(leaseFile, { machineToken, fetchImpl = fetch } = {}) {
  const file = absolute(leaseFile, 'LEASE_FILE'), lease = readLease(file), row = machineProvider(lease.provider);
  const machine = await readMachine({ request: row.base ? providerClient(row, machineToken, { fetchImpl }) : null, file, provider: row });
  const health = healthOf({});
  if (health.where !== 'public') throw refused('A status reads the public health row only: the place is not asked on its machine.');
  const signUp = lease.hostName ? await healthStatus(machine, {}, lease.hostName, health, { fetchImpl, wait: pause, tries: 1 }) : null;
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
  const resolveIn = (holder, key) => { if (holder && typeof holder[key] === 'string') holder[key] = resolvePath(here, holder[key]); };
  resolveIn(request, 'lease_file');
  resolveIn(request, 'product_data');
  resolveIn(request.machine, 'public_key_file');
  resolveIn(request.ssh, 'known_hosts');
  resolveIn(request.ssh, 'identity_file');
  resolveIn(request.engine?.release, 'tarball');
  return request;
}

async function pipe(fd) {
  let text = '';
  try { for await (const bytes of createReadStream(null, { fd, autoClose: false })) { text += bytes; if (text.length > 65536) throw new Error(`Descriptor ${fd} exceeds its private input bound.`); } }
  catch (error) { if (error.code === 'EBADF') return ''; throw error; }
  return text.trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, first, second, third] = process.argv.slice(2);
  const usage = 'usage: start-a-computer.mjs price REQUEST_FILE | rent REQUEST_FILE | start REQUEST_FILE | status LEASE_FILE | install LEASE_FILE REQUEST_FILE | update LEASE_FILE REQUEST_FILE | rollback LEASE_FILE REQUEST_FILE BACKUP | remove LEASE_FILE (machine credential on fd 3, name credential on fd 4)';
  const overMachine = ['install', 'update', 'rollback'];
  const json = path => readRequest(resolvePath(path));
  try {
    if (!first || !['price', 'rent', 'start', 'status', 'install', 'update', 'rollback', 'remove'].includes(operation) || overMachine.includes(operation) !== Boolean(second) || (operation === 'rollback') !== Boolean(third)) throw Object.assign(new Error(usage), { exit: 2 });
    const asked = ['price', 'rent', 'start'].includes(operation), lease = asked ? null : readLease(resolvePath(first));
    const needsName = ['rent', 'start'].includes(operation) ? Boolean(json(first).name?.provider) : operation === 'remove' && Boolean(lease.recordId);
    const needsMachine = !overMachine.includes(operation) && Boolean(machineProvider(asked ? json(first).machine.provider : lease.provider).base);
    const tokens = { machineToken: needsMachine ? await pipe(3) : '', nameToken: needsName ? await pipe(4) : '' };
    const answer = operation === 'price' ? await priceOfAPlace(json(first), tokens)
      : operation === 'rent' ? await rentAMachine(json(first), tokens).then(({ lease, host_name, arch, price }) => ({ lease, host_name, arch, price }))
      : operation === 'start' ? await startAComputer(json(first), tokens)
      : operation === 'status' ? await placeStatus(resolvePath(first), tokens)
        : operation === 'install' ? await installOnPlace(resolvePath(first), json(second))
          : operation === 'update' ? await updateAComputer(resolvePath(first), json(second))
            : operation === 'rollback' ? await rollBackAComputer(resolvePath(first), json(second), third)
          : await removeAPlace(resolvePath(first), tokens);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
