// computer/local-mcp-bridge.mjs
//
// PURPOSE
//   Gives any MCP client on this computer the person's Trillion tools (this Mac's own among them) through a loopback address
//   and one token, so the client never holds the account key. Requests are passed to the account's /mcp with the key the
//   helper started it with.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Loopback only: it binds computer/local-mcp-bridge.json `host` (127.0.0.1) and checks the Host and Origin of every request.
//   2. The token is checked first, in constant time (BLAKE3 digests of both sides compared with timingSafeEqual), before the
//      path, the body or the account are touched; nothing, health included, is answered without it.
//   3. The account key and the token are never logged, never put in an answer and never on a command line: the token is in a
//      file only this user can read; the key is in this process's memory.
//   4. Blind: no tool is named here; `tools.allow` in the data may narrow what is offered, and is open by default.
//
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const bridgeSettings = () => JSON.parse(readFileSync(path.join(HERE, 'local-mcp-bridge.json'), 'utf8'));
const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const expand = place => place.replace(/^~(?=\/|$)/, os.homedir());
const digest = value => blake3(new TextEncoder().encode(String(value)));
export const tokenMatches = (given, token) => timingSafeEqual(digest(given), digest(token));

/** The token kept for this computer, made on first use. */
export function bridgeToken(settings = bridgeSettings()) {
  const file = expand(settings.token_file);
  try { const kept = readFileSync(file, 'utf8').trim(); if (kept) return kept; } catch { /* made below */ }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = bytesToHex(randomBytes(32));
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

const reply = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); };

/** The bridge over an upstream: { origin, key }. Returns { start, stop, address }. */
export function makeBridge({ settings = bridgeSettings(), origin, key, token = bridgeToken(settings), fetchImpl = fetch, log = () => {} }) {
  const allow = Array.isArray(settings.tools.allow) ? new Set(settings.tools.allow) : null;
  const upstream = `${origin.replace(/\/$/, '')}/mcp`;

  const body = request => new Promise((resolve, reject) => {
    const parts = [];
    let size = 0, over = false;
    // An oversize body is drained and let go, so the refusal can still be answered on the open connection.
    request.on('data', chunk => {
      if (over) return;
      size += chunk.length;
      if (size > settings.max_body_bytes) { over = true; parts.length = 0; reject(Object.assign(new Error('big'), { big: true })); } else parts.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(parts)));
    request.on('error', reject);
  });

  async function handle(request, response) {
    // The token first: nothing else about the request is looked at until it is right.
    const given = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!tokenMatches(given, token)) return reply(response, 401, { error: settings.words.unauthorized });
    const host = String(request.headers.host ?? '').replace(/:\d+$/, '');
    if (!settings.hosts.includes(host)) return reply(response, 403, { error: settings.words.bad_host });
    if (request.headers.origin !== undefined && !settings.origins.includes(request.headers.origin)) return reply(response, 403, { error: settings.words.bad_origin });
    if (new URL(request.url, 'http://x').pathname !== settings.path || !['POST', 'GET', 'DELETE'].includes(request.method)) return reply(response, 404, { error: settings.words.not_found });

    let payload = null;
    if (request.method === 'POST') {
      try { payload = await body(request); } catch (error) { return error.big ? reply(response, 413, { error: settings.words.too_big }) : reply(response, 400, { error: String(error.message) }); }
      if (allow) {
        let message = null;
        try { message = JSON.parse(payload.toString('utf8')); } catch { /* upstream will say it is not JSON */ }
        // The protocol executes params.calls when it is an array; an outer
        // params.name is then unused and cannot authorize its batch members.
        const calls = (Array.isArray(message) ? message : [message])
          .filter(item => item?.method === 'tools/call')
          .flatMap(item => (Array.isArray(item.params?.calls) ? item.params.calls : [item.params])
            .map(asked => ({ id: item.id, name: asked?.name })));
        const refused = calls.find(item => !allow.has(item.name));
        if (refused) return reply(response, 200, { jsonrpc: '2.0', id: refused.id ?? null, error: { code: -32602, message: fill(settings.words.tool_not_offered, { tool: refused.name }) } });
      }
    }
    const headers = { authorization: `Bearer ${key}` };
    for (const name of settings.forward_headers) if (request.headers[name] !== undefined) headers[name] = request.headers[name];
    let answer;
    try { answer = await fetchImpl(upstream, { method: request.method, headers, ...(payload ? { body: payload } : {}) }); }
    catch (error) { log({ bridge_upstream_failed: String(error?.message ?? error).slice(0, 200) }); return reply(response, 502, { error: fill(settings.words.upstream_failed, { error: String(error?.message ?? error).slice(0, 200) }) }); }
    const out = {};
    for (const name of settings.return_headers) { const value = answer.headers.get(name); if (value) out[name] = value; }
    const filterList = allow && request.method === 'POST' && /application\/json/.test(out['content-type'] ?? '');
    if (filterList) {
      const text = await answer.text();
      let value;
      try { value = JSON.parse(text); } catch { return response.writeHead(answer.status, out).end(text); }
      const keep = item => (item?.result?.tools ? { ...item, result: { ...item.result, tools: item.result.tools.filter(tool => allow.has(tool.name)) } } : item);
      return response.writeHead(answer.status, out).end(JSON.stringify(Array.isArray(value) ? value.map(keep) : keep(value)));
    }
    response.writeHead(answer.status, out);
    if (!answer.body) return response.end();
    const stream = Readable.fromWeb(answer.body);
    request.on('close', () => stream.destroy());
    stream.on('error', () => response.end());
    stream.pipe(response);
  }

  const server = http.createServer((request, response) => { handle(request, response).catch(error => { log({ bridge_failed: String(error?.message ?? error) }); if (!response.headersSent) reply(response, 500, { error: 'The bridge failed.' }); else response.end(); }); });
  return {
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(settings.port, settings.host, () => resolve({ host: settings.host, port: server.address().port, url: `http://${settings.host}:${server.address().port}${settings.path}` }));
    }),
    stop: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

let running = null;
export const bridgeTools = {
  /** tool:local-mcp-bridge: { on? } -> { on, url?, token_file?, said }. */
  async bridge(input = {}, context = {}) {
    const settings = bridgeSettings();
    if (input.on === true) {
      if (running) return { on: true, url: running.url, token_file: settings.token_file, said: fill(settings.words.already, { url: running.url }) };
      if (!context.origin || !context.key) throw Object.assign(new Error(settings.words.needs_key), { status: 409 });
      const bridge = makeBridge({ settings, origin: context.origin, key: context.key });
      const address = await bridge.start();
      const file = expand(settings.port_file);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${address.port}\n`, { mode: 0o600 });
      running = { bridge, url: address.url };
      return { on: true, url: address.url, token_file: settings.token_file, said: fill(settings.words.on, { url: address.url, file: settings.token_file }) };
    }
    if (input.on === false) {
      if (running) { const current = running; running = null; await current.bridge.stop(); }
      return { on: false, said: settings.words.off };
    }
    return running ? { on: true, url: running.url, token_file: settings.token_file } : { on: false, said: settings.words.off };
  },
};
