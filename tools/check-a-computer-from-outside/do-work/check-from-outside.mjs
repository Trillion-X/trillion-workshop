import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/check-a-computer-from-outside/do-work/check-from-outside.mjs
//
// tool:check-a-computer-from-outside: what anyone on the internet can see of one computer, compared with what its row
// declares. Input { name, address, declared_ports?: ["22/tcp", 443, ...], names?: ["app.example.com"], also_try?: [ports] }; answer
// { name, address, checked_at, ports: [{port, open, declared}], certificates: [{name, not_after, days_left, issuer}],
// ssh: {port, banner} | null, domains: [{domain, expires, days_left}], rtt_ms: {tcp, tls}, findings: [{computer, at, kind, about, said}] }.
//
// Every connection goes through the run's own proxy (HTTPS_PROXY, a CONNECT tunnel per connection), the only way a
// sandboxed run reaches the network; with no proxy (a test, or a person's own shell) it connects directly. Nothing is
// logged in to, nothing is written, and no value is held: it reads only what the computer shows every scanner. What it
// tries and what counts as a finding are rows of settings.json. A port is a finding when it is open and undeclared, or
// declared and closed; a certificate or domain within its warning days, or unreadable, is a finding.
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { text } from 'node:stream/consumers';

const SETTINGS = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const DAY = 86_400_000;

/** A socket to host:port, through the proxy when there is one: resolves {socket, ms} or rejects with the reason. */
export function open(host, port, { proxy = process.env.HTTPS_PROXY, timeout = SETTINGS.connect_timeout_ms } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const target = proxy ? new URL(proxy) : null;
    const socket = target ? net.connect(Number(target.port), target.hostname) : net.connect(port, host);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('no answer in time')); }, timeout);
    const done = () => { clearTimeout(timer); resolve({ socket, ms: Math.round(performance.now() - started) }); };
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    if (!target) return socket.once('connect', done);
    socket.once('connect', () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    let head = Buffer.alloc(0);
    const answer = chunk => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', answer);
      const status = head.subarray(0, end).toString('latin1').split(' ')[1];
      if (status !== '200') { clearTimeout(timer); socket.destroy(); return reject(new Error(`closed (the proxy answered ${status})`)); }
      const rest = head.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      done();
    };
    socket.on('data', answer);
  });
}

const portOf = value => Number(String(value).split('/')[0]);

/** Each port of `ports`, at most `most` at once: [{port, open, ms?}]. */
async function tryPorts(host, ports, options) {
  const results = [];
  const queue = [...ports];
  const worker = async () => {
    for (let port; (port = queue.shift()) !== undefined;) {
      try { const { socket, ms } = await open(host, port, options); socket.destroy(); results.push({ port, open: true, ms }); }
      catch { results.push({ port, open: false }); }
    }
  };
  await Promise.all(Array.from({ length: SETTINGS.most_at_once }, worker));
  return results.sort((a, b) => a.port - b.port);
}

/** The certificate `name` is served under on host:port, and how long the handshake took. */
async function certificate(host, name, options) {
  const { socket, ms: tcp } = await open(host, SETTINGS.tls_port, options);
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: name, rejectUnauthorized: false }, () => {
      const cert = secure.getPeerCertificate();
      const notAfter = cert?.valid_to ? new Date(cert.valid_to) : null;
      resolve({ name, not_after: notAfter?.toISOString() ?? null, days_left: notAfter ? Math.floor((notAfter - Date.now()) / DAY) : null,
        issuer: cert?.issuer?.O ?? cert?.issuer?.CN ?? null, trusted: secure.authorized || (secure.authorizationError === undefined), why_not_trusted: secure.authorizationError ?? null,
        rtt_ms: { tcp, tls: Math.round(performance.now() - started) } });
      secure.end();
    });
    secure.once('error', reject);
    secure.setTimeout(SETTINGS.connect_timeout_ms, () => { secure.destroy(); reject(new Error('no TLS answer in time')); });
  });
}

/** The first line an SSH server says (its version), or null. */
async function sshBanner(host, port, options) {
  const { socket } = await open(host, port, options);
  return new Promise(resolve => {
    let said = '';
    const end = value => { socket.destroy(); resolve(value); };
    socket.on('data', chunk => { said += chunk.toString('latin1'); const line = said.split('\r\n')[0]; if (said.includes('\n')) end(line.startsWith('SSH-') ? line.trim() : null); });
    socket.setTimeout(SETTINGS.connect_timeout_ms, () => end(null));
    socket.on('error', () => end(null));
  });
}

/** A domain's registration expiry from its registry's RDAP answer (rdap.org finds the registry). */
async function domainExpiry(domain, options) {
  const url = new URL(SETTINGS.rdap + encodeURIComponent(domain));
  const { socket } = await open(url.hostname, 443, options);
  const secure = tls.connect({ socket, servername: url.hostname });
  const get = async (path, host, hops = 0) => {
    const stream = hops === 0 ? secure : tls.connect({ socket: (await open(host, 443, options)).socket, servername: host });
    stream.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: application/rdap+json\r\nUser-Agent: check-a-computer-from-outside\r\nConnection: close\r\n\r\n`);
    const raw = await text(stream);
    const [head, ...rest] = raw.split('\r\n\r\n');
    const status = Number(head.split(' ')[1]);
    const location = /\r\nlocation:\s*(\S+)/i.exec(head)?.[1];
    if (status >= 300 && status < 400 && location && hops < 3) { const next = new URL(location, `https://${host}`); return get(next.pathname + next.search, next.hostname, hops + 1); }
    const body = /\r\ntransfer-encoding:\s*chunked/i.test(head) ? unchunk(rest.join('\r\n\r\n')) : rest.join('\r\n\r\n');
    if (status !== 200) throw Object.assign(new Error(`the registry answered ${status}`), { status });
    return JSON.parse(body);
  };
  const answer = await get(url.pathname, url.hostname);
  const expiry = (answer.events ?? []).find(event => event.eventAction === 'expiration')?.eventDate;
  return { domain, expires: expiry ?? null, days_left: expiry ? Math.floor((new Date(expiry) - Date.now()) / DAY) : null };
}
function unchunk(body) {
  let out = ''; let rest = body;
  for (;;) {
    const line = rest.indexOf('\r\n'); if (line < 0) break;
    const size = parseInt(rest.slice(0, line), 16); if (!size) break;
    out += rest.slice(line + 2, line + 2 + size); rest = rest.slice(line + 2 + size + 2);
  }
  return out;
}

/** The registration a name stands under: the registry is asked for the name itself, then for each parent in turn, until
 *  one is registered; a status of settings.json `not_registered_statuses` says the name asked is not (measured Nov 18 2026
 *  through rdap.org: www.bbc.co.uk 404 then bbc.co.uk 200; a www. name under .ai 400 then its domain 200;
 *  www.unimelb.edu.au 400 then unimelb.edu.au 200). So which label is registered is the registry's own word, never a list
 *  of second levels. The last label alone is never asked. `asked` keeps each answer, so two names under one domain ask it
 *  once; `ask` is domainExpiry unless a caller gives its own. */
export async function registrationOf(name, ask, asked = new Map()) {
  const labels = name.toLowerCase().replace(/\.$/, '').split('.');
  let last = new Error(`${name} has no parent a registry could hold`);
  for (let at = 0; at < labels.length - 1; at += 1) {
    const domain = labels.slice(at).join('.');
    if (!asked.has(domain)) asked.set(domain, ask(domain).then(found => ({ found }), error => ({ error })));
    const { found, error } = await asked.get(domain);
    if (found) return found;
    if (!SETTINGS.not_registered_statuses.includes(error.status)) throw error;
    last = error;
  }
  throw last;
}

/** The check of one computer: what is open, served and registered, and the findings against what its row declares. */
export async function checkFromOutside({ name, address, declared_ports: declared = [], names = [], also_try = [] } = {}, options = {}) {
  if (typeof address !== 'string' || !address) throw new Error('address is the computer\'s public address.');
  const declaredPorts = new Set(declared.map(portOf).filter(Number.isInteger));
  const ports = await tryPorts(address, [...new Set([...SETTINGS.ports_to_try, ...declaredPorts, ...also_try.map(portOf).filter(Number.isInteger)])], options);
  const findings = [];
  for (const { port, open } of ports) {
    const isDeclared = declaredPorts.has(port);
    if (open && !isDeclared) findings.push({ kind: 'undeclared-open-port', about: String(port), said: `Port ${port} answers from the internet, and the computer's row does not declare it.` });
    if (!open && isDeclared) findings.push({ kind: 'declared-port-closed', about: String(port), said: `Port ${port} is declared but does not answer from the internet.` });
  }
  const certificates = [];
  for (const host of names) {
    try {
      const cert = await certificate(address, host, options);
      certificates.push(cert);
      if (cert.days_left === null || cert.days_left < SETTINGS.certificate_warn_days) findings.push({ kind: 'certificate-ends-soon', about: host, said: `${host}'s certificate ends ${cert.not_after ?? 'at an unreadable time'} (${cert.days_left} days).` });
      if (cert.why_not_trusted) findings.push({ kind: 'certificate-not-trusted', about: host, said: `${host}'s certificate is not trusted: ${cert.why_not_trusted}.` });
    } catch (error) { findings.push({ kind: 'certificate-unreadable', about: host, said: `${host} served no readable certificate on ${address}: ${error.message}.` }); }
  }
  const sshPort = ports.find(port => port.open && port.port === 22) ? 22 : null;
  const ssh = sshPort ? { port: sshPort, banner: await sshBanner(address, sshPort, options).catch(() => null) } : null;
  const domains = [];
  const asked = new Map();
  const ask = options.registry ?? (domain => domainExpiry(domain, options));
  for (const host of [...new Set(names)]) {
    try {
      const found = await registrationOf(host, ask, asked);
      if (domains.some(kept => kept.domain === found.domain)) continue;
      domains.push(found);
      if (found.days_left === null || found.days_left < SETTINGS.domain_warn_days) findings.push({ kind: 'domain-ends-soon', about: found.domain, said: `${found.domain} is registered until ${found.expires ?? 'an unreadable date'} (${found.days_left} days).` });
    } catch (error) { findings.push({ kind: 'domain-unreadable', about: host, said: `${host}'s registration could not be read: ${error.message}.` }); }
  }
  const firstOpen = ports.find(port => port.open);
  const checkedAt = new Date().toISOString();
  // Each finding names its computer and when it was seen, so it can be told on its own.
  const named = findings.map(finding => ({ computer: name ?? address, at: checkedAt, ...finding }));
  return { name: name ?? address, address, checked_at: checkedAt, ports, certificates, ssh, domains,
    rtt_ms: { tcp: firstOpen?.ms ?? null, tls: certificates[0]?.rtt_ms?.tls ?? null }, findings: named };
}

const startedAsProgram = (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]));
if (startedAsProgram) {
  try {
    const input = JSON.parse((await text(process.stdin)) || '{}');
    console.log(JSON.stringify({ result: await checkFromOutside(input) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
