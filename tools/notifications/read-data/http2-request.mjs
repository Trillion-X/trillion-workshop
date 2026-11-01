// A bounded HTTP/2 request over the Workshop's declared HTTPS CONNECT proxy.
// This module knows transport only: callers choose the URL, headers and body.
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { isIP } from 'node:net';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CONNECT_HEADER_BYTES = 8 * 1024;
const MAX_TIMEOUT_MS = 20_000;

function failure(message, name = 'Error') {
  return Object.assign(new Error(message), { name });
}

function proxyAddress() {
  const value = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!value) return null;
  let proxy;
  try { proxy = new URL(value); } catch { throw failure('HTTPS_PROXY is invalid.'); }
  if (proxy.protocol !== 'http:' || !proxy.hostname || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw failure('HTTPS_PROXY must be a plain HTTP proxy address.');
  }
  const port = proxy.port ? Number(proxy.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw failure('HTTPS_PROXY port is invalid.');
  return { host: proxy.hostname.replace(/^\[|\]$/g, ''), port };
}

function requestBody(value) {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (typeof value === 'string') return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw failure('HTTP/2 request body must be a string or byte buffer.');
}

function requestHeaders(value) {
  const headers = new Headers(value);
  const out = {};
  for (const [name, content] of headers) {
    const lower = name.toLowerCase();
    if (lower.startsWith(':') || ['connection', 'host', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'].includes(lower)) {
      throw failure('HTTP/2 request headers contain a forbidden hop-by-hop field.');
    }
    out[lower] = content;
  }
  return out;
}

function waitFor(target, event, signal, errorEvent = 'error') {
  return new Promise((resolve, reject) => {
    const clean = () => {
      target.removeListener(event, onEvent);
      target.removeListener(errorEvent, onError);
      target.removeListener('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const onEvent = (...args) => { clean(); resolve(args); };
    const onError = error => { clean(); reject(error); };
    const onClose = () => { clean(); reject(failure('HTTP/2 transport closed before it was ready.')); };
    const onAbort = () => { clean(); reject(signal.reason ?? failure('HTTP/2 request was aborted.', 'AbortError')); };
    target.once(event, onEvent);
    target.once(errorEvent, onError);
    target.once('close', onClose);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function connectThroughProxy(proxy, authority, signal) {
  const socket = net.connect({ host: proxy.host, port: proxy.port });
  try {
    await waitFor(socket, 'connect', signal);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: keep-alive\r\n\r\n`);

    let head = Buffer.alloc(0);
    while (true) {
      const [chunk] = await waitFor(socket, 'data', signal, 'error');
      head = Buffer.concat([head, chunk]);
      if (head.length > MAX_CONNECT_HEADER_BYTES) throw failure('HTTPS proxy response headers exceed the limit.');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) continue;
      const statusLine = head.subarray(0, end).toString('latin1').split('\r\n', 1)[0];
      if (!/^HTTP\/1\.[01] 200(?:\s|$)/.test(statusLine)) throw failure('HTTPS proxy refused the CONNECT tunnel.');
      const rest = head.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      return socket;
    }
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function tlsForHttp2(url, signal) {
  const proxy = proxyAddress();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${url.port || '443'}`;
  const tunnel = proxy ? await connectThroughProxy(proxy, authority, signal) : net.connect({ host, port: Number(url.port || 443) });
  const secure = tls.connect({
    socket: tunnel,
    ALPNProtocols: ['h2'],
    rejectUnauthorized: true,
    ...(isIP(host) ? {} : { servername: host }),
    checkServerIdentity: (_name, cert) => tls.checkServerIdentity(host, cert),
  });
  try {
    await waitFor(secure, 'secureConnect', signal);
    if (secure.alpnProtocol !== 'h2') throw failure('The HTTPS endpoint did not negotiate HTTP/2.');
    return secure;
  } catch (error) {
    secure.destroy();
    throw error;
  }
}

function responseObject(status, headers, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(Object.entries(headers).filter(([name]) => !name.startsWith(':'))),
    async text() { return body.toString('utf8'); },
    async json() { return JSON.parse(body.toString('utf8')); },
  };
}

/** Fetch-like one-shot HTTPS request. Uses HTTPS_PROXY when declared; invalid proxy settings fail closed. */
export async function requestHttp2(input, init = {}) {
  const url = input instanceof URL ? new URL(input.href) : new URL(String(input));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw failure('HTTP/2 requests require an HTTPS URL without user info or a fragment.');
  const body = requestBody(init.body);
  if (body.length > MAX_REQUEST_BYTES) throw failure('HTTP/2 request body exceeds the limit.');
  const timeoutMs = init.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw failure('HTTP/2 request deadline is invalid.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(failure('HTTP/2 request deadline exceeded.', 'TimeoutError')), timeoutMs);
  const outerSignal = init.signal;
  const onOuterAbort = () => controller.abort(outerSignal.reason ?? failure('HTTP/2 request was aborted.', 'AbortError'));
  if (outerSignal?.aborted) onOuterAbort();
  else outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

  let secure;
  let session;
  let request;
  try {
    const signal = controller.signal;
    secure = await tlsForHttp2(url, signal);
    if (signal.aborted) throw signal.reason;
    session = http2.connect(url.origin, { createConnection: () => secure, settings: { enablePush: false } });
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = {
      ':method': method,
      ':path': `${url.pathname || '/'}${url.search}`,
      ':scheme': 'https',
      ':authority': url.host,
      ...requestHeaders(init.headers),
    };
    request = session.request(headers);
    const response = await new Promise((resolve, reject) => {
      let status = 0;
      let responseHeaders = {};
      let size = 0;
      let settled = false;
      const chunks = [];
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        session.removeListener('error', onSessionError);
        session.removeListener('close', onSessionClose);
      };
      const finishError = error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        finishError(signal.reason ?? failure('HTTP/2 request was aborted.', 'AbortError'));
        session.destroy();
      };
      const onSessionError = error => finishError(error);
      const onSessionClose = () => {
        if (!settled) finishError(failure('HTTP/2 session closed before the response completed.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      session.once('error', onSessionError);
      session.once('close', onSessionClose);
      if (signal.aborted) { onAbort(); return; }
      request.once('response', headers => {
        status = Number(headers[':status'] ?? 0);
        responseHeaders = headers;
      });
      request.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          finishError(failure('HTTP/2 response body exceeds the limit.'));
          session.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.once('error', finishError);
      request.once('end', () => {
        if (settled) return;
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          finishError(failure('HTTP/2 response did not include a valid status.'));
          return;
        }
        settled = true;
        cleanup();
        resolve(responseObject(status, responseHeaders, Buffer.concat(chunks)));
      });
      request.end(body);
    });
    return response;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
    if (session && !session.destroyed) session.close();
    else secure?.destroy();
  }
}
