// computer/model-relay.mjs
//
// PURPOSE
//   Lets an AI harness that runs inside a place of its own (computer/work-places.mjs, a virtual machine on this Mac) call a
//   model provider without the person's provider credential ever entering the place: the harness is pointed at this relay
//   with the place's own token standing in for its key, and the relay forwards each call with the person's credential,
//   read at that moment, and keeps what the call used on the place.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: providers, their routes, headers and usage fields, the port and every word are computer/model-relay.json.
//   2. It listens only on this Mac's address on the place's private network (the interface whose subnet holds the place's
//      address), never on every interface, and answers only a peer inside that subnet.
//   3. A call is forwarded only with a live place token presented by the place's own address (`tokenAt`, the places owner's
//      check: unexpired, its place not stopped or removed). The token is taken off the call before it leaves.
//   4. The credential is a secret reference the person names in their own file, resolved by computer/secret-references.mjs
//      at each call; it is never kept here, logged, put in a program's arguments or answered, and an error never holds it.
//   5. Bounded: a call's body, the bytes read for usage, and the wait for the provider are limits in the DATA.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readSettingsFile } from './settings-file.mjs';
import { makeSecretResolver } from './secret-references.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const relaySettings = () => JSON.parse(readFileSync(join(HERE, 'model-relay.json'), 'utf8'));
const fill = (text, values) => String(text ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const expand = (path, home) => String(path).replace(/^~(?=\/|$)/, home);

const v4 = address => address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
const plain = address => String(address ?? '').replace(/^::ffff:/, '');

/** This Mac's IPv4 interface address whose subnet holds `guest`: { address, netmask }, or null. */
export function hostSideOf(guest, interfaces = networkInterfaces()) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(guest ?? '')) return null;
  for (const rows of Object.values(interfaces)) {
    for (const row of rows ?? []) {
      if (row.family !== 'IPv4' && row.family !== 4) continue;
      if (row.internal) continue;
      const mask = v4(row.netmask);
      if (((v4(row.address) & mask) >>> 0) === ((v4(guest) & mask) >>> 0)) return { address: row.address, netmask: row.netmask };
    }
  }
  return null;
}
export const inSubnet = (peer, side) => /^\d+\.\d+\.\d+\.\d+$/.test(peer) && ((v4(peer) & v4(side.netmask)) >>> 0) === ((v4(side.address) & v4(side.netmask)) >>> 0);

/** The value at a dotted path, the first of `a|b` alternatives that is there. */
const at = (value, paths) => {
  for (const path of String(paths).split('|')) {
    const found = path.split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), value);
    if (found !== undefined && found !== null) return found;
  }
  return undefined;
};

/** What a provider's answer says it used: { model, input_tokens, output_tokens }, from JSON or each `data:` line of a stream. */
export function usageOf(text, usage) {
  const objects = [];
  try { objects.push(JSON.parse(text)); } catch {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { objects.push(JSON.parse(line.slice(5).trim())); } catch { /* not every line is JSON */ }
    }
  }
  const out = {};
  for (const object of objects) {
    for (const [name, paths] of Object.entries(usage)) {
      const value = at(object, paths);
      if (value !== undefined) out[name] = value;
    }
  }
  return out;
}

/**
 * One relay for the places on this Mac. `tokenAt(token, peer)` is the places owner's check: the place a live token belongs
 * to when presented from `peer`, or null. `record(placeId, call)` keeps a call on its place. Servers are opened per host
 * address on first need (`listenFor(guest)`) and closed with `close()`.
 */
export function makeModelRelay({ settings = relaySettings(), home = homedir(), tokenAt, record, resolver = makeSecretResolver(), fetchImpl = fetch,
  interfaces = networkInterfaces, now = () => Date.now() } = {}) {
  const servers = new Map();
  const credentialsFile = expand(settings.credentials_file, home);
  const refusal = (response, status, key, values = {}) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { type: 'relay', message: fill(settings.words[key], values) } }));
  };
  const tokenOf = (headers, provider) => {
    for (const name of provider.token_headers) {
      const value = headers[name];
      if (typeof value === 'string' && value.trim()) return value.replace(/^Bearer\s+/i, '').trim();
    }
    return null;
  };
  const credentialFor = async id => {
    const found = readSettingsFile(credentialsFile);
    const reference = found.state === 'ok' ? found.value?.credentials?.[id] : null;
    if (typeof reference !== 'string' || !reference) return { missing: true };
    try { return { value: await resolver.resolve(reference) }; } catch { return { failed: true }; }
  };

  async function answer(side, request, response) {
    const peer = plain(request.socket.remoteAddress);
    if (!inSubnet(peer, side)) return refusal(response, 403, 'not_in_subnet');
    const [id, provider] = Object.entries(settings.providers).find(([, row]) => request.url === row.prefix || request.url.startsWith(`${row.prefix}/`)) ?? [];
    if (!provider) return refusal(response, 404, 'no_route', { prefixes: Object.values(settings.providers).map(row => row.prefix).join(', ') });
    const token = tokenOf(request.headers, provider);
    const place = token ? tokenAt(token, peer) : null;
    if (!place) return refusal(response, 401, 'no_token');
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > settings.most_body_bytes) return refusal(response, 413, 'too_big', { most: settings.most_body_bytes });
      chunks.push(chunk);
    }
    const credential = await credentialFor(id);
    if (credential.missing) return refusal(response, 503, 'no_credential', { provider: id, file: settings.credentials_file });
    if (credential.failed) return refusal(response, 502, 'credential_failed', { provider: id });
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (settings.drop_headers.includes(name) || provider.token_headers.includes(name)) continue;
      headers[name] = value;
    }
    headers[provider.credential_header] = fill(provider.credential_format, { value: credential.value });
    const started = now();
    let upstream;
    try {
      upstream = await fetchImpl(`${provider.upstream}${request.url.slice(provider.prefix.length)}`, {
        method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks),
        signal: AbortSignal.timeout(settings.upstream_timeout_ms),
      });
    } catch {
      record(place.id, { at: new Date(started).toISOString(), provider: id, status: 502 });
      return refusal(response, 502, 'upstream_failed', { provider: id });
    }
    const passed = {};
    upstream.headers.forEach((value, name) => { if (!settings.drop_headers.includes(name) && name !== 'content-encoding') passed[name] = value; });
    response.writeHead(upstream.status, passed);
    let seen = '';
    if (upstream.body) {
      for await (const chunk of Readable.fromWeb(upstream.body)) {
        response.write(chunk);
        if (seen.length < settings.usage_scan_bytes) seen += Buffer.from(chunk).toString('utf8');
      }
    }
    response.end();
    record(place.id, { at: new Date(started).toISOString(), provider: id, status: upstream.status, ms: now() - started, ...usageOf(seen, provider.usage) });
  }

  return {
    /** Opens (once) the relay on this Mac's side of the network that holds `guest`; → { address, port, url }. */
    async listenFor(guest) {
      const side = hostSideOf(guest, interfaces());
      if (!side) throw Object.assign(new Error(fill(settings.words.no_network, { address: guest })), { status: 503 });
      if (!servers.has(side.address)) {
        const server = createServer((request, response) => {
          answer(side, request, response).catch(() => { if (!response.headersSent) refusal(response, 502, 'upstream_failed', { provider: 'the provider' }); else response.end(); });
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(settings.port, side.address, resolve); });
        servers.set(side.address, server);
      }
      const { port } = servers.get(side.address).address();
      return { address: side.address, port, url: `http://${side.address}:${port}` };
    },
    /** The variables a harness for `providerId` is given in the place. */
    guestEnv(providerId, relay, token) {
      const provider = settings.providers[providerId];
      return provider ? Object.fromEntries(Object.entries(provider.guest_env).map(([name, value]) => [name, fill(value, { relay, token })])) : null;
    },
    /** The addresses the relay listens on now. */
    listening: () => [...servers.values()].map(server => server.address()),
    close: () => Promise.all([...servers.values()].map(server => new Promise(resolve => server.close(resolve)))).then(() => servers.clear()),
  };
}
