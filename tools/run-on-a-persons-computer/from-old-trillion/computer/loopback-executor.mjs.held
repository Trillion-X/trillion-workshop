// computer/loopback-executor.mjs
//
// PURPOSE
//   An executor on this computer that sends a request for a page which cannot send it itself (a cross-origin refusal, a
//   private address the person owns). The page reaches it only on 127.0.0.1, only from an allowed origin, and only after a hello
//   carrying a single-use token that this computer's host minted with a per-install secret; the token proves the page was
//   given access by the signed-in person, not just by being open in a browser.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Binds 127.0.0.1 only. The per-install secret is random, kept in a 0600 file, never in a request, log or answer.
//   2. The hello check is positive and fails closed: it passes only when the message is the expected shape, its origin is in the allowlist, and
//      its token verifies, is unexpired and has not been used. Anything else, including a thrown error, is a refusal.
//   3. A token is used once (remembered until it expires); a session is a random id that expires; nothing else is accepted.
//   4. Browser access is by CORS headers for the allowed origin only; the preflight answers the same list.
//   5. Everything that varies is computer/loopback-executor.json. TLS verification and the TLS floor are per request (never a process-wide
//      default); the restriction on addresses is opt-in and judged on the resolved numbers at connect time.
//   6. The request it sends is resolved by parts/http-client/do-work/request-scopes.mjs, so variables and host-bound secrets behave
//      the same as everywhere else, and secret values are masked in anything it returns about the run.
//
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { checkedLookup } from '../parts/http-client/do-work/resolved-address.mjs';
import { resolveRequest, scrubValues } from '../parts/http-client/do-work/request-scopes.mjs';
import { makeSecretResolver } from './secret-references.mjs';
import { makeHostCalls, runScript, sandboxSettings } from './script-sandbox.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const executorSettings = () => JSON.parse(readFileSync(join(HERE, 'loopback-executor.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const b64 = bytes => Buffer.from(bytes).toString('base64url');

/** The per-install secret: created once, 32 random bytes, a private file. */
export function installSecret(settings = executorSettings(), home) {
  home ??= homedir();
  const file = join(home, settings.secret_file);
  if (existsSync(file)) return hexToBytes(readFileSync(file, 'utf8').trim());
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32);
  writeFileSync(file, bytesToHex(secret), { mode: 0o600 });
  chmodSync(file, 0o600);
  return new Uint8Array(secret);
}

const macOf = (secret, body) => b64(blake3(new TextEncoder().encode(body), { key: secret }));
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A token for a page at `origin`, good once until `ttl` ms from now: this computer's host mints it and hands it to the page. */
export function mintToken(secret, origin, { ttl = executorSettings().token_ttl_ms, now = Date.now() } = {}) {
  const body = b64(JSON.stringify({ id: b64(randomBytes(12)), origin, exp: now + ttl }));
  return `${body}.${macOf(secret, body)}`;
}

export function makeLoopbackExecutor({ settings = executorSettings(), secret, now = () => Date.now(), resolve = host => dns.promises.lookup(host, { all: true }), send = null, secretResolver = null } = {}) {
  let references = secretResolver;
  const used = new Map();
  const sessions = new Map();
  const sweep = () => {
    for (const [key, until] of used) if (until <= now()) used.delete(key);
    for (const [key, session] of sessions) if (session.until <= now()) sessions.delete(key);
  };

  /** True only when every condition holds; anything unexpected is false. */
  function acceptHello(message, origin) {
    try {
      if (!message || typeof message !== 'object' || message.type !== 'hello' || typeof message.token !== 'string') return false;
      if (!settings.origins.includes(origin)) return false;
      const [body, mac] = message.token.split('.');
      if (!body || !mac || !same(mac, macOf(secret, body))) return false;
      const claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (claim.origin !== origin || !(claim.exp > now()) || typeof claim.id !== 'string') return false;
      if (used.has(claim.id)) return false;
      used.set(claim.id, claim.exp);
      return true;
    } catch { return false; }
  }

  function tlsFor(request) {
    const floor = request.tls?.min_version ?? settings.tls.min_version;
    if (!settings.tls.allowed_min_versions.includes(floor)) throw Object.assign(new Error(fill(settings.words.tls_floor, { version: floor })), { status: 400 });
    return { minVersion: floor, rejectUnauthorized: request.tls?.reject_unauthorized ?? settings.tls.reject_unauthorized };
  }

  async function sendOne(request, hops = 0) {
    const url = new URL(request.url);
    const secure = url.protocol === 'https:';
    if (!secure && url.protocol !== 'http:') throw Object.assign(new Error(settings.words.bad_request), { status: 400 });
    const limits = settings.request_limits;
    const options = { method: request.method, headers: request.headers ?? {}, timeout: limits.timeout_ms,
      ...(secure ? tlsFor(request) : {}),
      ...(settings.restriction.enabled ? { lookup: checkedLookup(resolve, { deny: settings.restriction.deny }) } : {}) };
    const body = request.body === undefined || request.body === null ? null : Buffer.from(typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
    if (body && body.length > limits.body_bytes) throw Object.assign(new Error(settings.words.too_big), { status: 413 });
    const response = await new Promise((done, fail) => {
      const call = (secure ? https : http).request(url, options, answer => {
        const pieces = []; let length = 0;
        answer.on('data', piece => { length += piece.length; if (length > limits.response_bytes) { call.destroy(Object.assign(new Error(settings.words.too_big), { status: 413 })); return; } pieces.push(piece); });
        answer.on('end', () => done({ status: answer.statusCode, headers: answer.headers, body: Buffer.concat(pieces) }));
      });
      call.on('timeout', () => call.destroy(new Error('timeout')));
      call.on('error', fail);
      call.end(body ?? undefined);
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && request.follow_redirects === true && response.headers.location) {
      if (hops >= limits.redirects) throw Object.assign(new Error(settings.words.too_big), { status: 508 });
      const next = new URL(response.headers.location, url).toString();
      const getAgain = response.status === 303 || ((response.status === 301 || response.status === 302) && request.method === 'POST');
      return sendOne({ ...request, url: next, ...(getAgain ? { method: 'GET', body: null } : {}) }, hops + 1);
    }
    return response;
  }

  async function run(message) {
    if (!message || typeof message.request !== 'object' || typeof message.request?.url !== 'string' || typeof message.request?.method !== 'string') {
      throw Object.assign(new Error(settings.words.bad_request), { status: 400 });
    }
    // A secret may be a `reference` (secret://provider/path) kept elsewhere; its value is looked up here, just before sending, and placed like any host-bound secret.
    const secrets = [];
    for (const item of message.secrets ?? []) {
      if (typeof item?.reference !== 'string') { secrets.push(item); continue; }
      references ??= makeSecretResolver();
      secrets.push({ name: item.name, hosts: item.hosts, value: (await references.resolveAll(item.reference)).value });
    }
    // A pre-request script may change the request before it is placed; it gets no ambient files, cookies or packages, and a
    // request it sends itself goes through this same pipeline (resolution, host-bound secrets, address checks), file bodies stripped.
    let request = message.request;
    if (typeof message.script === 'string') {
      const sandbox = sandboxSettings();
      const host = makeHostCalls({ settings: sandbox, sendRequest: inner => run({ request: inner, scopes: message.scopes, secrets: message.secrets }) });
      const ran = await runScript({ code: message.script, input: { request }, settings: sandbox, host });
      if (ran.error) throw Object.assign(new Error(ran.error), { status: 422 });
      const changed = ran.value?.request;
      if (typeof changed?.url !== 'string' || typeof changed?.method !== 'string') throw Object.assign(new Error(settings.words.script_result), { status: 422 });
      request = changed;
    }
    const resolved = resolveRequest(request, { scopes: message.scopes ?? [], secrets });
    const sent = await (send ?? sendOne)(resolved.request);
    return scrubValues({ status: sent.status, headers: sent.headers, response: { body: Buffer.from(sent.body).toString('base64'), encoding: 'base64' },
      unresolved: resolved.unresolved, placed: resolved.placed, refused: resolved.refused }, resolved.values);
  }

  const readBody = request => new Promise((done, fail) => {
    const pieces = []; let length = 0;
    request.on('data', piece => { length += piece.length; if (length > settings.request_limits.body_bytes + 100000) { fail(Object.assign(new Error(settings.words.too_big), { status: 413 })); request.destroy(); return; } pieces.push(piece); });
    request.on('end', () => done(Buffer.concat(pieces).toString('utf8')));
    request.on('error', fail);
  });

  const server = http.createServer(async (request, reply) => {
    const origin = request.headers.origin ?? '';
    const answer = (status, value) => {
      const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
      if (settings.origins.includes(origin)) Object.assign(headers, { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-headers': 'content-type, x-session', 'access-control-allow-methods': 'POST, OPTIONS' });
      reply.writeHead(status, headers).end(JSON.stringify(value));
    };
    sweep();
    try {
      if (!settings.origins.includes(origin)) return answer(403, { error: settings.words.bad_origin });
      if (request.method === 'OPTIONS') return answer(204, {});
      const message = JSON.parse(await readBody(request) || 'null');
      if (request.url === '/hello') {
        if (!acceptHello(message, origin)) return answer(403, { error: settings.words.bad_hello });
        const id = b64(randomBytes(24));
        sessions.set(id, { origin, until: now() + settings.session_ttl_ms });
        return answer(200, { session: id, expires_at: new Date(now() + settings.session_ttl_ms).toISOString() });
      }
      const session = sessions.get(request.headers['x-session']);
      if (!session || session.origin !== origin) return answer(401, { error: settings.words.no_session });
      if (request.url === '/request') return answer(200, await run(message));
      return answer(404, { error: settings.words.bad_request });
    } catch (error) { return answer(error.status ?? 400, { error: error.status ? error.message : settings.words.bad_request }); }
  });

  return {
    server,
    acceptHello,
    /** Listens on 127.0.0.1 and answers the port. */
    listen: () => new Promise(done => server.listen(settings.port, settings.host, () => done(server.address().port))),
    close: () => new Promise(done => server.close(done)),
  };
}

let running = null;
/** tool: { on?, page_origin? } -> { on, port?, token?, said }. The Mac host starts the listener, then mints a one-use token for the page. */
export const executorTools = {
  async executor(input = {}, context = {}) {
    const settings = executorSettings();
    if (input.on === false) {
      if (running) { const current = running; running = null; await current.executor.close(); }
      return { on: false, said: settings.words.off };
    }
    if (input.on === true && !running) {
      const origins = [...new Set([...(context.origin ? [context.origin] : []), ...settings.origins])];
      if (!origins.length) throw Object.assign(new Error(settings.words.no_origin), { status: 409 });
      const secret = installSecret(settings, context.home);
      const executor = makeLoopbackExecutor({ settings: { ...settings, origins }, secret });
      running = { executor, secret, origins, port: await executor.listen() };
    }
    if (!running) return { on: false, said: settings.words.off };
    const page = input.page_origin ?? running.origins[0];
    if (!running.origins.includes(page)) throw Object.assign(new Error(settings.words.bad_origin), { status: 403 });
    return { on: true, port: running.port, token: mintToken(running.secret, page), origin: page, expires_in_ms: settings.token_ttl_ms, said: fill(settings.words.on, { port: running.port }) };
  },
};
