import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http2 from 'node:http2';
import net from 'node:net';

let root;
let certificate;
let proxy;
let server;
let proxyPort;
let serverPort;
const seenAlpn = [];
const connectTargets = [];
const sessions = new Set();
const proxySockets = new Set();
const serverSockets = new Set();
let acceptedProxySockets = 0;
let closedProxySockets = 0;
let proxyBytes = 0;

function listen(listener) {
  return new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      listener.removeListener('error', reject);
      resolve(listener.address().port);
    });
  });
}

function proxyTunnel(socket) {
  acceptedProxySockets += 1;
  proxySockets.add(socket);
  socket.once('close', () => { closedProxySockets += 1; proxySockets.delete(socket); });
  let bytes = Buffer.alloc(0);
  const readHead = chunk => {
    proxyBytes += chunk.length;
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 8 * 1024) {
      socket.destroy();
      return;
    }
    const end = bytes.indexOf('\r\n\r\n');
    if (end < 0) return;
    socket.removeListener('data', readHead);
    const head = bytes.subarray(0, end).toString('latin1');
    const rest = bytes.subarray(end + 4);
    const request = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/.exec(head.split('\r\n', 1)[0]);
    if (!request) {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    connectTargets.push(request[1]);
    const target = net.connect(serverPort, '127.0.0.1');
    target.once('error', () => socket.destroy());
    target.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length) target.write(rest);
      socket.pipe(target);
      target.pipe(socket);
    });
  };
  socket.on('data', readHead);
  socket.on('error', () => {});
}

async function setUp() {
  root = mkdtempSync(join(tmpdir(), 'notifications-http2-'));
  const key = join(root, 'test-key.pem');
  certificate = join(root, 'test-certificate.pem');
  execFileSync('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { timeout: 5_000, stdio: 'ignore' });

  server = http2.createSecureServer({
    key: (await import('node:fs')).readFileSync(key),
    cert: (await import('node:fs')).readFileSync(certificate),
    allowHTTP1: false,
    ALPNProtocols: ['h2'],
  });
  server.on('stream', (stream, headers) => {
    seenAlpn.push(stream.session.socket.alpnProtocol);
    const path = headers[':path'];
    if (path === '/stall') {
      stream.respond({ ':status': 200, 'content-type': 'text/plain' });
      return;
    }
    if (path === '/large') {
      const bytes = Buffer.alloc(64 * 1024 + 1, 0x61);
      stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
      stream.end(bytes);
      return;
    }
    if (path === '/redirect') {
      stream.respond({ ':status': 302, location: '/push', 'content-type': 'application/json' });
      stream.end('{}');
      return;
    }
    stream.respond({ ':status': 201, 'content-type': 'application/json' });
    stream.end(JSON.stringify({ alpn: stream.session.socket.alpnProtocol, method: headers[':method'], path }));
  });
  server.on('session', session => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  server.on('connection', socket => {
    serverSockets.add(socket);
    socket.once('close', () => serverSockets.delete(socket));
  });
  serverPort = await listen(server);

  proxy = net.createServer(proxyTunnel);
  proxyPort = await listen(proxy);
}

async function invokeChild(path, { proxyAt = proxyPort, proxyValue = null, proxyEnabled = true, trustCertificate = true, url = null, code = null, timeoutMs = '900' } = {}) {
  const helper = pathToFileURL(fileURLToPath(new URL('../read-data/http2-request.mjs', import.meta.url))).href;
  const script = code ?? `
    const { requestHttp2 } = await import(${JSON.stringify(helper)});
    try {
      const response = await requestHttp2(process.env.PROBE_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"probe":true}',
        timeoutMs: Number(process.env.PROBE_TIMEOUT_MS),
      });
      console.log(JSON.stringify({ status: response.status, ok: response.ok, body: await response.json() }));
    } catch (error) { console.log(JSON.stringify({ error: error.name, message: error.message })); }
  `;
  const env = {
    ...process.env,
    PROBE_URL: url ?? `https://127.0.0.1:${serverPort}${path}`,
    PROBE_TIMEOUT_MS: timeoutMs,
  };
  delete env.NODE_OPTIONS;
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  if (proxyEnabled) {
    env.HTTPS_PROXY = proxyValue ?? `http://127.0.0.1:${proxyAt}`;
    if (proxyValue === null) env.NODE_USE_ENV_PROXY = '1';
    else delete env.NODE_USE_ENV_PROXY;
  } else {
    delete env.HTTPS_PROXY;
    delete env.https_proxy;
    delete env.NODE_USE_ENV_PROXY;
  }
  if (trustCertificate) env.NODE_EXTRA_CA_CERTS = certificate;
  else delete env.NODE_EXTRA_CA_CERTS;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; if (stdout.length > 32 * 1024) child.kill('SIGKILL'); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; if (stderr.length > 32 * 1024) child.kill('SIGKILL'); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      if (status !== 0) { reject(new Error(`HTTP/2 probe exited ${status ?? signal}: ${stderr}`)); return; }
      try {
        const value = JSON.parse(stdout.trim());
        resolve(value);
      } catch (error) { reject(new Error(`HTTP/2 probe output was invalid: ${error.message}; stderr=${stderr}`)); }
    });
  });
}

async function waitForProxyCleanup(start, timeoutMs = 500) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (closedProxySockets >= start) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return closedProxySockets >= start;
}

async function waitForServerCleanup(timeoutMs = 500) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (sessions.size === 0 && serverSockets.size === 0) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return sessions.size === 0 && serverSockets.size === 0;
}

before(setUp);
after(async () => {
  for (const session of sessions) session.destroy();
  for (const socket of proxySockets) socket.destroy();
  for (const socket of serverSockets) socket.destroy();
  await Promise.all([proxy, server].filter(Boolean).map(listener => new Promise(resolve => listener.close(resolve))));
  if (root) rmSync(root, { recursive: true, force: true });
});

test('uses verified TLS and negotiates HTTP/2 through the declared CONNECT proxy', async () => {
  const closedBefore = closedProxySockets;
  const result = await invokeChild('/push');
  assert.deepEqual(result, { status: 201, ok: true, body: { alpn: 'h2', method: 'POST', path: '/push' } }, JSON.stringify({ connectTargets, seenAlpn, acceptedProxySockets, proxyBytes, result }));
  assert.deepEqual(seenAlpn, ['h2']);
  assert.deepEqual(connectTargets, [`127.0.0.1:${serverPort}`]);
  assert.equal(await waitForProxyCleanup(closedBefore + 1), true, 'proxy socket should close when the one-shot response completes');
});

test('supports direct HTTP/2 when no HTTPS proxy is declared', async () => {
  const before = seenAlpn.length;
  const result = await invokeChild('/push', { proxyEnabled: false });
  assert.deepEqual(result, { status: 201, ok: true, body: { alpn: 'h2', method: 'POST', path: '/push' } });
  assert.deepEqual(seenAlpn.slice(before), ['h2']);
  assert.equal(await waitForServerCleanup(), true, 'direct socket and server session should close after the one-shot response');
});

test('rejects untrusted certificates and hostname mismatches', async () => {
  const before = seenAlpn.length;
  const untrusted = await invokeChild('/push', { trustCertificate: false });
  assert.equal(untrusted.error, 'Error');
  assert.match(untrusted.message, /certificate|issuer|self.signed/i);
  const mismatch = await invokeChild('/push', { url: `https://wrong-host.invalid:${serverPort}/push` });
  assert.equal(mismatch.error, 'Error');
  assert.match(mismatch.message, /certificate|hostname|subject alternative/i);
  assert.equal(seenAlpn.length, before);
});

test('refuses unsupported proxy schemes and does not follow redirects', async () => {
  const unsupported = await invokeChild('/push', { proxyValue: 'socks5://127.0.0.1:1080' });
  assert.equal(unsupported.error, 'Error');
  assert.match(unsupported.message, /HTTPS_PROXY must be a plain HTTP proxy address/i);
  const redirect = await invokeChild('/redirect');
  assert.deepEqual(redirect, { status: 302, ok: false, body: {} });
});

test('aborts stalled responses and refuses a response beyond the byte cap', async () => {
  const abortResult = await invokeChild('/stall', {
    code: `
      const { requestHttp2 } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../read-data/http2-request.mjs', import.meta.url))).href)});
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('fixture abort', 'AbortError')), 60);
      try { await requestHttp2(process.env.PROBE_URL, { method: 'POST', body: 'bounded probe', signal: controller.signal, timeoutMs: 900 }); console.log('unexpected-success'); }
      catch (error) { console.log(JSON.stringify({ error: error.name, message: error.message })); }
    `,
  });
  assert.equal(abortResult.error, 'AbortError', JSON.stringify(abortResult));

  const timeoutResult = await invokeChild('/stall', { timeoutMs: '60' });
  assert.equal(timeoutResult.error, 'TimeoutError');

  const largeResult = await invokeChild('/large');
  assert.deepEqual(largeResult, { error: 'Error', message: 'HTTP/2 response body exceeds the limit.' }, JSON.stringify({ connectTargets, seenAlpn, acceptedProxySockets, proxyBytes }));
});

test('does not bypass an unusable HTTPS proxy', async () => {
  const before = seenAlpn.length;
  const result = await invokeChild('/push', { proxyAt: 1 });
  assert.equal(result.error, 'Error');
  assert.match(result.message, /connect|proxy/i);
  assert.equal(seenAlpn.length, before);
});
