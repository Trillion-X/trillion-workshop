// harness/wake-handlers/egress-proxy.mjs
//
// Purpose
//   The one door a Marketplace tool run's internet traffic goes through when its reach is `network-hosts`: a loopback HTTP
//   proxy that lets the run reach only the hosts its declaration names and records every decision. The sandbox profile
//   (tool-reach.json) lets the run connect to nothing but this proxy, so a tool cannot go round it.
//
// Non-negotiable invariants
//   1. A host is allowed only when a declared pattern matches it: an exact name, or `*.name` for any name under it.
//   2. Every request is decided and recorded ({ at, method, host, port, allowed, rule }) before any byte is sent on, in the
//      order it was made; a denied request is answered 403 and sends nothing out.
//   3. The proxy names no host: the patterns are the tool's declared reach.
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** The pattern that allows a host, or null: `example.com` is that name only, `*.example.com` any name under it. */
export function ruleFor(host, patterns) {
  const name = String(host).toLowerCase().replace(/\.$/, '');
  return patterns.find(pattern => (pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1 : name === pattern)) ?? null;
}

/** Declared hosts text ("a.com, *.b.com") as patterns. */
export const patternsOf = text => String(text ?? '').split(',').map(part => part.trim().toLowerCase()).filter(Boolean);

/** Starts the proxy on a free loopback port: { port, decisions(), close() }. */
export function egressProxy({ hosts, now = () => new Date().toISOString() }) {
  const patterns = [...new Set(hosts.flatMap(patternsOf))];
  const log = [];
  const decide = (method, host, port) => {
    const rule = ruleFor(host, patterns);
    log.push({ at: now(), method, host, port, allowed: rule !== null, rule });
    return rule !== null;
  };
  const server = createServer((request, response) => {
    let target;
    try { target = new URL(request.url); } catch { response.writeHead(400).end(); return; }
    if (!decide(request.method, target.hostname, Number(target.port) || 80)) { response.writeHead(403, { 'content-type': 'text/plain' }).end('This tool did not declare that host.'); return; }
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP.has(name)));
    const onward = httpRequest({ host: target.hostname, port: target.port || 80, method: request.method, path: `${target.pathname}${target.search}`, headers }, answer => {
      response.writeHead(answer.statusCode, Object.fromEntries(Object.entries(answer.headers).filter(([name]) => !HOP.has(name))));
      answer.pipe(response);
    });
    onward.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(onward);
  });
  server.on('connect', (request, client, head) => {
    const [host, port = '443'] = request.url.split(/:(?=\d+$)/);
    if (!decide('CONNECT', host, Number(port))) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const onward = connect(Number(port), host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); onward.write(head); onward.pipe(client); client.pipe(onward); });
    onward.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    client.on('error', () => onward.destroy());
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done({ port: server.address().port, decisions: () => log.slice(), close: () => new Promise(closed => { server.closeAllConnections?.(); server.close(() => closed()); }) }));
  });
}
