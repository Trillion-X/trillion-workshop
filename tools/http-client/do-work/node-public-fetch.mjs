// Node's supply for the SAME public-address/DNS/redirect rules. DNS is checked
// in the connection's lookup callback, never checked once then resolved again.
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { publicAddress, fetchPublic } from './public-address.mjs';
import { checkedLookup } from './resolved-address.mjs';

export function nodePublicFetch({ resolve = host => lookup(host, { all: true, verbatim: true }), request = httpsRequest,
  maxBytes = 65536, timeoutMs = 10000 } = {}) {
  const connectLookup = checkedLookup(resolve);
  const hop = async (address, init) => {
    const url = new URL(publicAddress(address));
    const headers = new Headers(init.headers);
    for (const name of ['host', 'connection', 'transfer-encoding', 'proxy-authorization']) headers.delete(name);
    headers.set('accept-encoding', 'identity');
    return new Promise((resolveAnswer, reject) => {
      const abort = () => req.destroy(new Error('The public request was cancelled.'));
      const req = request(url, { method: init.method ?? 'GET', headers: Object.fromEntries(headers), agent: false,
        lookup: connectLookup, rejectUnauthorized: true, signal: init.signal }, async incoming => {
        try {
          let stream = incoming;
          const encoding = String(incoming.headers['content-encoding'] ?? '').toLowerCase();
          if (encoding && encoding !== 'identity') {
            const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
            if (!decoder) throw new Error('The public response encoding is unsupported.');
            incoming.on('error', error => decoder.destroy(error)); stream = incoming.pipe(decoder);
          }
          const parts = []; let size = 0;
          for await (const part of stream) {
            size += part.length;
            if (size > maxBytes) { stream.destroy(); incoming.destroy(); throw new Error('The public response is too large.'); }
            parts.push(part);
          }
          const responseHeaders = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2) responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
          responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length');
          const response = new Response(['HEAD'].includes(init.method) || [204, 205, 304].includes(incoming.statusCode) ? null : Buffer.concat(parts),
            { status: incoming.statusCode, headers: responseHeaders });
          Object.defineProperty(response, 'url', { value: address }); resolveAnswer(response);
        } catch (error) { incoming.destroy(); req.destroy(); reject(error); }
        finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
      });
      const timer = setTimeout(() => req.destroy(new Error('The public request timed out.')), timeoutMs);
      req.on('error', error => { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); reject(error); });
      init.signal?.addEventListener('abort', abort, { once: true });
      req.end(init.body);
    });
  };
  return async (input, init = {}) => {
    const original = new Request(input, init);
    let body;
    if (original.body) {
      const parts = []; let size = 0;
      for await (const part of original.body) { size += part.length; if (size > maxBytes) throw new Error('The public request is too large.'); parts.push(Buffer.from(part)); }
      body = Buffer.concat(parts);
    }
    const options = { method: original.method, headers: original.headers, signal: original.signal, body };
    if (original.redirect === 'manual') return hop(original.url, options);
    if (original.redirect === 'error') {
      const result = await hop(original.url, options);
      if ([301, 302, 303, 307, 308].includes(result.status)) throw new Error('The public request redirected.');
      return result;
    }
    return fetchPublic(original.url, options, { fetchImpl: hop });
  };
}

// This host advertises compatibility only after its actual global fetch has
// the original public-address and connection-time DNS guards installed.
export function installNodePublicFetch() {
  globalThis.fetch = nodePublicFetch();
  Object.defineProperty(globalThis, 'Cloudflare', { configurable: false, writable: false,
    value: Object.freeze({ compatibilityFlags: Object.freeze({ global_fetch_strictly_public: true }) }) });
}
