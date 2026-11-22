// Node's supply for the SAME public-address/DNS/redirect rules. DNS is checked
// in the connection's lookup callback, never checked once then resolved again.
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { lookup } from 'node:dns/promises';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { publicAddress, fetchPublic } from '../../refuse-requests-to-private-addresses/public-address.mjs';
import { checkedLookup } from './resolved-address.mjs';
import { once } from 'node:events';
import { connect as tlsConnect } from 'node:tls';
// Sandboxed runs reach the network only through the run's proxy (HTTPS_PROXY); the same CONNECT tunnel the run-sql tool uses.
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';

export function nodePublicFetch({ resolve = host => lookup(host, { all: true, verbatim: true }), request = httpsRequest,
  maxBytes = 65536, timeoutMs = 10000, proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '' } = {}) {
  const connectLookup = checkedLookup(resolve);
  const tunnelFor = proxy ? throughProxy(proxy) : null;
  // Through the run's proxy the proxy resolves the name, so no address is checked here; the name itself was judged by publicAddress.
  const secureThroughProxy = async url => {
    const tunnel = tunnelFor();
    const port = Number(url.port || 443);
    tunnel.connect(port, url.hostname);
    // The tunnel opens (its 'connect') or fails: a proxy that closes the connection is a failure, never a wait.
    await new Promise((resolveOpen, reject) => {
      tunnel.once('connect', resolveOpen);
      tunnel.once('error', reject);
      tunnel.once('close', () => reject(new Error(`the run's proxy did not open ${url.hostname}:${port}`)));
    });
    return tlsConnect({ socket: tunnel, servername: url.hostname, rejectUnauthorized: true });
  };
  const hop = async (address, init) => {
    const url = new URL(publicAddress(address));
    const headers = new Headers(init.headers);
    for (const name of ['host', 'connection', 'transfer-encoding', 'proxy-authorization']) headers.delete(name);
    headers.set('accept-encoding', 'identity');
    const secure = tunnelFor ? await secureThroughProxy(url) : null;
    return new Promise((resolveAnswer, reject) => {
      const abort = () => req.destroy(new Error('The public request was cancelled.'));
      // Through the proxy the connection is the tunnel itself: the request's own agent hands that socket over, so Node never
      // resolves the name directly (a request option createConnection is not used by every Node's https agent).
      const agent = secure ? Object.assign(new HttpsAgent({ keepAlive: false }), { createConnection: () => secure }) : false;
      const req = request(url, { method: init.method ?? 'GET', headers: Object.fromEntries(headers), agent,
        ...(secure ? {} : { lookup: connectLookup }), rejectUnauthorized: true, signal: init.signal }, async incoming => {
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

// Replaces the global fetch with one that has the public-address and connection-time DNS guards.
export function installNodePublicFetch() {
  globalThis.fetch = nodePublicFetch();
}
