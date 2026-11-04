// computer/capture-proxy.mjs
//
// PURPOSE
//   An HTTPS-capable capture proxy for the person's own programs: a program (or a browser) pointed at 127.0.0.1:<port> has its web
//   traffic read and kept as exchanges the person's AIs can study, using the certificate authority made on this computer
//   (computer/capture-ca.mjs). It runs as a process of its own (`node computer/capture-proxy.mjs serve`), so capture never shares a
//   process with the interface.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Loopback only: it listens on 127.0.0.1. Only a program the person pointed at it reaches it.
//   2. The authority is this computer's own (capture-ca.mjs); a site on `tunnel_hosts`, or outside a non-empty `only_hosts`, is passed
//      through as an opaque tunnel and its certificate is never replaced.
//   3. The upstream connection verifies the real site's certificate (DATA/override only for tests); capture never weakens it.
//   4. Kept exchanges never hold the values of `redact_headers`, and bodies are cut at `body_bytes` with the cut said.
//   5. Everything that varies is computer/capture-proxy.json; nothing here names a site or a program.
//
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { hostWithin } from '../parts/http-client/do-work/same-origin.mjs';
import { makeCaptureCa } from './capture-ca.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const captureProxySettings = () => JSON.parse(readFileSync(join(HERE, 'capture-proxy.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

export function makeCaptureProxy({ settings = captureProxySettings(), ca = makeCaptureCa(), onCapture = () => {}, upstreamTls = {}, now = () => Date.now() } = {}) {
  const redact = new Set(settings.redact_headers);
  const hop = new Set(settings.hop_headers);
  const headersOut = headers => Object.fromEntries(Object.entries(headers).filter(([name]) => !hop.has(name.toLowerCase())));
  const headersKept = headers => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, redact.has(name.toLowerCase()) ? settings.mask : value]));
  const captured = host => (settings.only_hosts.length ? settings.only_hosts.some(domain => hostWithin(host, domain)) : true)
    && !settings.tunnel_hosts.some(domain => hostWithin(host, domain));

  class Body {
    constructor() { this.pieces = []; this.size = 0; this.total = 0; }
    add(piece) { this.total += piece.length; if (this.size < settings.body_bytes) { const room = settings.body_bytes - this.size; const part = piece.length > room ? piece.subarray(0, room) : piece; this.pieces.push(part); this.size += part.length; } }
    kept() { return { base64: Buffer.concat(this.pieces).toString('base64'), bytes: this.total, cut: this.total > this.size }; }
  }

  function exchange({ scheme, host, port, request, reply }) {
    const began = now();
    const requestBody = new Body();
    const responseBody = new Body();
    const options = { host, port, method: request.method, path: request.url, headers: headersOut(request.headers), timeout: settings.timeout_ms, ...(scheme === 'https' ? { servername: host, ...upstreamTls } : {}) };
    const upstream = (scheme === 'https' ? https : http).request(options, answer => {
      reply.writeHead(answer.statusCode, headersOut(answer.headers));
      answer.on('data', piece => { responseBody.add(piece); reply.write(piece); });
      answer.on('end', () => {
        reply.end();
        onCapture({ id: randomBytes(8).toString('hex'), at: new Date(began).toISOString(), ms: now() - began, method: request.method, url: `${scheme}://${host}${port === (scheme === 'https' ? 443 : 80) ? '' : `:${port}`}${request.url}`,
          request: { headers: headersKept(request.headers), body: requestBody.kept() }, response: { status: answer.statusCode, headers: headersKept(answer.headers), body: responseBody.kept() } });
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', error => { if (!reply.headersSent) reply.writeHead(502, { 'content-type': 'text/plain' }); reply.end(fill(settings.words.upstream_failed, { host, error: error.message })); });
    request.on('data', piece => { requestBody.add(piece); upstream.write(piece); });
    request.on('end', () => upstream.end());
  }

  // Decrypted traffic of a CONNECT is plain HTTP on the TLS socket; this server reads it and forwards each request.
  const inner = http.createServer((request, reply) => {
    const target = request.socket._captureTarget;
    exchange({ scheme: 'https', host: target.host, port: target.port, request, reply });
  });

  const server = http.createServer((request, reply) => {
    let url;
    try { url = new URL(request.url); } catch { reply.writeHead(400).end(fill(settings.words.bad_target, { target: String(request.url).slice(0, 80) })); return; }
    if (url.protocol !== 'http:') { reply.writeHead(400).end(fill(settings.words.bad_target, { target: url.protocol })); return; }
    request.url = `${url.pathname}${url.search}`;
    exchange({ scheme: 'http', host: url.hostname, port: Number(url.port || 80), request, reply });
  });

  server.on('connect', (request, client, head) => {
    const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(request.url ?? '');
    if (!match) { client.end(`HTTP/1.1 400 Bad Request\r\n\r\n${fill(settings.words.bad_target, { target: String(request.url).slice(0, 80) })}`); return; }
    const host = match[1].replace(/^\[|\]$/g, '');
    const port = Number(match[2]);
    client.on('error', () => {});
    keep(client);
    if (!captured(host)) {
      const tunnel = keep(net.connect(port, host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); tunnel.write(head); tunnel.pipe(client); client.pipe(tunnel); }));
      tunnel.on('error', () => client.destroy());
      return;
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const secure = new tls.TLSSocket(client, { isServer: true, SNICallback: (name, done) => {
      try { done(null, tls.createSecureContext(ca.leafFor(name || host))); } catch (error) { done(error); }
    } });
    secure._captureTarget = { host, port };
    secure.on('error', () => {});
    if (head?.length) secure.unshift(head);
    inner.emit('connection', secure);
  });

  // Sockets of tunnels and of opened traffic are not the server's own, so they are kept to be closed with it.
  const open = new Set();
  const keep = socket => { open.add(socket); socket.on('close', () => open.delete(socket)); return socket; };

  return {
    server,
    listen: () => new Promise(done => { ca.ensure(); server.listen(settings.port, settings.host, () => done(server.address().port)); }),
    close: () => new Promise(done => { for (const socket of open) socket.destroy(); inner.closeAllConnections?.(); server.closeAllConnections?.(); server.close(() => done()); }),
  };
}

// The separate process: `node computer/capture-proxy.mjs serve` — kept exchanges are appended to the captures file (private).
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'serve') {
  const settings = captureProxySettings();
  const ca = makeCaptureCa();
  process.stdout.write(`${JSON.stringify(ca.ensure())}\n`);
  const file = join(homedir(), settings.captures_file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) { writeFileSync(file, '', { mode: 0o600 }); chmodSync(file, 0o600); }
  const proxy = makeCaptureProxy({ settings, ca, onCapture: entry => appendFileSync(file, `${JSON.stringify(entry)}\n`) });
  proxy.listen().then(port => process.stdout.write(`${JSON.stringify({ listening: `${settings.host}:${port}`, captures: file, certificate: ca.pemFile })}\n`));
}
