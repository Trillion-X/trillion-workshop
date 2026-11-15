// A bounded HTTP/2 request over the Workshop's declared HTTPS CONNECT proxy.
// This module knows transport only: callers choose the URL, headers and body.
// The HTTP/2 framing, the CONNECT tunnel and the TLS verification are undici's;
// what is kept here is the policy around them: the declared proxy only, the
// byte and time bounds, and the refusal of hop-by-hop headers.
import { Agent, ProxyAgent, request } from 'undici';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 20_000;

function failure(message, name = 'Error') {
  return Object.assign(new Error(message), { name });
}

function proxyOrigin() {
  const value = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!value) return null;
  let proxy;
  try { proxy = new URL(value); } catch { throw failure('HTTPS_PROXY is invalid.'); }
  if (proxy.protocol !== 'http:' || !proxy.hostname || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw failure('HTTPS_PROXY must be a plain HTTP proxy address.');
  }
  const port = proxy.port ? Number(proxy.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw failure('HTTPS_PROXY port is invalid.');
  return proxy.origin;
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

function responseObject(status, headers, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(Object.entries(headers).map(([name, content]) => [name, [content].flat().join(', ')])),
    async text() { return body.toString('utf8'); },
    async json() { return JSON.parse(body.toString('utf8')); },
  };
}

async function readBounded(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      stream.destroy();
      throw failure('HTTP/2 response body exceeds the limit.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Fetch-like one-shot HTTPS request. Uses HTTPS_PROXY when declared; invalid proxy settings fail closed. */
export async function requestHttp2(input, init = {}) {
  const url = input instanceof URL ? new URL(input.href) : new URL(String(input));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw failure('HTTP/2 requests require an HTTPS URL without user info or a fragment.');
  const body = requestBody(init.body);
  if (body.length > MAX_REQUEST_BYTES) throw failure('HTTP/2 request body exceeds the limit.');
  const timeoutMs = init.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw failure('HTTP/2 request deadline is invalid.');
  const headers = requestHeaders(init.headers);
  const proxy = proxyOrigin();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(failure('HTTP/2 request deadline exceeded.', 'TimeoutError')), timeoutMs);
  const outerSignal = init.signal;
  const onOuterAbort = () => controller.abort(outerSignal.reason ?? failure('HTTP/2 request was aborted.', 'AbortError'));
  if (outerSignal?.aborted) onOuterAbort();
  else outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

  const dispatcher = proxy ? new ProxyAgent({ uri: proxy, allowH2: true, requestTls: { allowH2: true } }) : new Agent({ allowH2: true });
  try {
    const { signal } = controller;
    if (signal.aborted) throw signal.reason;
    const response = await request(url, {
      dispatcher,
      method: String(init.method ?? 'GET').toUpperCase(),
      headers,
      body: body.length ? body : undefined,
      signal,
      maxRedirections: 0,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const bytes = await readBounded(response.body);
    return responseObject(response.statusCode, response.headers, bytes);
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
    await dispatcher.destroy();
  }
}
