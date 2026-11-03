// A stand-in for the engine's loopback proxy, for samples of rows with internet: true (settings in
// stand-in-egress.json). It answers a plain request by its absolute address, and a CONNECT by finishing TLS itself with
// a certificate for the asked host, signed by a certificate authority made once for this test run, then reading the
// request inside. Each request is answered from the replies the sample recorded, by method and address; a request with
// no recorded reply is refused (502) and named in `unanswered`, and nothing reaches the network. Read by
// test-helpers/run-a-row.mjs. Nothing here names a tool or a service.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, TLSSocket } from 'node:tls';

export const settings = JSON.parse(readFileSync(new URL('./stand-in-egress.json', import.meta.url), 'utf8'));

const openssl = (...args) => {
  const done = spawnSync('openssl', args, { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`openssl ${args[0]} failed: ${done.stderr.trim()}`);
};

// The test run's certificate authority, made once per process: { folder, certificate, key, contexts }.
let authority;
function authorityOnce() {
  if (authority) return authority;
  const folder = mkdtempSync(join(realpathSync(tmpdir()), 'stand-in-authority-'));
  const config = join(folder, 'authority.cnf');
  writeFileSync(config, '[req]\ndistinguished_name = name\n[name]\n[authority]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\n');
  const certificate = join(folder, 'authority.pem'), key = join(folder, 'authority.key');
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '2',
    '-subj', '/CN=Workshop sample authority', '-config', config, '-extensions', 'authority');
  authority = { folder, certificate, key, contexts: new Map() };
  return authority;
}

// A TLS context holding a certificate for `host`, signed by the authority; made once per host.
function contextFor(host) {
  const { folder, certificate, key, contexts } = authorityOnce();
  if (!contexts.has(host)) {
    const name = host.replace(/[^A-Za-z0-9.-]/g, '_');
    const extensions = join(folder, `${name}.ext`);
    writeFileSync(extensions, `subjectAltName = ${isIP(host) ? 'IP' : 'DNS'}:${host}\nextendedKeyUsage = serverAuth\n`);
    const [leafKey, request, leaf] = ['key', 'csr', 'pem'].map(suffix => join(folder, `${name}.${suffix}`));
    openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', leafKey, '-out', request, '-subj', `/CN=${host}`);
    openssl('x509', '-req', '-in', request, '-CA', certificate, '-CAkey', key, '-CAcreateserial', '-out', leaf, '-days', '2', '-extfile', extensions);
    contexts.set(host, createSecureContext({ key: readFileSync(leafKey), cert: readFileSync(leaf) }));
  }
  return contexts.get(host);
}

// The recorded reply for one request: a reply whose url has no query answers any query of that address.
const replyFor = (replies, method, address) => {
  const url = new URL(address);
  const bare = `${url.origin}${url.pathname}`;
  return replies.find(reply => (reply.request.method ?? 'GET').toUpperCase() === method
    && (reply.request.url === url.href || (!reply.request.url.includes('?') && reply.request.url === bare)));
};

// Start one stand-in with `replies` ([{ request: { method, url }, status, headers?, body }]): { environment, unanswered,
// asked, close }. `environment` is what the program is started with.
export async function startStandInEgress(replies = []) {
  const { certificate } = authorityOnce();
  const asked = [], unanswered = [];
  const answer = (method, address, response) => {
    asked.push(`${method} ${address}`);
    const reply = replyFor(replies, method, address);
    if (!reply) {
      unanswered.push(`${method} ${address}`);
      response.writeHead(502, { 'content-type': 'text/plain' }).end(`no recorded reply for ${method} ${address}`);
      return;
    }
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? null);
    const headers = { 'content-type': typeof reply.body === 'string' ? 'text/plain' : 'application/json', ...(reply.headers ?? {}) };
    response.writeHead(reply.status ?? 200, headers).end(body);
  };
  // Requests inside a finished TLS tunnel: the address is the tunnel's host and the request's path.
  const inside = createServer((request, response) => answer(request.method, `https://${request.headers.host}${request.url}`, response));
  const proxy = createServer((request, response) => answer(request.method, request.url, response));
  proxy.on('connect', (request, socket) => {
    const host = request.url.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const tunnel = new TLSSocket(socket, { isServer: true, secureContext: contextFor(host) });
    tunnel.on('error', () => {});
    inside.emit('connection', tunnel);
  });
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  const address = `http://127.0.0.1:${proxy.address().port}`;
  const environment = Object.fromEntries(Object.entries(settings.environment)
    .map(([name, value]) => [name, value.replace('{proxy}', address).replace('{authority}', certificate)]));
  return {
    environment, asked, unanswered,
    close: () => new Promise(done => { proxy.closeAllConnections?.(); inside.closeAllConnections?.(); proxy.close(() => done()); }),
  };
}

// Whether a sample's recorded replies are older than the settings allow, on `today` (YYYY-MM-DD): the reason, or null.
export function staleReplies(sample, today = new Date().toISOString().slice(0, 10)) {
  if (!sample.replies?.length) return null;
  if (typeof sample.shape_read_at !== 'string') return 'its recorded replies have no shape_read_at date';
  const days = (Date.parse(today) - Date.parse(sample.shape_read_at)) / 86_400_000;
  if (!(days <= settings.reply_good_for_days)) {
    return `its recorded replies were read on ${sample.shape_read_at}, more than ${settings.reply_good_for_days} days ago; read the reply shape again and renew shape_read_at`;
  }
  return null;
}
