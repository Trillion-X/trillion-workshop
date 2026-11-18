// tools/use-your-tools-from-a-shell/do-work/keep-the-connection.mjs
//
// Purpose: One connection to a door, kept open and reused by every command run on this computer, as ssh's ControlMaster
// with ControlPersist keeps one: the first command starts a keeper (this file, `serve SOCKET`), which listens on a unix
// socket in the command's own state folder (0700, so only this user reaches it) and sends each request on to its door
// over a kept-alive connection; every later command sends its requests through that socket. A command is a new process
// each time, so without a keeper each call paid a new connection: measured from this Mac on Nov 18 2026 (2:45 PM CST) a
// whoami's one request took 0.75 to 0.85 s on a new connection (TCP, TLS and the request: three round trips of about
// 210 ms; the first SYN after a pause is often lost and sent again a second later), against 0.26 s on a reused one.
//
//   keptFetch({ socket, start }) -> a fetch: a request to an https door (or the loopback door) goes through the keeper;
//     when no keeper answers, `start` starts one and this request goes straight, so a command never waits for it.
//   node keep-the-connection.mjs serve SOCKET IDLE_SECONDS -> the keeper; it leaves when no request came for IDLE_SECONDS.
//
// The request travels in an HTTP proxy's absolute form (RFC 9112 3.2.2: the request line names the whole address), so the
// keeper needs nothing but the request; a door the keeper cannot reach is answered 502 with the reason's code in
// `x-kept-connection-failed`, and keptFetch turns that back into the failure a fetch gives (TypeError, cause.code), so a
// caller reads the same failure either way.
//
// Non-Negotiable Invariants:
// - Only https addresses, and http on this computer's loopback (the Mac app's local door), are sent on; any other is refused.
// - Nothing is written down: no request, header or answer is logged or kept, only carried.
// - A command never depends on the keeper: no keeper, a keeper that is starting, or a keeper that broke, and the request
//   goes straight, as it did before.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { unlinkSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FAILED = 'x-kept-connection-failed';
// Headers that belong to one hop (RFC 9110 7.6.1), never carried on.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether the keeper carries a request to `url`: https anywhere, http only to this computer. */
export function carried(url) {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
}

const carriedHeaders = headers => Object.fromEntries(Object.entries(headers).filter(([name, value]) => !HOP.has(name.toLowerCase()) && value !== undefined));

/** A fetch that sends through the keeper at `socket`; with no keeper there, `start()` and `direct` for this request. */
export function keptFetch({ socket, start = () => {}, direct = fetch } = {}) {
  return async function fetchThroughKeeper(address, init = {}) {
    const url = new URL(String(address));
    if (!carried(url)) return direct(address, init);
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    const body = init.body === undefined || init.body === null ? null : Buffer.from(typeof init.body === 'string' ? init.body : await new Response(init.body).arrayBuffer());
    let reached = false;
    try {
      return await new Promise((resolve, reject) => {
        const asked = http.request({ socketPath: socket, method: init.method ?? 'GET', path: url.href, headers: { ...headers, ...(body ? { 'content-length': body.length } : {}) }, signal: init.signal });
        asked.on('response', answer => {
          reached = true;
          const failed = answer.headers[FAILED];
          if (answer.statusCode === 502 && failed) { answer.resume(); reject(new TypeError('fetch failed', { cause: { code: failed } })); return; }
          const kept = new Headers();
          for (const [name, value] of Object.entries(answer.headers)) if (!HOP.has(name)) for (const one of [value].flat()) kept.append(name, one);
          const empty = answer.statusCode === 204 || answer.statusCode === 304 || init.method === 'HEAD';
          if (empty) answer.resume();
          resolve(new Response(empty ? null : Readable.toWeb(answer), { status: answer.statusCode, statusText: answer.statusMessage, headers: kept }));
        });
        asked.on('error', error => {
          if (init.signal?.aborted) { reached = true; reject(init.signal.reason); return; }
          // Only a socket no keeper listens on is "no keeper"; a keeper that broke mid-request may have sent it on, so that is
          // the failure a fetch gives, and the caller's own retry (one request_key on every try) decides.
          if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') { reached = true; reject(new TypeError('fetch failed', { cause: { code: error.code ?? 'failed' } })); return; }
          reject(error);
        });
        asked.end(body ?? undefined);
      });
    } catch (error) {
      // The keeper answered (or the caller gave up): its answer stands. No keeper on the socket: start one, go straight now.
      if (reached) throw error;
      start();
      return direct(address, init);
    }
  };
}

/** Starts the keeper beside this file, cut loose from the command, under the same node. */
export function startKeeper({ socket, idleSeconds, node = process.execPath, spawnImpl = spawn } = {}) {
  try {
    spawnImpl(node, [fileURLToPath(import.meta.url), 'serve', socket, String(idleSeconds)], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* the request goes straight */ }
}

/** The keeper: listens on `socket` and sends each request on over kept-alive connections; leaves after `idleSeconds` with nothing asked. */
export function serveKeeper({ socket, idleSeconds, exit = () => process.exit(0) } = {}) {
  const agents = { 'https:': new https.Agent({ keepAlive: true }), 'http:': new http.Agent({ keepAlive: true }) };
  let open = 0, timer = null;
  const server = http.createServer();
  const leave = () => { server.close(); for (const agent of Object.values(agents)) agent.destroy(); try { unlinkSync(socket); } catch { /* gone */ } exit(); };
  const idle = () => { clearTimeout(timer); if (open === 0) timer = setTimeout(leave, idleSeconds * 1000); };
  server.on('request', (request, reply) => {
    open += 1; clearTimeout(timer);
    const done = () => { open -= 1; idle(); };
    reply.on('close', done);
    let url;
    try { url = new URL(request.url); } catch { url = null; }
    if (!url || !carried(url)) { reply.writeHead(400).end(); return; }
    const onward = (url.protocol === 'https:' ? https : http).request(url, { method: request.method, headers: carriedHeaders(request.headers), agent: agents[url.protocol] }, answer => {
      reply.writeHead(answer.statusCode, answer.statusMessage, carriedHeaders(answer.headers));
      answer.pipe(reply);
    });
    onward.on('error', error => { if (!reply.headersSent) reply.writeHead(502, { [FAILED]: error.code ?? 'failed' }).end(); else reply.destroy(); });
    // A command that stops waiting (its timeout) ends the onward request too.
    reply.on('close', () => { if (!reply.writableFinished) onward.destroy(); });
    request.pipe(onward);
  });
  server.on('error', error => {
    // Another keeper started at the same moment holds the socket: it serves, this one leaves. A file a dead keeper left: taken over.
    if (error.code !== 'EADDRINUSE') { exit(); return; }
    const probe = http.request({ socketPath: socket, method: 'HEAD', path: '/' }, answer => { answer.resume(); exit(); });
    probe.on('error', () => { try { unlinkSync(socket); } catch { /* gone */ } server.listen(socket); });
    probe.end();
  });
  server.on('listening', () => { try { chmodSync(socket, 0o600); } catch { /* the folder is the user's alone */ } idle(); });
  server.listen(socket);
  server.leave = leave;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === 'serve') {
  const [socket, idleSeconds] = process.argv.slice(3);
  const keeper = serveKeeper({ socket, idleSeconds: Number(idleSeconds) });
  // Stopped by its pid: it leaves as it does when idle, taking its socket with it.
  process.once('SIGTERM', keeper.leave);
}
