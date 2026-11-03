// Reach a rented Linux host as its administrator over SSH: one checked host, one pinned host key, one held key file.
// Moved here from Trillion-X/trillion scripts/portable-service-connection.mjs (administrationArguments) so every tool
// that administers the same host packs this one copy. The connection is the caller's: { address, ssh_port, admin_user,
// adminKeyFile, knownHostsFile } and, to pin it from the request, host_key. This file names no host, port or user.

const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST_KEY = /^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}$/;

export const port = value => Number.isSafeInteger(value) && value > 0 && value <= 65535;

// A host as given: { address, ssh_port, admin_user, host_key? }. Answers it, or throws saying which field to fix.
export function checkedHost(host) {
  if (!host || typeof host !== 'object') throw new Error('host is missing: give { address, ssh_port, admin_user, host_key }.');
  if (typeof host.address !== 'string' || !(IPV4.test(host.address) || NAME.test(host.address))) throw new Error('host.address was refused: give an IPv4 address (192.0.2.10) or a lowercase DNS name (build.example.com).');
  if (!port(host.ssh_port)) throw new Error('host.ssh_port was refused: give a whole number from 1 to 65535.');
  if (typeof host.admin_user !== 'string' || !USER.test(host.admin_user)) throw new Error('host.admin_user was refused: give a Linux user name (lowercase letters, digits, _ or -, at most 32).');
  if (host.host_key !== undefined && (typeof host.host_key !== 'string' || !HOST_KEY.test(host.host_key))) throw new Error('host.host_key was refused: give the host\'s public key as "<type> <base64>", e.g. "ssh-ed25519 AAAA...".');
  return host;
}

// The one known_hosts line that pins this host: OpenSSH writes "[address]:port" for any port but 22.
export function knownHostsLine(host) {
  checkedHost(host);
  if (host.host_key === undefined) throw new Error('host.host_key is missing: give the host\'s public key to pin.');
  return `${host.ssh_port === 22 ? host.address : `[${host.address}]:${host.ssh_port}`} ${host.host_key}\n`;
}

function checked(c) {
  checkedHost(c);
  if (typeof c.knownHostsFile !== 'string' || !c.knownHostsFile) throw new Error('The known-hosts file is missing: write knownHostsLine(host) to a private file and name it as knownHostsFile.');
  return c;
}

// The ssh arguments, before the remote command, that reach the host as its administrator with only c.adminKeyFile and
// only the pinned key in c.knownHostsFile: no agent, no password, no prompt, no new host key accepted.
export function administrationArguments(c) {
  checked(c);
  if (!c.adminKeyFile) throw new Error('The host administration identity was refused.');
  return ['-T', '-p', String(c.ssh_port), '-i', c.adminKeyFile, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${c.knownHostsFile}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10', `${c.admin_user}@${c.address}`];
}
