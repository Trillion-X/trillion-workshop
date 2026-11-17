// tools/start-a-computer/do-work/start-a-computer.mjs
//
// `tool:start-a-computer` and its siblings (tool-rows.json): make a machine into a computer that keeps people's accounts.
// The machine comes from the provider description the request names in machine.provider (a file the person keeps, rented
// or one they already run over SSH); its public name from the one in name.provider. Then set-up-the-machine.sh prepares it over SSH, the
// engine release is
// installed, the computer config is written, the engine starts serving, and the answer is what was read back: the computer
// id the engine reports, the sign-up page's HTTP status at the public name, and the provider's monthly price.
//
// The engine is input (its file name, data folder and the argv that prints the computer id); this tool names none.
// A path in a request file is read relative to that file; ssh uses the person's own SSH agent and settings unless
// the request names an identity file. Credentials arrive on private pipes only: descriptor 3 holds the machine
// provider's credential (the row's vault_key), descriptor 4 the name provider's, and descriptor 5 the values the computer
// row's units name by vault name (`secret_vault_key`), as one JSON object of vault name to value. They never reach argv, a file, the
// environment or the answer.
//
// The caller names its product data: the trillion-apps manifest computer/product-data.json (`product_data`), whose settings file
// and static files are checked by content identity before anything is written. The same settings snapshot supplies the starting
// account rows and the remote settings file, and its page look names the static folder beside that file. The caller also supplies
// the engine release is a folder or tarball the request names; no signed feed, follower or update flow exists.
//
// usage: start-a-computer.mjs price REQUEST_FILE | rent REQUEST_FILE | start REQUEST_FILE | status LEASE_FILE | unit LEASE_FILE REQUEST_FILE | install LEASE_FILE REQUEST_FILE | remove LEASE_FILE
import { differences, renderWhatItRuns, withReach } from './render-what-a-computer-runs.mjs';
import { readFileSync, readdirSync, createReadStream } from 'node:fs';
import { isAbsolute, dirname, basename, relative, resolve as resolvePath, posix } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from 'trillion-workshop/tools/content-identity/read-data/identity.mjs';
import {
  readProvider, providerClient, rentMachine, readMachine, releaseMachine, readPrice, pointName,
  forgetName, readLease, registerMachine, fileStore,
} from './rent-a-machine.mjs';

const SETUP = fileURLToPath(new URL('./set-up-the-machine.sh', import.meta.url));
const CAP_JOURNAL = fileURLToPath(new URL('./cap-the-journal.sh', import.meta.url));
const SETTINGS = JSON.parse(readFileSync(new URL('../read-data/settings.json', import.meta.url), 'utf8'));
// Each name's Caddy site block: the wrapper, with {SITE} and {PORT} still to fill.
export const SITE_BLOCK = readFileSync(new URL('../read-data/caddy-site-block.caddy', import.meta.url), 'utf8').trimEnd();
/** The launch setting that names the product settings file. */
export const productSettings = { launch_setting: SETTINGS.product_settings.launch_setting };
/** Where the product settings file is on the machine: the request's own `product_settings_file`, an absolute path. */
export const settingsFileOf = request => {
  if (typeof request.product_settings_file !== 'string' || !isAbsolute(request.product_settings_file)) throw refused('product_settings_file is the absolute path the product settings file gets on the computer.');
  return request.product_settings_file;
};
const q = text => `'${String(text).replace(/'/g, `'\\''`)}'`;
/** A shell word: as it is when it is only path and name characters, else quoted. */
const sh = text => (/^[A-Za-z0-9@._/:-]+$/.test(text) ? text : q(text));
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

/** Compare what a computer's row says it runs (`runs`, from `request.computer_row`) with what it runs now: every file the row
 * renders, every drop-in the row does not declare, and every unmanaged user and folder the row keeps. Answers the differences, [] when the
 * computer matches. An absent file is a difference; a failed connection is an error, not an absence. */
export async function runsDifferences(machine, runs, run = onMachine, product, deps = {}) {
  const { rendered, live, found } = await runsState(machine, runs, run, product, deps);
  return [...differences(rendered, live), ...found];
}

/** What a computer's `runs` renders, what the computer has at those paths, and what the computer keeps that `runs` does not
 * name. Each database unit's `reach` is first made into the lines and files it renders (`withReach`),
 * and the answer's `runs` is that whole list, the one the apply follows. */
export async function runsState(machine, given, run = onMachine, product, { fetchImpl = fetch, pages, releases = [] } = {}) {
  const runs = withReach(given), units = runs.units;
  const rendered = renderWhatItRuns(runs, SITE_BLOCK, product, pages);
  const live = {};
  for (const { path, binary } of rendered) live[path] = await readIfPresent(machine, run, path, binary);
  const found = [];
  for (const unit of units) {
    const dir = `/etc/systemd/system/${unit.unit}.d`;
    const names = (await run(machine, `if [ -d ${q(dir)} ]; then ls -1 ${q(dir)}; fi`)).split('\n').filter(Boolean);
    found.push(...names.filter(name => !(unit.drop_ins ?? []).includes(name.replace(/\.conf$/, ''))).map(name => ({ path: `${dir}/${name}`, reason: 'not in the computer row' })));
  }
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
  found.push(...present.map(path => ({ path, reason: 'present; the computer row says absent' })));
  // A user the row says is absent (`absent_users`, a tunnel user an old setup made) is a difference while the computer has it.
  const usersPresent = [];
  for (const user of runs.absent_users ?? []) {
    if (await run(machine, `getent passwd ${q(user)} >/dev/null || exit 3`).then(() => true, error => { if (error.code === 3) return false; throw error; })) usersPresent.push(user);
  }
  found.push(...usersPresent.map(user => ({ path: `user ${user}`, reason: 'present; the computer row says absent' })));
  // A unit run from a Workshop clone is behind when the clone is not at the commit its row follows.
  const moves = [];
  for (const unit of units.filter(row => row.workshop && row.workshop_commit)) {
    const wanted = await workshopCommitOf(unit, fetchImpl);
    const head = (await run(machine, `${asUser(unit)} git -C ${q(unit.workshop)} rev-parse HEAD`)).trim();
    if (head !== wanted) moves.push({ unit, from: head, to: wanted });
  }
  found.push(...moves.map(({ unit, from, to }) => ({ path: unit.workshop, reason: `runs Workshop ${from}; its row follows ${to}` })));
  // A unit whose release the request hands as a tarball (`releases`: unit, commit, tarball) is behind when its `current` is not
  // that commit; the apply unpacks the tarball beside the others and moves `current` to it with one rename.
  const tarballs = [];
  for (const row of releases) {
    const unit = units.find(given => given.unit === row.unit);
    if (!unit?.releases) throw refused(`releases names ${row.unit}, which is no unit of the computer row with a releases folder.`);
    if (!/^[0-9a-f]{40}$/.test(row.commit ?? '') || typeof row.tarball !== 'string') throw refused(`releases for ${row.unit} must give a full commit id and the tarball.`);
    const from = (await run(machine, `readlink ${q(`${unit.releases}/current`)} || true`)).trim();
    if (from !== row.commit) tarballs.push({ unit, from, row });
  }
  found.push(...tarballs.map(({ unit, from, row }) => ({ path: `${unit.releases}/current`, reason: `runs ${from || 'no release'}; the request gives ${row.commit}` })));
  return { runs, rendered, live, found, present, usersPresent, moves, tarballs };
}

const asUser = unit => `runuser -u ${q(unit.user)} --`;

/** The Workshop commit a unit's row follows: its pin, `workshop_commit`, a full commit id. */
export function workshopCommitOf(unit) {
  if (!/^[0-9a-f]{40}$/.test(unit.workshop_commit ?? '')) throw refused(`${unit.unit} workshop_commit must be a full commit id.`);
  return unit.workshop_commit;
}

/** A unit's program moved to the release the request hands as a tarball on this computer (`row.tarball`, its commit `row.commit`):
 * unpacked into the unit's `releases` folder as its user (once; a commit already there is not unpacked again) and made `current`
 * by one rename. The unit restarts on it at the apply. */
export async function placeTarball(machine, unit, row, run = onMachine) {
  const at = `${unit.releases}/${row.commit}`;
  const script = ['set -eu', `if [ ! -x ${q(`${at}/${unit.engine_file}`)} ]; then`, `install -d -m 0700 ${q(at)} && tar -xzf - -C ${q(at)}`, 'fi',
    `ln -sfn ${q(row.commit)} ${q(`${unit.releases}/current.new`)} && mv -T ${q(`${unit.releases}/current.new`)} ${q(`${unit.releases}/current`)}`].join('\n');
  await run(machine, `${asUser(unit)} sh -c ${q(script)}`, createReadStream(absolute(row.tarball, 'releases.tarball')));
  return row.commit;
}

/** One file's text on the computer, or undefined when it is absent. A binary file is read as its base64, the form the computer row renders it in. */
async function readIfPresent(machine, run, path, binary) {
  return run(machine, `if [ -f ${q(path)} ]; then ${binary ? 'base64 -w0' : 'cat'} ${q(path)}; else exit 3; fi`).catch(error => { if (error.code === 3) return undefined; throw error; });
}

/** Apply what a computer's row says it runs: set it up, seal each secret a unit names that the computer does not hold yet, write only
 * the files that differ from what the row renders, and restart what those change. A computer that already matches gets
 * nothing written, no set-up run and nothing restarted. A file that is replaced keeps its previous bytes beside it as
 * `NAME.bak-STAMP`. `held` maps a unit's `secret_vault_key` to the value the person's vault holds under that name; the value
 * reaches the computer only on the SSH channel's standard input, sealed there by systemd-creds at the unit's `secret_file`. */
/** The sealed credentials a unit loads: its own (`secret_*`) and each of its `credentials` ({ vault_key, name, file, env? });
 * each as { unit, secret_vault_key, secret_name, secret_file }. */
export const secretsOf = unit => [
  unit.secret_file && { unit: unit.unit, secret_vault_key: unit.secret_vault_key, secret_name: unit.secret_name, secret_file: unit.secret_file },
  ...(unit.credentials ?? []).map(credential => ({ unit: unit.unit, secret_vault_key: credential.vault_key, secret_name: credential.name, secret_file: credential.file })),
].filter(Boolean);

export async function applyWhatItRuns(machine, given, run = onMachine, product, held = {}, deps = {}) {
  const { runs, rendered, live, present, usersPresent, moves, tarballs } = await runsState(machine, given, run, product, deps);
  const writes = rendered.filter(({ path, text }) => live[path] !== text);
  const absent = (path, input) => run(machine, `${path} || exit 3`, input).then(() => false, error => { if (error.code === 3) return true; throw error; });
  const nodes = [...new Set(runs.units.map(unit => unit.node_bin).filter(Boolean))];
  const nodeMissing = (await Promise.all(nodes.map(bin => absent(`test -x ${q(`${bin}/node`)}`)))).includes(true);
  const foldersMissing = (await Promise.all(runs.units.flatMap(unit => (unit.folders ?? []).map(folder => absent(`test -d ${q(folder)}`))))).includes(true);
  const missing = [];
  // A credential the computer does not hold is sealed from the value handed under its vault name; one it holds that differs from the
  // value now handed (the vault is the original, so a changed value is the one to run) is sealed again, and its unit restarts to load it.
  for (const secret of runs.units.flatMap(secretsOf)) {
    const handed = typeof held[secret.secret_vault_key] === 'string' && held[secret.secret_vault_key] !== '';
    if (await absent(`test -s ${q(secret.secret_file)}`)
      || (handed && await absent(`test "$(systemd-creds decrypt --name=${q(secret.secret_name)} ${q(secret.secret_file)} -)" = "$(cat)"`, held[secret.secret_vault_key]))) missing.push(secret);
  }
  for (const unit of missing) {
    if (typeof held[unit.secret_vault_key] !== 'string' || !held[unit.secret_vault_key]) {
      throw refused(`${unit.unit} needs the value held under the vault name ${unit.secret_vault_key}: hand it on descriptor 5 as {"${unit.secret_vault_key}": value}, read from the person's vault.`);
    }
  }
  // A unit file the row says is absent is a unit the computer must not run: it is stopped and disabled, and its drop-ins go
  // with its file.
  for (const path of present) {
    const unit = path.match(/^\/etc\/systemd\/system\/([A-Za-z0-9@._-]+\.(?:service|timer|path|socket))$/)?.[1];
    if (unit) await run(machine, `systemctl disable --now ${q(unit)} && rm -rf -- ${q(`${path}.d`)}`);
    await run(machine, `rm -f -- ${q(path)}`);
  }
  if (present.some(path => path.startsWith('/etc/systemd/system/'))) await run(machine, 'systemctl daemon-reload');
  // The ssh server reads its drop-ins at a reload: a removed one stops admitting its user then. A user the row says is absent
  // is removed with its home folder.
  if (present.some(path => path.startsWith('/etc/ssh/sshd_config.d/'))) await run(machine, 'sshd -t && systemctl reload ssh');
  for (const user of usersPresent) await run(machine, `userdel -r ${q(user)}`);
  const removed = present.length || usersPresent.length ? { removed: [...present, ...usersPresent.map(user => `user ${user}`)] } : {};
  // A clone the row's pin has moved past goes to that commit as its unit's user; its unit restarts only when the
  // tool folder it runs from changed.
  const toolChanged = [];
  for (const { unit, from, to } of moves) {
    const tree = commit => run(machine, `${asUser(unit)} git -C ${q(unit.workshop)} rev-parse ${q(`${commit}:${unit.tool_folder}`)}`).then(text => text.trim());
    await run(machine, `${asUser(unit)} git -C ${q(unit.workshop)} fetch -q --depth 1 origin ${q(to)} && ${asUser(unit)} git -C ${q(unit.workshop)} checkout -q --detach ${q(to)}`);
    if (!unit.tool_folder || await tree(from).catch(() => null) !== await tree(to)) toolChanged.push(unit.unit);
  }
  const moved = moves.length ? { moved: moves.map(({ unit, from, to }) => ({ path: unit.workshop, from, to })) } : {};
  // A timer the row names runs only while it is active: one that is not, whether it was just written or stopped, is started.
  const timersOff = [];
  for (const unit of runs.units.filter(row => row.unit.endsWith('.timer'))) if (await absent(`systemctl is-active --quiet ${q(unit.unit)}`)) timersOff.push(unit.unit);
  // The packages and programs the set-up data names (settings.json `machine` with the row's own over it) are made by set-up too.
  const machineData = { ...SETTINGS.machine, ...runs.machine };
  const programsMissing = (await Promise.all([
    ...(machineData.packages ?? []).map(name => absent(`dpkg -s ${q(name)} >/dev/null 2>&1`)),
    ...(machineData.downloads ?? []).map(({ path }) => absent(`test -x ${q(path)}`)),
  ])).includes(true);
  if (!writes.length && !missing.length && !nodeMissing && !foldersMissing && !programsMissing && !timersOff.length && !toolChanged.length && !tarballs.length && !usersPresent.length) return { written: [], restarted: [], ...removed, ...moved };
  // Set-up makes what is missing (packages, node, accounts, folders); a computer whose accounts and node all exist needs
  // none, and running it would refresh the package lists on every apply.
  const accounts = await Promise.all(runs.units.map(unit => run(machine, `getent passwd ${q(unit.user)} >/dev/null || exit 3`).then(() => true, error => { if (error.code === 3) return false; throw error; })));
  // A front door's pinned Caddy is fetched by set-up too, so a row that gains front_door on a computer that has its
  // accounts still runs set-up once.
  const door = runs.caddy?.front_door;
  const doorCaddy = door ? await frontDoorCaddy(machine, run, door) : null;
  const caddyMissing = door ? await run(machine, `printf '%s  %s\\n' ${q(doorCaddy.sha256)} ${q(doorCaddy.binary)} | sha256sum -c --status || exit 3`).then(() => false, error => { if (error.code === 3) return true; throw error; }) : false;
  // The set-up data is settings.json `machine` with the row's own `machine` fields over it (its packages, its firewall).
  if (accounts.includes(false) || caddyMissing || nodeMissing || foldersMissing || programsMissing) await run(machine, `sh -s -- ${q(JSON.stringify(runs))} ${q(JSON.stringify(machineData))}${door ? ` ${q(`${doorCaddy.binary} ${doorCaddy.url} ${doorCaddy.sha256}`)}` : ''}`, readFileSync(SETUP));
  for (const unit of missing) {
    await run(machine, `install -d -m 0700 ${q(dirname(unit.secret_file))} && umask 077 && systemd-creds encrypt --name=${q(unit.secret_name)} - ${q(unit.secret_file)}`, held[unit.secret_vault_key]);
  }
  const released = [];
  for (const { unit, from, row } of tarballs) released.push({ unit: unit.unit, from: from || null, commit: await placeTarball(machine, unit, row, run) });
  // A product settings file and an engine config are the unit's own: its user owns them and they are private (0600), as serve
  // writes them.
  const owner = path => runs.units.find(unit => unit.product_settings === path || unit.config === path)?.user;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const { path, text, binary } of writes) {
    if (live[path] !== undefined) await run(machine, `cp -p ${q(path)} ${q(`${path}.bak-${stamp}`)}`);
    if (path === CADDYFILE) {
      await run(machine, `install -m 0644 -o root -g root /dev/stdin ${q(`${path}.new`)}`, text);
      // A front door's site file names its shared storage through the environment file only the door's Caddy reads.
      // The Caddy that validates is the one the computer runs: the pinned front door's, or the caddy row's `binary`, with
      // the storage environment its site file reads (`storage_env`) when the row names one.
      const storageEnv = door?.storage_env ?? runs.caddy?.storage_env;
      const binary = door ? q(doorCaddy.binary) : runs.caddy?.binary ? q(runs.caddy.binary) : 'caddy';
      const validate = storageEnv ? `set -a && . ${q(storageEnv)} && set +a && ${binary}` : binary;
      await run(machine, `${validate} validate --config ${q(`${path}.new`)} --adapter caddyfile >/dev/null && mv ${q(`${path}.new`)} ${q(path)}`);
    } else if (owner(path)) {
      await run(machine, `install -m 0600 -o ${q(owner(path))} -g ${q(owner(path))} /dev/stdin ${q(path)}`, text);
    } else {
      await run(machine, `install -d -m 0755 ${q(dirname(path))} && ${binary ? 'base64 -d | ' : ''}install -m 0644 -o root -g root /dev/stdin ${q(path)}`, text);
    }
  }
  // A file a unit reads (its settings, access file or script) changes that unit, and each unit that names it; a unit file or
  // drop-in changes its own unit.
  const unitsOf = path => {
    const readers = runs.units.filter(unit => [unit.product_settings, unit.config, unit.settings_file, unit.hba_file, unit.script_file].includes(path)).map(unit => unit.unit);
    return readers.length ? readers : [path.match(/\/([^/]+\.(?:service|timer))(?:\.d\/[^/]+)?$/)?.[1]];
  };
  const fedUnits = tarballs.map(({ unit }) => unit.unit);
  const units = [...new Set([...writes.flatMap(({ path }) => unitsOf(path)), ...missing.map(unit => unit.unit), ...timersOff, ...toolChanged, ...fedUnits].filter(Boolean))];
  const running = new Set([...writes.filter(({ path }) => live[path] !== undefined).flatMap(({ path }) => unitsOf(path)),
    ...[...missing.map(unit => unit.unit), ...toolChanged, ...fedUnits].filter(name => live[`/etc/systemd/system/${name}`] !== undefined)]);
  if (units.length) await run(machine, 'systemctl daemon-reload');
  // Caddy is restarted, never only enabled, when its front-door drop-in changes: the drop-in swaps the program itself.
  for (const unit of units) {
    await run(machine, running.has(unit) || unit === 'caddy.service' ? `systemctl restart ${q(unit)}` : `systemctl enable --now ${q(unit)} >/dev/null 2>&1`);
  }
  if (writes.some(({ path }) => path === CADDYFILE) && !units.includes('caddy.service')) await run(machine, 'systemctl reload caddy');
  // The boot check: each restarted unit must answer its own health row (`health`, `health_listen`, and the Host its request
  // names, `health.host`), else the one the computer row
  // names, else the tool default, on the machine itself, so a unit that starts and crashes, or a route that is not served, fails the apply instead of passing it.
  const booted = [];
  for (const unit of units) {
    const row = runs.units.find(given => given.unit === unit) ?? {};
    // A unit that is not an HTTP server names the command that tells it is well (`check_command`, run on the computer, exit 0).
    if (row.check_command) {
      await commandPasses(machine, row.check_command, { run, wait: deps.wait ?? pause, tries: 12 }, `${unit}'s check_command`);
      booted.push(unit);
      continue;
    }
    const health = healthOf({ health: row.health ?? runs.health }, {});
    const listen = row.health_listen ?? runs.health_listen ?? runs.caddy?.listen ?? `127.0.0.1:${runs.caddy?.port}`;
    const status = await healthStatus(machine, { listen }, health.host ?? runs.caddy?.site_hosts?.[0] ?? '', { ...health, where: 'machine' }, { fetchImpl: undefined, wait: pause, tries: 12, run });
    if (status !== health.status) throw Object.assign(new Error(`${unit} answered ${status ?? 'nothing'} on ${health.path}, not ${health.status}, after its restart.`), { unit, status });
    booted.push(unit);
  }
  return { written: writes.map(({ path }) => path), restarted: units, booted, ...(missing.length ? { sealed: missing.map(unit => unit.secret_name) } : {}), ...(released.length ? { released } : {}), ...removed, ...moved };
}

const CADDYFILE = '/etc/caddy/Caddyfile';

/** The pinned front-door Caddy for this machine's architecture: { binary, url, sha256 }, all from the computer row's
 * `front_door` (`binary`, and `binary_files`: architecture to { url, sha256 }), so this tool names no host. */
async function frontDoorCaddy(machine, run, door) {
  const arch = (await run(machine, 'uname -m')).trim();
  const file = door.binary_files?.[arch];
  if (!file?.url || !file.sha256) throw refused(`The computer row's caddy.front_door gives no binary_files for ${arch}: the address and SHA-256 of the pinned Caddy.`);
  return { binary: door.binary, ...file };
}

/** Copy the release onto the machine as RELEASES/NAME (under `root`, empty on a machine), pointing nothing
 * at it. */
export async function copyRelease(machine, engine, run = onMachine, root = '') {
  if (typeof engine.releases !== 'string' || !engine.releases.startsWith('/')) throw refused('engine.releases is the absolute folder releases are copied into on the computer.');
  const name = engine.release_name, dir = `${engine.releases}/${name}`, at = q(`${root}${dir}`);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name ?? '')) throw new Error('The release needs a release_name of letters, digits, dot, dash or underscore.');
  if (engine.release?.tarball) await run(machine, `install -d -m 0755 ${at} && tar -C ${at} -xzf -`, createReadStream(absolute(engine.release.tarball, 'engine.release.tarball')));
  else if (engine.release?.on_machine) await run(machine, `rm -rf ${at} && cp -a ${q(`${root}${engine.release.on_machine}`)} ${at}`);
  else throw new Error('The release is either { tarball: a .tar.gz on this computer } or { on_machine: a folder already on the machine }.');
  await run(machine, `chmod -R a+rX ${at} && test -x ${q(`${root}${dir}/${engine.file}`)}`);
  return dir;
}

/** Copy the release onto the machine as RELEASES/NAME and switch the live link, RELEASES/current, to it (the unit
 * runs that link; the follower moves it on each switch). */
export async function installRelease(machine, engine, run = onMachine) {
  const dir = await copyRelease(machine, engine, run);
  await run(machine, `ln -sfn ${q(dir)} ${sh(`${engine.releases}/current.new`)} && mv -T ${sh(`${engine.releases}/current.new`)} ${sh(`${engine.releases}/current`)}`);
  return dir;
}

const refused = message => Object.assign(new Error(message), { exit: 2 });

/** The folder beside a computer's product settings file that holds the static files its sign-in pages name (the page
 * look's `static_root`, trillion-rust src/account/sign_in/shell.rs). */
export const staticFolderOf = settingsFile => `${dirname(settingsFile)}/static`;

/** The Workshop package this tool runs from: a product data row `{ workshop: 'tools/<tool>/<file>' }` names a file of it (a
 * static file a Workshop tool owns, such as the app icons), never a path outside it. */
const WORKSHOP_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The product data the request's `product_data` manifest names (computer/product-data.json,
 * `{product_settings: {file, identity}, static: [{name, file | workshop, identity}]}`, each `file` read beside the manifest, each `workshop` read from this Workshop), read once
 * and checked: every file's bytes must hash to its `identity` (the BLAKE3 content identity, tools/content-identity) or nothing
 * is written. A caller takes this snapshot before anything else runs, so the files it later changes are not the ones written. */
export function readProductData(request) {
  const manifestFile = absolute(request.product_data, 'product_data');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const folder = dirname(manifestFile);
  const verified = entry => {
    const own = typeof entry?.workshop === 'string';
    if (typeof (own ? entry.workshop : entry?.file) !== 'string' || (own && 'file' in entry) || typeof entry.identity !== 'string') throw refused('product_data rows name a file or a Workshop file, and its identity.');
    if (own && (!entry.workshop.startsWith('tools/') || entry.workshop.split('/').some(part => part === '' || part === '.' || part === '..'))) throw refused('product_data workshop files are paths inside tools/ of the Workshop.');
    const name = own ? entry.workshop : entry.file;
    const bytes = readFileSync(own ? resolvePath(WORKSHOP_ROOT, name) : resolvePath(folder, name));
    if (makeHashCodeHexFromBytes(bytes) !== entry.identity) throw refused(`${name} is not the product data its manifest names (identity ${entry.identity}).`);
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
export function productSettingsOf(snapshot, settingsFile) {
  if (snapshot.source.length > SETTINGS.product_settings.most_bytes) throw refused('product_settings exceeds the engine settings file byte limit.');
  const data = JSON.parse(snapshot.source);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(data) || !object(data.new_accounts)) throw refused('product_settings.new_accounts must supply the starting account rows.');
  for (const key of ['sign_in', 'sign_in_ways', 'sign_in_words', 'copies_rules']) {
    if (!object(data.new_accounts[key])) throw refused(`product_settings.new_accounts.${key} must be an object.`);
  }
  copiesPolicy(data.new_accounts.copies);
  if (object(data.page_look)) {
    if (!settingsFile) throw refused('product_settings has a page_look, so its static folder needs the product settings file path (product_settings_file).');
    data.page_look.static_root = staticFolderOf(settingsFile);
  }
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
export function startingRows(config, request, product = productSettingsOf(readProductData(request), request.product_settings_file)) {
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

/** The computer config with the machine's own fields set, the request's default computers, plus values read
 * from files in the release. The machine is reached at its own name (`report.reach`); people reach its accounts at
 * `public_origin` when the request names one (a forwarder in front of several machines), else at that same name. */
export async function computerConfig(machine, request, price, run = onMachine, product = productSettingsOf(readProductData(request), request.product_settings_file)) {
  const reach = `https://${request.name.host_name}`, config = structuredClone(request.place_config ?? {});
  // The router is the product settings' `app_host` row, never a request's own value: a stale name (a staging router) once
  // came back through place_config and made every computer's messages fail, so a request that names one is refused.
  if (request.place_config && 'router' in request.place_config) throw refused('place_config must not name a router: the computer\'s router is the product settings app_host row.');
  if (typeof product?.data?.app_host !== 'string' || !product.data.app_host) throw refused('the product settings name no app_host, so the computer has no router.');
  for (const key of ['accounts', 'computer_key_file']) if (typeof config[key] !== 'string') throw refused(`place_config.${key} is the path the engine keeps it at on the computer.`);
  Object.assign(config, { listen: `127.0.0.1:${request.port}`, public_origin: request.public_origin ?? reach, router: `${product.data.app_host}:443` });
  config.report = { ...config.report, reach, ...(price && { cost_per_month_cents: price.cents }) };
  // The unit the computer row names for this computer's product settings: the service whose state the place reports (`unit`).
  const unit = request.computer_row?.runs?.units?.find(row => row.product_settings === request.product_settings_file)?.unit;
  if (unit) config.unit = unit;
  if (request.default_places !== undefined) config.default_places = defaultComputers(request.default_places);
  for (const from of request.config_from_release ?? []) {
    const value = JSON.parse(await run(machine, `cat ${q(`${request.engine.releases}/current/${from.file}`)}`))[from.key];
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

/** The service the request's computer row runs for the product settings file: its user, unit, config and releases folder (the
 * unit that names the request's `product_settings_file`), and the state folder its config sits in. */
export function serviceOf(request) {
  const unit = runsOf(request).units.find(row => row.product_settings === settingsFileOf(request));
  if (!unit?.user || !unit.unit || !unit.config || !unit.releases) throw refused('The computer row needs a unit that names the request\'s product_settings_file, with its user, unit, config and releases.');
  return { user: unit.user, unit: unit.unit, config: unit.config, releases: unit.releases, state: dirname(unit.config) };
}
const asEngine = (service, engine, settingsFile, argv) => `runuser -u ${sh(service.user)} -- env ${productSettings.launch_setting}=${q(settingsFile)} ${engine.data_env}=${q(`${service.releases}/current/${engine.data_dir}`)} ${q(`${service.releases}/current/${engine.file}`)} ${argv.map(q).join(' ')}`;

/** Cap the one log a computer keeps, the system journal, at the size every place keeps (settings `journal.system_max_use`) and stop the second copy rsyslog wrote, on a new machine or an update. */
export async function capTheJournal(machine, run = onMachine, root = '') {
  await run(machine, `env ROOT=${q(root)} JOURNAL_MAX=${q(SETTINGS.journal.system_max_use)} sh -s`, readFileSync(CAP_JOURNAL));
}

/** Set the machine up, install the release, write the config, start serving, and read it all back. */
async function serve(machine, request, price, { run, product, held, ...deps }) {
  const engine = request.engine;
  await applyWhatItRuns(machine, runsOf(request), run, undefined, held, { pages: readPages(request) });
  await capTheJournal(machine, run);
  const release = await installRelease(machine, engine, run);
  const config = await computerConfig(machine, request, price, run, product);
  const settingsFile = settingsFileOf(request), service = serviceOf(request), owner = sh(service.user), unit = sh(service.unit);
  await installStatics(machine, staticFolderOf(settingsFile), product.statics, service.user, run);
  await run(machine, `install -o ${owner} -g ${owner} -m 0600 /dev/stdin ${q(settingsFile)}`, product.bytes);
  await run(machine, `install -o ${owner} -g ${owner} -m 0600 /dev/stdin ${sh(service.config)}`, `${JSON.stringify(config, null, 1)}\n`);
  const computerId = engine.id_argv ? (await run(machine, `cd ${sh(service.state)} && ${asEngine(service, engine, settingsFile, [...engine.id_argv, service.config])}`)).trim() : null;
  await run(machine, `systemctl enable ${unit} >/dev/null 2>&1; systemctl restart ${unit} && sleep 3 && systemctl is-active ${unit}`);
  const host = request.name.host_name, health = healthOf(config, request);
  return { release, computerId, signUp: await healthStatus(machine, config, host, health, { ...deps, run }) };
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

export async function startAComputer(request, { machineToken, nameToken, held = {}, fetchImpl = fetch, wait = pause, tries = 48, run = onMachine } = {}) {
  const product = productSettingsOf(readProductData(request), request.product_settings_file);
  if (request.copies !== undefined) copiesPolicy(request.copies);
  if (request.default_places !== undefined) defaultComputers(request.default_places);
  const rented = await rentAMachine(request, { machineToken, nameToken, fetchImpl, wait, run });
  if (rented.lease.state === 'waiting') return rented;
  const { machine, price, arch, lease, host_name } = rented;
  const served = await serve(machine, request, price, { run, product, held, fetchImpl, wait, tries });
  return { lease, host_name, arch, price, place_id: served.computerId, release: served.release, sign_up_status: served.signUp };
}

/** A unit's verdict from its `systemctl show` values: an alert when it is not active, or has restarted past the budget
 * (`read-data/settings.json` `unit_restarts.budget`). NRestarts counts restarts since the unit was loaded. */
export function unitVerdict(show, budget = SETTINGS.unit_restarts.budget) {
  const nrestarts = Number(show.NRestarts);
  if (!Number.isInteger(nrestarts) || !show.Id) throw refused('systemctl show did not name the unit or its restart count.');
  const alert = show.ActiveState !== 'active' || nrestarts > budget;
  return { unit: show.Id, active: show.ActiveState, sub: show.SubState, nrestarts, budget, alert };
}

/** Read a running place's unit over SSH (`request.engine_unit.unit`, the unit's name) and give its verdict. */
export async function unitStatus(leaseFile, request, { run = onMachine } = {}) {
  const lease = await leaseOf(leaseFile), machine = { ssh: request.ssh, address: lease.address };
  const unit = request.engine_unit?.unit;
  if (typeof unit !== 'string' || !/^[A-Za-z0-9@._-]+\.service$/.test(unit)) throw refused('unit reads request.engine_unit.unit, a service name such as example.service.');
  const show = Object.fromEntries((await run(machine, `systemctl show ${q(unit)} -p Id -p ActiveState -p SubState -p NRestarts`)).trim().split('\n').map(line => line.split('=')));
  return unitVerdict(show);
}

/** A new release on a running computer: install, point current at it, restart, read back. */
export async function installOnAComputer(leaseFile, request, { fetchImpl = fetch, wait = pause, tries = 24, run = onMachine } = {}) {
  const lease = await leaseOf(leaseFile), machine = { ssh: request.ssh, address: lease.address };
  const release = await installRelease(machine, request.engine, run);
  const service = serviceOf(request), unit = sh(service.unit);
  await run(machine, `systemctl restart ${unit} && sleep 3 && systemctl is-active ${unit}`);
  const config = JSON.parse(await run(machine, `cat ${sh(service.config)}`));
  const host = lease.hostName ?? request.name.host_name;
  return { release, sign_up_status: await healthStatus(machine, config, host, healthOf(config, request), { fetchImpl, wait, tries, run }) };
}

/** The monthly price the request's machine would cost, read before anything is rented. */
export async function priceOfAComputer(request, { machineToken, fetchImpl = fetch } = {}) {
  const row = readProvider(request.machine.provider);
  return { provider: row.id, terms_url: row.terms_url ?? null, placement: { ...row.placement, ...request.machine.placement }, price: await readPrice({ request: row.base ? providerClient(row, machineToken, { fetchImpl }) : null, provider: row, placement: request.machine.placement }) };
}

export async function computerStatus(leaseFile, { machineToken, fetchImpl = fetch } = {}) {
  const store = fileStore(absolute(leaseFile, 'LEASE_FILE')), lease = await readLease(store), row = readProvider(lease.providerFile);
  const machine = await readMachine({ request: row.base ? providerClient(row, machineToken, { fetchImpl }) : null, store, provider: row });
  const health = healthOf({});
  if (health.where !== 'public') throw refused('A status reads the public health row only: the place is not asked on its machine.');
  const signUp = lease.hostName ? await healthStatus(machine, {}, lease.hostName, health, { fetchImpl, wait: pause, tries: 1 }) : null;
  return { name: lease.name, provider: lease.provider, lease_state: lease.state, machine, host_name: lease.hostName ?? null, sign_up_status: signUp };
}

/** Forget the public name, then give the machine back (an adopted machine is only forgotten). */
export async function removeAComputer(leaseFile, { machineToken, nameToken, fetchImpl = fetch } = {}) {
  const store = fileStore(absolute(leaseFile, 'LEASE_FILE')), lease = await readLease(store), row = readProvider(lease.providerFile);
  if (lease.recordId) await forgetName({ request: providerClient(readProvider(lease.namesFile), nameToken, { fetchImpl }), store });
  const done = await releaseMachine({ request: row.base ? providerClient(row, machineToken, { fetchImpl }) : null, store, provider: row });
  return { name: done.name, provider: done.provider, state: done.state, adopted: Boolean(done.adopted) };
}

/** What the computer runs: `request.computer_row` is the computer's own row (a `record:computer`: its address, name and
 * `runs`, the units, Caddy and set-up it runs), handed in with the request; this tool reads no store for it. */
export function runsOf(request) {
  const runs = request.computer_row?.runs;
  if (!runs || typeof runs !== 'object' || !Array.isArray(runs.units) || !runs.caddy) throw refused('computer_row is the computer\'s own row: its `runs` names the units and caddy the computer runs.');
  return runs;
}

/** The pages a front door answers itself, handed in as `pages_folder` (the person's own folder, resolved against the request
 * file): every file of it, as { name, bytes }; undefined when the request names none. */
export function readPages(request) {
  if (request.pages_folder === undefined) return undefined;
  const folder = absolute(request.pages_folder, 'pages_folder');
  return readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => ({ name: relative(folder, `${entry.parentPath}/${entry.name}`), bytes: readFileSync(`${entry.parentPath}/${entry.name}`) }));
}

/** The product settings text a computer row's units read, from the request's product data (`product_data`, checked by content
 * identity), its page look's static folder beside the file the unit that names `product_settings` reads; undefined when the
 * request names no product data. */
export function productOfRuns(request, runs) {
  if (request.product_data === undefined) return undefined;
  const unit = runs.units.find(row => row.product_settings);
  if (!unit) throw refused('product_data is given but no unit of the computer row names a product_settings file.');
  return productSettingsOf(readProductData(request), unit.product_settings).bytes.toString('utf8');
}

/** Apply a computer's row to the computer the request names (`machine.address`, `ssh`), already running: the same
 * apply a start does, with the values its units name by vault name (`held`) and the request's product data. */
export async function applyAComputerRow(request, { held = {}, run = onMachine, fetchImpl = fetch } = {}) {
  const runs = runsOf(request);
  return applyWhatItRuns({ ssh: request.ssh, address: request.machine.address }, runs, run, productOfRuns(request, runs), held, { fetchImpl, pages: readPages(request), releases: request.releases });
}

/** What the computer the request names runs that its row does not render: [] when it matches. */
export async function computerRowDifferences(request, { run = onMachine, fetchImpl = fetch } = {}) {
  const runs = runsOf(request);
  return { differences: await runsDifferences({ ssh: request.ssh, address: request.machine.address }, runs, run, productOfRuns(request, runs), { fetchImpl, pages: readPages(request), releases: request.releases }) };
}

/** A request read from its file, each of its paths resolved against the file's own folder. */
export function readRequest(file) {
  const request = JSON.parse(readFileSync(absolute(file, 'REQUEST_FILE'), 'utf8')), here = dirname(file);
  const resolveIn = (holder, key) => { if (holder && typeof holder[key] === 'string') holder[key] = resolvePath(here, holder[key]); };
  resolveIn(request, 'lease_file');
  resolveIn(request, 'product_data');
  resolveIn(request, 'pages_folder');
  // The computer's row may be its own file (`computer_row_file`): the row is that file's JSON, read here.
  let rowHere = here;
  if (typeof request.computer_row_file === 'string') {
    const rowFile = resolvePath(here, request.computer_row_file);
    request.computer_row = JSON.parse(readFileSync(rowFile, 'utf8'));
    rowHere = dirname(rowFile);
    delete request.computer_row_file;
  }
  // A unit's `settings_parts` names files the person keeps (a provider description) that go into its settings: each key is a
  // dotted place in `settings`, each value a path relative to the computer row's file, whose JSON is put at that place.
  for (const unit of request.computer_row?.runs?.units ?? []) {
    for (const [place, path] of Object.entries(unit.settings_parts ?? {})) {
      const keys = place.split('.'), last = keys.pop();
      const holder = keys.reduce((held, key) => held?.[key], unit.settings);
      if (!holder || typeof holder !== 'object') throw refused(`${unit.unit} settings_parts names ${place}, and its settings hold no ${keys.join('.') || 'settings'} object to put it in.`);
      holder[last] = JSON.parse(readFileSync(resolvePath(rowHere, path), 'utf8'));
    }
    delete unit.settings_parts;
  }
  resolveIn(request.machine, 'provider');
  resolveIn(request.name, 'provider');
  resolveIn(request.machine, 'public_key_file');
  resolveIn(request.ssh, 'known_hosts');
  resolveIn(request.ssh, 'identity_file');
  resolveIn(request.engine?.release, 'tarball');
  for (const row of request.releases ?? []) resolveIn(row, 'tarball');
  return request;
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
  const usage = 'usage: start-a-computer.mjs price REQUEST_FILE | rent REQUEST_FILE | start REQUEST_FILE | apply REQUEST_FILE | differences REQUEST_FILE | status LEASE_FILE | unit LEASE_FILE REQUEST_FILE | install LEASE_FILE REQUEST_FILE | remove LEASE_FILE | register LEASE_FILE ADDRESS (the one-time token from the rent line on fd 3) (machine credential on fd 3, name credential on fd 4, the values a computer row names by vault name on fd 5)';
  const overMachine = ['install', 'unit'];
  const json = path => readRequest(resolvePath(path));
  try {
    if (operation === 'register') {
      if (!first || !second || third) throw Object.assign(new Error(usage), { exit: 2 });
      const lease = await registerMachine({ store: fileStore(resolvePath(first)), token: await pipe(3), address: second });
      process.stdout.write(`${JSON.stringify({ name: lease.name, provider: lease.provider, state: lease.state, address: lease.address })}\n`);
      process.exit(0);
    }
    if (operation === 'apply' || operation === 'differences') {
      if (!first || second) throw Object.assign(new Error(usage), { exit: 2 });
      const request = json(first), runs = withReach(runsOf(request));
      const held = operation === 'apply' && runs.units.some(unit => secretsOf(unit).length) ? heldValues(await pipe(5)) : {};
      const answer = operation === 'apply' ? await applyAComputerRow(request, { held }) : await computerRowDifferences(request);
      process.stdout.write(`${JSON.stringify(answer)}\n`);
      process.exit(0);
    }
    if (!first || !['price', 'rent', 'start', 'status', 'unit', 'install', 'remove'].includes(operation) || overMachine.includes(operation) !== Boolean(second) || Boolean(third)) throw Object.assign(new Error(usage), { exit: 2 });
    const asked = ['price', 'rent', 'start'].includes(operation), lease = asked ? null : await readLease(fileStore(resolvePath(first)));
    const needsName = ['rent', 'start'].includes(operation) ? Boolean(json(first).name?.provider) : operation === 'remove' && Boolean(lease.recordId);
    const needsMachine = !overMachine.includes(operation) && Boolean(readProvider(asked ? json(first).machine.provider : lease.providerFile).base);
    const startRuns = operation === 'start' ? withReach(runsOf(json(first))) : null;
    const needsHeld = (startRuns?.units ?? []).some(unit => secretsOf(unit).length);
    const tokens = { machineToken: needsMachine ? await pipe(3) : '', nameToken: needsName ? await pipe(4) : '', held: needsHeld ? heldValues(await pipe(5)) : {} };
    const answer = operation === 'price' ? await priceOfAComputer(json(first), tokens)
      : operation === 'rent' ? await rentAMachine(json(first), tokens).then(({ lease, host_name, arch, price, line, terms_url }) => ({ lease, host_name, arch, price, terms_url, ...(line && { line }) }))
      : operation === 'start' ? await startAComputer(json(first), tokens)
      : operation === 'status' ? await computerStatus(resolvePath(first), tokens)
        : operation === 'unit' ? await unitStatus(resolvePath(first), json(second))
        : operation === 'install' ? await installOnAComputer(resolvePath(first), json(second))
          : await removeAComputer(resolvePath(first), tokens);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    if (answer.alert === true) process.exitCode = 3;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
