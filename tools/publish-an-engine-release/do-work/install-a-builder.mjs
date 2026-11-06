// tools/publish-an-engine-release/do-work/install-a-builder.mjs
//
// `tool:install-an-engine-builder` and `tool:read-an-engine-builder` (tool-rows.json), run on the person's computer:
// make a Linux machine they run into the builder that publishes signed engine releases, over SSH as start-a-computer
// reaches a machine. install runs set-up-the-builder.sh (a builder user, git, Node.js, rust, Caddy serving the feed
// folder at https://<name>/engine-releases/ and passing push deliveries to the receiver, a firewall), copies this
// tool's own files there, writes the publish config, makes the signing key once on the builder (it never leaves; its
// public half is answered), makes a read key on the builder for a repository reached over SSH (its public half is
// answered, to add as a read-only deploy key), stores the repository token and the push secret as systemd credentials encrypted with
// the builder's own host key, and starts the push receiver service. A request's `accept_entries_from` (other builders'
// public keys, one builder per target) lets the receiver take their signed entries into this one feed. status reads the receiver, the feed and the last
// run back.
//
// The builder, repository and branch are input; this file names none. The repository token arrives on descriptor 3
// and the push secret on descriptor 4; each goes to the builder on the SSH channel's standard input, never argv, a
// file on this computer, the environment, a log or the answer.
//
// usage: install-a-builder.mjs install REQUEST_FILE | status REQUEST_FILE
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filesUnder, privateInput } from './publish-an-engine-release.mjs';
import { tarGz } from '../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';
import { readFeed, settings } from './release-feed.mjs';

const SETUP = fileURLToPath(new URL('./set-up-the-builder.sh', import.meta.url));
const SETUP_DARWIN = fileURLToPath(new URL('./set-up-darwin-builds.sh', import.meta.url));
const D = settings.darwin;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const B = settings.on_builder;
const q = text => `'${String(text).replace(/'/g, `'\\''`)}'`;
const refuse = (message, exit = 2) => Object.assign(new Error(message), { exit });
const absolute = (path, what) => {
  if (typeof path !== 'string' || !isAbsolute(path)) throw refuse(`${what} must be an absolute path.`);
  return path;
};

// The files the builder runs, laid out as they are here so the imports resolve unchanged.
export const SHIPPED = [
  'tools/publish-an-engine-release/do-work', 'tools/publish-an-engine-release/read-data',
  'tools/content-identity/read-data', 'tools/content-identity/package.json', 'tools/keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs',
  ...['LICENSE', 'package.json', 'blake3.js', 'blake2.js', '_blake.js', '_md.js', '_u64.js', 'utils.js'].map(file => `node_modules/@noble/hashes/${file}`),
];

/** Run one command on the builder as root; `input` is a string, bytes or a readable stream. Answers stdout. */
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
    child.on('close', code => (code === 0 ? resolve(out) : reject(Object.assign(new Error(`On the builder, \`${command.split(' ')[0]}\` exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`), { code }))));
    if (input?.pipe) input.pipe(child.stdin); else child.stdin.end(input ?? '');
  });
}

/** The shipped files as one tar.gz, read from this checkout, with no __pycache__ in it. */
export const shippedTarball = (root = ROOT) => tarGz(filesUnder(root, SHIPPED, ['__pycache__']));

/** The request checked: the builder's address and public name, how to reach it, and the repository. */
export function checkRequest(request) {
  const { builder, ssh, repository } = request ?? {};
  if (!builder || typeof builder.address !== 'string' || !/^[0-9A-Fa-f.:]+$|^[a-z0-9.-]+$/.test(builder.address)) throw refuse('builder.address must be the machine\'s IP address or DNS name, which SSH reaches as root.');
  if (typeof builder.host_name !== 'string' || !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(builder.host_name)) throw refuse('builder.host_name must be the public DNS name pointed at the builder, like releases.example.com: Caddy gets its certificate for it.');
  if (!ssh || typeof ssh.known_hosts !== 'string') throw refuse('ssh.known_hosts must name the known_hosts file for the builder (made the first time).');
  if (!repository || typeof repository.url !== 'string' || !/^(https:\/\/|ssh:\/\/|git@)/.test(repository.url)) throw refuse('repository.url must be the URL git fetches the engine repository from, like https://github.com/OWNER/REPOSITORY.git.');
  if (typeof repository.branch !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(repository.branch)) throw refuse('repository.branch must be the branch whose pushes are published, like main.');
  if (request.accept_entries_from !== undefined && (!Array.isArray(request.accept_entries_from) || !request.accept_entries_from.every(key => /^[0-9a-f]{64}$/.test(key)))) throw refuse('accept_entries_from must list the Ed25519 public keys (64 lowercase hex) of the other builders whose signed entries this feed takes, one builder per target (contribute-an-engine-release.mjs public-key prints one).');
  if (request.darwin !== undefined) {
    const { targets = D.targets, team_id: team, sdk } = request.darwin ?? {};
    if (!Array.isArray(targets) || !targets.length || !targets.every(target => D.targets.includes(target))) throw refuse(`darwin.targets must list Mac targets the builder cross-builds: ${D.targets.join(', ')}.`);
    if (typeof team !== 'string' || !new RegExp(D.team_pattern).test(team)) throw refuse('darwin.team_id must be the Mac app\'s Developer ID team (10 letters and digits, the OU of its certificate).');
    if (typeof sdk !== 'string' || !/\.tar\.xz$/.test(sdk)) throw refuse('darwin.sdk must name a macOS SDK packed as .tar.xz on this computer, its one top folder the SDK (tar -C "$(xcrun --show-sdk-path)/.." -chJf MacOSX.sdk.tar.xz "$(basename "$(xcrun --show-sdk-path)")" on a Mac with Xcode).');
  }
  if (request.keep_releases !== undefined && (!Number.isSafeInteger(request.keep_releases) || request.keep_releases < 1 || request.keep_releases > settings.keep_releases)) throw refuse(`keep_releases must be a whole number from 1 to ${settings.keep_releases}.`);
  return request;
}

/** The config publish and the receiver read on the builder: paths and names only, never a credential. */
export function builderConfig(request) {
  return {
    repository: request.repository.url, branch: request.repository.branch,
    base_url: `https://${request.builder.host_name}${settings.feed_path}`,
    work_folder: B.work_folder, feed_folder: B.feed_folder, key_file: B.key_file, state_folder: B.state_folder,
    keep_releases: request.keep_releases ?? settings.keep_releases,
    toolchain: { cargo: `${B.home}/.cargo/bin/cargo`, rustc: `${B.home}/.cargo/bin/rustc`, ...(request.darwin ? { rcodesign: `${B.home}/.cargo/bin/rcodesign`, zig_python: `${D.zig_folder}/bin/python3` } : {}) },
    receiver: { host: '127.0.0.1', port: settings.receiver_port, path: settings.push_path, entry_path: settings.entry_path },
    accept_entries_from: request.accept_entries_from ?? [],
    ...(request.darwin ? { darwin: { targets: request.darwin.targets ?? D.targets, team_id: request.darwin.team_id, sdk_root: D.sdk_folder } } : {}),
  };
}

const credential = name => `${B.credentials_folder}/${B.service}-${name}`;
const toolFile = name => `${B.tool_folder}/tools/publish-an-engine-release/do-work/${name}`;
const PATH = `${B.home}/.cargo/bin:/usr/local/bin:/usr/bin:/bin`;

/** A repository git reaches over SSH, with the builder's own read key instead of a token. */
export const overSsh = url => /^(ssh:\/\/|git@)/.test(url);
const GIT_SSH = `ssh -i ${B.repository_key_file} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${B.repository_known_hosts}`;

/** The receiver's systemd unit: its two credentials opened onto descriptors 3 and 4; git uses the builder's read key when `sshKey`;
 *  with `darwin`, the Developer ID identity and its password are opened too, as files in $CREDENTIALS_DIRECTORY that
 *  publish hands rcodesign by path (publish-an-engine-release.mjs `publishDarwin`). */
export function receiverUnit({ hasToken, sshKey = false, darwin = false }) {
  return `[Unit]
Description=Publishes a signed engine release for each push it receives
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${B.user}
Group=${B.user}
Environment=PATH=${PATH}
Environment=HOME=${B.home}
${sshKey ? `Environment="GIT_SSH_COMMAND=${GIT_SSH}"\n` : ''}${darwin ? Object.values(D.credentials).map(name => `LoadCredentialEncrypted=${name}:${credential(name)}\n`).join('') : ''}${hasToken ? `LoadCredentialEncrypted=repository-token:${credential('repository-token')}\n` : ''}LoadCredentialEncrypted=push-secret:${credential('push-secret')}
ExecStart=/bin/sh -c 'exec node ${toolFile('receive-pushes.mjs')} serve ${B.config_file} 3<${hasToken ? '"$CREDENTIALS_DIRECTORY/repository-token"' : '/dev/null'} 4<"$CREDENTIALS_DIRECTORY/push-secret"'
Restart=on-failure
RestartSec=5
UMask=0022
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${B.home} ${B.feed_folder}
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

async function feedStatus(hostName, fetchImpl) {
  try { return (await fetchImpl(`https://${hostName}${settings.feed_path}${settings.feed_file}`, { signal: AbortSignal.timeout(10000) })).status; }
  catch { return null; }
}

/** Make the machine the builder and start receiving pushes; answers the public key and where to point the webhook. */
export async function installBuilder(request, { token = '', secret = '', identity = '', identityPassword = '', run = onMachine, tarball = shippedTarball, sdk = file => createReadStream(file), fetchImpl = fetch } = {}) {
  checkRequest(request);
  if (!secret) throw refuse('Descriptor 4 holds no push secret: hand the webhook secret from the person\'s vault on descriptor 4 (the same secret goes in the repository\'s webhook).');
  const darwin = request.darwin ? developerIdentity(identity, identityPassword) : null;
  if (darwin && !existsSync(request.darwin.sdk)) throw refuse(`darwin.sdk ${request.darwin.sdk} is not on this computer.`);
  const machine = { ssh: request.ssh, address: request.builder.address };
  const setup = [request.builder.host_name, settings.receiver_port, settings.feed_path, settings.push_path, B.user, B.home, B.feed_folder, B.state_folder, settings.node_major_at_least, settings.node_dist, settings.rustup_url, settings.entry_path];
  await run(machine, `sh -s -- ${setup.map(q).join(' ')}`, readFileSync(SETUP));
  const T = B.tool_folder;
  await run(machine, `rm -rf ${q(`${T}.new`)} && install -d -m 0755 ${q(`${T}.new`)} && tar -C ${q(`${T}.new`)} -xzf - && chmod -R a+rX,go-w ${q(`${T}.new`)} && rm -rf ${q(`${T}.old`)} && { test ! -e ${q(T)} || mv ${q(T)} ${q(`${T}.old`)}; } && mv ${q(`${T}.new`)} ${q(T)} && rm -rf ${q(`${T}.old`)}`, tarball());
  await run(machine, `install -d -m 0755 ${q(dirname(B.config_file))} && install -m 0644 /dev/stdin ${q(B.config_file)}`, `${JSON.stringify(builderConfig(request), null, 1)}\n`);
  const key = JSON.parse((await run(machine, `runuser -u ${q(B.user)} -- env PATH=${q(PATH)} node ${q(toolFile('publish-an-engine-release.mjs'))} make-key ${q(B.key_file)}`)).trim().split('\n').at(-1));
  const sshKey = overSsh(request.repository.url);
  const deployKey = sshKey
    ? (await run(machine, `runuser -u ${q(B.user)} -- sh -c ${q(`test -f ${q(B.repository_key_file)} || ssh-keygen -q -t ed25519 -N '' -C ${q(`${B.user}@${request.builder.host_name}`)} -f ${q(B.repository_key_file)}`)} && cat ${q(`${B.repository_key_file}.pub`)}`)).trim()
    : null;
  await run(machine, `install -d -m 0700 ${q(B.credentials_folder)} && umask 077 && systemd-creds encrypt --name=push-secret - ${q(credential('push-secret'))}`, secret);
  if (token) await run(machine, `umask 077 && systemd-creds encrypt --name=repository-token - ${q(credential('repository-token'))}`, token);
  else await run(machine, `rm -f ${q(credential('repository-token'))}`);
  if (darwin) {
    const targets = request.darwin.targets ?? D.targets;
    await run(machine, `sh -s -- ${[B.user, B.home, D.zig_folder, D.zig_wheel.version, D.zig_wheel.sha256.x86_64, D.zig_wheel.sha256.aarch64, D.cargo_zigbuild, D.apple_codesign, ...targets].map(q).join(' ')}`, readFileSync(SETUP_DARWIN));
    // The SDK, from the person's computer: unpacked beside, checked to be an SDK, then moved to its folder.
    const S = D.sdk_folder;
    await run(machine, `rm -rf ${q(`${S}.new`)} && install -d -m 0755 ${q(`${S}.new`)} && tar -C ${q(`${S}.new`)} --strip-components=1 --no-same-owner -xJf - && test -f ${q(`${S}.new/SDKSettings.json`)} && test -d ${q(`${S}.new/System/Library/Frameworks/Security.framework`)} && chmod -R a+rX,go-w ${q(`${S}.new`)} && rm -rf ${q(S)} && mv ${q(`${S}.new`)} ${q(S)}`, sdk(request.darwin.sdk));
    await run(machine, `umask 077 && systemd-creds encrypt --name=${q(D.credentials.identity)} - ${q(credential(D.credentials.identity))}`, darwin.identity);
    await run(machine, `umask 077 && systemd-creds encrypt --name=${q(D.credentials.password)} - ${q(credential(D.credentials.password))}`, darwin.password);
  } else await run(machine, `rm -f ${Object.values(D.credentials).map(name => q(credential(name))).join(' ')}`);
  await run(machine, `install -m 0644 /dev/stdin /etc/systemd/system/${q(`${B.service}.service`)}`, receiverUnit({ hasToken: Boolean(token), sshKey, darwin: Boolean(darwin) }));
  const active = (await run(machine, `systemctl daemon-reload && systemctl enable ${q(B.service)} >/dev/null 2>&1; systemctl restart ${q(B.service)} && sleep 2 && systemctl is-active ${q(B.service)}`)).trim();
  const host = request.builder.host_name;
  return {
    public_key: key.public_key, key_made: key.made, deploy_key: deployKey,
    feed_url: `https://${host}${settings.feed_path}${settings.feed_file}`, receiver_active: active === 'active', feed_status: await feedStatus(host, fetchImpl),
    webhook: { url: `https://${host}${settings.push_path}`, content_type: 'application/json', events: ['push'] },
    entries_url: `https://${host}${settings.entry_path}`, accept_entries_from: request.accept_entries_from ?? [],
    ...(darwin ? { darwin: { targets: request.darwin.targets ?? D.targets, team_id: request.darwin.team_id } } : {}),
  };
}

/** The Developer ID identity handed on descriptor 5 (the PKCS#12 file as base64, as a vault keeps a file) and its
 *  password on descriptor 6, checked for shape only; the bytes go to the builder on the SSH channel's standard input. */
export function developerIdentity(identity, password) {
  if (!identity) throw refuse('darwin needs the Developer ID Application identity: hand its .p12 as base64 on descriptor 5, read from the person\'s vault.');
  if (!password) throw refuse('darwin needs the .p12\'s password on descriptor 6, read from the person\'s vault.');
  const compact = identity.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw refuse('Descriptor 5 is not base64: hand the .p12 as base64 (base64 -i identity.p12).');
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length < 64 || bytes.length > D.identity_bytes_at_most || bytes[0] !== 0x30) throw refuse('Descriptor 5 is not a PKCS#12 file: export the Developer ID Application certificate with its private key from Keychain Access as .p12.');
  return { identity: bytes, password };
}

/** The receiver's state, the feed's newest release per target and the last run, read from the builder. */
export async function builderStatus(request, { run = onMachine, fetchImpl = fetch } = {}) {
  checkRequest(request);
  const machine = { ssh: request.ssh, address: request.builder.address };
  const active = (await run(machine, `systemctl is-active ${q(B.service)} || true`)).trim();
  const feed = readFeed((await run(machine, `cat ${q(`${B.feed_folder}/${settings.feed_file}`)} 2>/dev/null || true`)) || null);
  const lastRun = (await run(machine, `cat ${q(`${B.state_folder}/last-run.json`)} 2>/dev/null || true`)).trim();
  const lastEntries = (await run(machine, `for f in ${q(B.state_folder)}/last-entry-*.json; do test -f "$f" && cat "$f" && echo; done; true`)).trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const key = JSON.parse((await run(machine, `runuser -u ${q(B.user)} -- env PATH=${q(PATH)} node ${q(toolFile('publish-an-engine-release.mjs'))} public-key ${q(B.key_file)}`)).trim().split('\n').at(-1));
  const newest = {};
  for (const entry of feed.releases) if (!newest[entry.target] || entry.sequence > newest[entry.target].sequence) newest[entry.target] = entry;
  return {
    receiver_active: active === 'active', public_key: key.public_key ?? null, releases_held: feed.releases.length,
    newest: Object.values(newest).map(({ commit, sequence, target, urgent }) => ({ commit, sequence, target, urgent })),
    last_run: lastRun ? JSON.parse(lastRun) : null, last_entries: lastEntries, feed_status: await feedStatus(request.builder.host_name, fetchImpl),
  };
}

/** A request read from its file, its ssh paths resolved against the file's own folder. */
export function readRequest(file) {
  const request = JSON.parse(readFileSync(absolute(file, 'REQUEST_FILE'), 'utf8')), here = dirname(file);
  for (const key of ['known_hosts', 'identity_file']) if (typeof request.ssh?.[key] === 'string') request.ssh[key] = resolvePath(here, request.ssh[key]);
  if (typeof request.darwin?.sdk === 'string') request.darwin.sdk = resolvePath(here, request.darwin.sdk);
  return request;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [operation, first, ...rest] = process.argv.slice(2);
  try {
    if (!['install', 'status'].includes(operation) || !first || rest.length) throw refuse('usage: install-a-builder.mjs install REQUEST_FILE (repository token on fd 3, push secret on fd 4; with darwin, the Developer ID .p12 as base64 on fd 5 and its password on fd 6) | status REQUEST_FILE');
    const request = readRequest(resolvePath(first));
    const answer = operation === 'install'
      ? await installBuilder(request, { token: await privateInput(3), secret: await privateInput(4), ...(request.darwin ? { identity: await privateInput(5), identityPassword: await privateInput(6) } : {}) })
      : await builderStatus(request);
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exit ?? 1;
  }
}
