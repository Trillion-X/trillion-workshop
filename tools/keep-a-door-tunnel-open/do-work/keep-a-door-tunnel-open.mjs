// Retained outbound service connection: one server-loopback listener, one loopback door on this computer, pinned host key.
// The dedicated credential stays in the vault and reaches SSH only on a private descriptor.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';

// The descriptor the held connection key arrives on: the row's credential_mounts fd, or the launch agent's pipe.
export const keyDescriptor = 4;

function checked(c) {
  const port = n => Number.isSafeInteger(n) && n > 0 && n <= 65535;
  if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(c.address) || !/^[a-z][a-z0-9-]{1,30}$/.test(c.user) || !port(c.remotePort) || !port(c.localPort) || !c.knownHostsFile) throw new Error('The service connection configuration was refused.');
  return c;
}
export function connectionArguments(c, { identityFile = c.publicKeyFile ?? `${dirname(c.knownHostsFile)}/identity-public-key`, agentSocket } = {}) {
  checked(c);
  return ['-N', '-T', '-i', identityFile, ...(agentSocket ? ['-o', `IdentityAgent=${agentSocket}`] : []), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${c.knownHostsFile}`, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10', '-R', `127.0.0.1:${c.remotePort}:127.0.0.1:${c.localPort}`, `${c.user}@${c.address}`];
}
export function makeConnectionKey(comment) {
  if (!/^[a-zA-Z0-9-]+$/.test(comment)) throw new Error('The connection key comment was refused: give letters, digits and hyphens.');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const parts = publicKey.export({ format: 'jwk' });
  const field = value => { const n = Buffer.alloc(4); n.writeUInt32BE(value.length); return Buffer.concat([n, value]); };
  const integer = value => { const b = Buffer.from(value, 'base64url'); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  return { privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }), publicKey: `ssh-rsa ${Buffer.concat([field(Buffer.from('ssh-rsa')), field(integer(parts.e)), field(integer(parts.n))]).toString('base64')} ${comment}` };
}
export function pinHost(c, { run = execFileSync } = {}) {
  checked(c);
  if (existsSync(c.knownHostsFile)) return c.knownHostsFile;
  const answer = run('/usr/bin/ssh-keyscan', ['-T', '5', '-t', 'ed25519', c.address], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 });
  const lines = answer.split('\n').filter(line => line.startsWith(`${c.address} ssh-ed25519 `));
  if (lines.length !== 1 || !/^[0-9.]+ ssh-ed25519 [A-Za-z0-9+/=]+$/.test(lines[0])) throw new Error('The host did not give one SSH key.');
  mkdirSync(dirname(c.knownHostsFile), { recursive: true, mode: 0o700 });
  writeFileSync(c.knownHostsFile, `${lines[0]}\n`, { mode: 0o600, flag: 'wx' });
  return c.knownHostsFile;
}
export function administrationArguments(c) {
  checked(c);
  if (!c.adminKeyFile) throw new Error('The host administration identity was refused.');
  return ['-T', '-i', c.adminKeyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${c.knownHostsFile}`, '-o', 'ConnectTimeout=10', `root@${c.address}`];
}
export function prepareConnectionHost(c, publicKey, { run = execFileSync } = {}) {
  checked(c);
  if (!/^ssh-rsa [A-Za-z0-9+/=]+(?: [a-zA-Z0-9-]+)?$/.test(publicKey)) throw new Error('The public service key was refused.');
  const script = readFileSync(new URL('./prepare-a-tunnel-host.sh', import.meta.url), 'utf8');
  const input = `service_user='${c.user}'\nservice_port='${c.remotePort}'\nservice_public_key='${publicKey}'\n${script}`;
  return run('/usr/bin/ssh', [...administrationArguments(c), '/bin/sh', '-s'], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 240000, maxBuffer: 1024 * 1024 });
}
export async function startConnectionAgent() {
  const directory = mkdtempSync(join(tmpdir(), 'door-tunnel-agent-')), socket = join(directory, 'agent.sock');
  const child = spawn('/usr/bin/ssh-agent', ['-D', '-a', socket], { stdio: 'ignore' });
  let failed = false; child.once('error', () => { failed = true; }); child.once('exit', () => { failed = true; });
  for (let n = 0; !existsSync(socket) && !failed && n < 250; n++) await new Promise(resolve => setTimeout(resolve, 20));
  if (!existsSync(socket) || failed) { child.kill('SIGTERM'); rmSync(directory, { recursive: true, force: true }); throw new Error('The private SSH credential process could not start.'); }
  return { socket, add(key) { const env = { SSH_AUTH_SOCK: socket }; execFileSync('/usr/bin/ssh-add', ['-D'], { env, stdio: 'pipe', timeout: 5000 }); execFileSync('/usr/bin/ssh-add', ['-'], { input: key, env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }); }, close() { child.kill('SIGTERM'); rmSync(directory, { recursive: true, force: true }); } };
}
export async function serveConnection(c, credential, { spawnImpl = spawn, agentOwner = startConnectionAgent, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), stopped = () => false, signal, report = () => {} } = {}) {
  checked(c);
  const agent = await agentOwner();
  const args = connectionArguments(c, { identityFile: c.publicKeyFile ?? `${dirname(c.knownHostsFile)}/identity-public-key`, agentSocket: agent.socket });
  try {
  while (!stopped() && !signal?.aborted) {
    const key = await credential();
    let valid = false;
    try { valid = typeof key === 'string' && createPrivateKey(key).asymmetricKeyType === 'rsa'; } catch {}
    if (!valid) throw new Error('The service connection credential was refused.');
    if (signal?.aborted) return;
    agent.add(key);
    const child = spawnImpl('/usr/bin/ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    let said = '';
    child.stderr.on('data', bytes => { if (said.length < 4096) said += bytes.toString().slice(0, 4096 - said.length); });
    const code = await new Promise(resolve => { child.once('error', () => resolve(null)); child.once('exit', resolve); });
    signal?.removeEventListener('abort', abort);
    const cause = /Permission denied/.test(said) ? 'SSH authentication was refused' : /Load key|identity file/.test(said) ? 'SSH could not read the held connection key' : /remote port forwarding failed/.test(said) ? 'The server loopback listener could not be attached' : /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(said) ? 'The pinned server host key was refused' : /Connection refused|timed out|No route to host|Connection reset/.test(said) ? 'The server connection is unavailable' : 'The SSH connection ended';
    report({ connected_process_ended: true, exit_code: code, cause });
    if (!stopped() && !signal?.aborted) await wait(2000);
  }
  } finally { agent.close(); }
}
// The launch agent's own command: bash reads the held key with the vault command the configuration names (which writes
// a value only to its descriptor 3) and hands it to this file on keyDescriptor, the configuration on standard input.
export function connectionLaunchArguments({ nodeExecutable, script, configFile, credentialCommand }) {
  if ([nodeExecutable, script, configFile].some(value => typeof value !== 'string' || !value.startsWith('/')) || !Array.isArray(credentialCommand) || !credentialCommand.length || !credentialCommand[0].startsWith('/') || credentialCommand.some(value => typeof value !== 'string')) throw new Error('The connection supervisor configuration was refused.');
  return ['/bin/bash', '-c', `config=$1 node=$2 script=$3; shift 3; exec "$node" "$script" serve <"$config" ${keyDescriptor}< <(exec "$@" 3>&1 >/dev/null)`, 'keep-a-door-tunnel-open', configFile, nodeExecutable, script, ...credentialCommand];
}
export function connectionLaunchAgent({ label, programArguments, environment = {}, logFile }) {
  if (!/^[a-z][a-z0-9.-]+$/.test(label) || typeof logFile !== 'string' || !logFile.startsWith('/') || !Array.isArray(programArguments) || !programArguments.length || [...programArguments, ...Object.values(environment)].some(value => typeof value !== 'string') || Object.keys(environment).some(name => !/^[A-Z_][A-Z0-9_]*$/.test(name))) throw new Error('The connection supervisor configuration was refused.');
  const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const variables = Object.entries(environment).map(([name, value]) => `<key>${name}</key><string>${xml(value)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${programArguments.map(value => `<string>${xml(value)}</string>`).join('')}</array>${variables ? `<key>EnvironmentVariables</key><dict>${variables}</dict>` : ''}<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(logFile)}</string><key>StandardErrorPath</key><string>${xml(logFile)}</string></dict></plist>\n`;
}
export function installConnection(configFile, { label, credentialCommand, environment, nodeExecutable, uid, home = homedir(), run = execFileSync } = {}) {
  checked(JSON.parse(readFileSync(configFile, 'utf8')));
  const folder = `${home}/Library/LaunchAgents`, file = `${folder}/${label}.plist`;
  const definition = connectionLaunchAgent({ label, programArguments: connectionLaunchArguments({ nodeExecutable, script: fileURLToPath(import.meta.url), configFile, credentialCommand }), environment, logFile: `${dirname(configFile)}/${basename(configFile, '.json')}.log` });
  mkdirSync(folder, { recursive: true }); writeFileSync(file, definition, { mode: 0o600 });
  try { run('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'pipe' }); } catch (error) { if (!/No such process|Could not find service/.test(String(error.stderr))) throw error; }
  run('/bin/launchctl', ['bootstrap', `gui/${uid}`, file], { stdio: 'pipe' });
  return { label, supervisor: 'launchd', definition: file };
}
if (typeof process !== 'undefined' && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'install' && process.argv.length >= 6) {
    const [configFile, label, ...credentialCommand] = process.argv.slice(3);
    process.stdout.write(`${JSON.stringify(installConnection(resolve(configFile), { label, credentialCommand, nodeExecutable: process.execPath, uid: process.getuid() }))}\n`);
  } else {
  if (process.argv[2] !== 'serve' || process.argv.length !== 3) throw new Error(`usage: keep-a-door-tunnel-open.mjs install CONFIG_FILE LABEL CREDENTIAL_COMMAND [ARGUMENTS...] | serve (the configuration on standard input, the held key on descriptor ${keyDescriptor})`);
  const config = JSON.parse(readFileSync(0, 'utf8'));
  const key = readFileSync(keyDescriptor, 'utf8');
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
  await serveConnection(config, async () => key, { signal: stop.signal, report: row => process.stderr.write(`${JSON.stringify(row)}\n`) });
  }
}
