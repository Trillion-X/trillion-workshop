// tools/renew-a-tls-certificate/do-work/host-administration.mjs
//
// How a tool reaches a server it administers: ssh as root to the server's address, only with the one identity it is
// handed (IdentitiesOnly), never asking anyone (BatchMode), only with the server's pinned key (StrictHostKeyChecking
// and the one known host), giving up after ten seconds. A run whose internet is the engine's loopback proxy (its
// HTTPS_PROXY) reaches the server through a CONNECT tunnel of that proxy (the system nc of macOS), and a keepalive
// every 30 seconds keeps a long quiet step (a DNS-01 wait) from looking idle to the proxy. Moved from the older owner's
// portable-service-connection.mjs, whose tunnel keeps its own ports.
function checked(c) {
  if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(c.address) || typeof c.knownHostsFile !== 'string' || !c.knownHostsFile) throw new Error('The host administration address was refused.');
  return c;
}
// The ssh options that reach the host through the run's proxy, when the run has one (http://127.0.0.1:<port>).
export function proxied(proxy) {
  const keepalive = ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4'];
  if (!proxy) return keepalive;
  const { protocol, hostname, port } = URL.parse(proxy) ?? {};
  if (protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(hostname) || !/^[0-9]{1,5}$/.test(port)) throw new Error('The run\'s proxy setting was refused.');
  return ['-o', `ProxyCommand=/usr/bin/nc -X connect -x ${hostname}:${port} %h %p`, ...keepalive];
}
export function administrationArguments(c) {
  checked(c);
  if (!c.adminKeyFile) throw new Error('The host administration identity was refused.');
  return [...proxied(process.env.HTTPS_PROXY ?? process.env.https_proxy), '-T', '-i', c.adminKeyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${c.knownHostsFile}`, '-o', 'ConnectTimeout=10', `root@${c.address}`];
}
