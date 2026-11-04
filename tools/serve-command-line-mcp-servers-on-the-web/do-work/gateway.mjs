// parts/stdio-mcp-gateway/do-work/gateway.mjs
//
// Serves stdio Model Context Protocol servers as streamable-HTTP ones (MCP 2025-06-18 transport), with no
// dependency but Node. Each app is DATA: `{ cli, args }`, the command that runs its stdio server. A request to
// `/<app>/mcp` is answered like this:
//
//   POST  initialize          starts the app's server (a fresh process in a fresh working folder of its own), forwards
//                             the request, and answers it with an `Mcp-Session-Id` header.
//   POST  any other message   goes to that session's process by its id. A request (it has an id) is answered with the
//                             process's reply as application/json (or one server-sent event when the caller accepts
//                             only text/event-stream); a notification or a reply is taken with 202.
//   POST  with no session id  and not an initialize: the one-off flow. A process is started, initialized for the
//                             caller, asked, and stopped, so a caller that keeps no session still gets its answer.
//   GET   with a session id   opens a server-sent-event stream of the process's own notifications (405 without one).
//   DELETE                    ends the session and its process (404 when it is not one).
//   GET   /                   health: { ok, apps, sessions }.
//
// A session whose process has gone, or that is not known (it idled out, or the container restarted), answers 404,
// which tells a caller to initialize again. Sessions are bounded: at most `maxSessions` live at once (a caller that
// asks while all are busy is queued up to `queueMs`, then refused with 503; a session with no request in flight is
// stopped, least recently used first, to make room, because a caller that never says goodbye must not hold a slot), a
// session idle for `idleMs` or older than `maxAgeMs` is stopped, a request waits at most `requestTimeoutMs`.
// A process gets almost no environment (PATH, HOME and TMPDIR in its working folder) and nothing it left behind
// survives its session.
//
// Invariants: one JSON message per line on a process's stdin and stdout; a request's reply is found by its id; a
// request the process asks of the caller (sampling, roots) is answered "method not found" because no capability was
// offered; a message larger than `maxBodyBytes` is refused with 413.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JSON_TYPE = { 'content-type': 'application/json' };
const APP_PATH = /^\/([a-z0-9][a-z0-9-]{0,62})\/mcp\/?$/;
const DEFAULT_PROTOCOL = '2025-06-18';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const has = value => value !== undefined && value !== null;
const isRequest = message => has(message?.id) && typeof message?.method === 'string';
const isReply = message => has(message?.id) && typeof message?.method !== 'string' && (has(message?.result) || has(message?.error));
const errorReply = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export function createGateway({
  apps, spawn = nodeSpawn, workRoot = join(tmpdir(), 'stdio-mcp-gateway'), maxSessions = 16, idleMs = 120_000, maxAgeMs = 1_800_000,
  requestTimeoutMs = 120_000, queueMs = 15_000, sweepMs = Math.max(1000, Math.min(15_000, Math.floor(idleMs / 4))), maxBodyBytes = 64 * 1024 * 1024, maxLineBytes = 256 * 1024 * 1024, now = Date.now, log = () => {},
} = {}) {
  mkdirSync(workRoot, { recursive: true });
  const sessions = new Map();

  function end(session, reason) {
    if (session.ended) return;
    session.ended = reason;
    sessions.delete(session.id);
    for (const [, pending] of session.pending) pending.resolve(errorReply(pending.id, -32000, `The session ended: ${reason}`));
    session.pending.clear();
    for (const stream of session.streams) { try { stream.end(); } catch {} }
    session.streams.clear();
    try { session.child.stdin.end(); } catch {}
    try { session.child.kill('SIGKILL'); } catch {}
    try { rmSync(session.folder, { recursive: true, force: true }); } catch {}
    log(`session ${session.id} (${session.app}) ended: ${reason}`);
  }

  function start(appName) {
    const app = apps[appName];
    const folder = mkdtempSync(join(workRoot, `${appName}-`));
    const child = spawn(app.cli, app.args ?? [], {
      cwd: folder, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: folder, TMPDIR: folder, LANG: 'C.UTF-8', ...(app.env ?? {}) },
    });
    const session = { id: randomUUID(), app: appName, child, folder, pending: new Map(), streams: new Set(), busy: 0, born: now(), used: now(), ended: null, stderr: '', buffer: '', ready: null };
    sessions.set(session.id, session);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      session.buffer += chunk;
      if (session.buffer.length > maxLineBytes) return end(session, 'the server wrote a message that is too large');
      let at;
      while ((at = session.buffer.indexOf('\n')) >= 0) {
        const line = session.buffer.slice(0, at).trim();
        session.buffer = session.buffer.slice(at + 1);
        if (line) fromProcess(session, line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { session.stderr = (session.stderr + chunk).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('error', error => end(session, `the server could not start: ${error.message}`));
    child.on('exit', (code, signal) => end(session, `the server exited (${signal ?? code})${session.stderr ? `: ${session.stderr.trim().slice(-300)}` : ''}`));
    return session;
  }

  function fromProcess(session, line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (isReply(message)) {
      const pending = session.pending.get(message.id);
      if (pending) { session.pending.delete(message.id); pending.resolve(message); }
      return;
    }
    if (isRequest(message)) {
      // The caller offered no capability the server could ask for.
      writeTo(session, errorReply(message.id, -32601, `Method not found: ${message.method}`));
      return;
    }
    for (const stream of session.streams) stream.write(`id: ${randomUUID()}\ndata: ${JSON.stringify(message)}\n\n`);
  }

  const writeTo = (session, message) => { if (!session.ended) session.child.stdin.write(`${JSON.stringify(message)}\n`); };

  // The process's reply to one request, or an error reply when it takes too long or its session ends.
  function ask(session, message) {
    if (session.ended) return Promise.resolve(errorReply(message.id, -32000, `The session ended: ${session.ended}`));
    if (session.pending.has(message.id)) return Promise.resolve(errorReply(message.id, -32600, `Request id ${JSON.stringify(message.id)} is already waiting for a reply.`));
    session.busy += 1;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        session.pending.delete(message.id);
        resolve(errorReply(message.id, -32001, `${session.app} did not answer ${message.method} in ${Math.round(requestTimeoutMs / 1000)} seconds.`));
      }, requestTimeoutMs);
      session.pending.set(message.id, { id: message.id, resolve: reply => { clearTimeout(timer); resolve(reply); } });
      writeTo(session, message);
    }).finally(() => { session.busy -= 1; session.used = now(); });
  }

  // A slot for one more session: free, or made by stopping the least recently used session with nothing in flight;
  // otherwise waited for up to queueMs.
  async function makeRoom() {
    const until = now() + queueMs;
    for (;;) {
      if (sessions.size < maxSessions) return true;
      const idle = [...sessions.values()].filter(session => session.busy === 0).sort((left, right) => left.used - right.used)[0];
      if (idle) { end(idle, 'stopped to make room for another session'); return true; }
      if (now() >= until) return false;
      await wait(100);
    }
  }

  const reaper = setInterval(() => {
    for (const session of [...sessions.values()]) {
      if (session.busy === 0 && now() - session.used > idleMs) end(session, 'idle too long');
      else if (now() - session.born > maxAgeMs && session.busy === 0) end(session, 'open too long');
    }
  }, sweepMs);
  reaper.unref?.();

  async function body(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxBodyBytes) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const send = (response, status, value, headers = {}) => {
    const text = value === undefined ? '' : JSON.stringify(value);
    response.writeHead(status, { ...(text ? JSON_TYPE : {}), 'content-length': Buffer.byteLength(text), ...headers });
    response.end(text);
  };

  function reply(request, response, message, headers = {}) {
    const accept = String(request.headers.accept ?? '');
    if (accept && !/application\/json|\*\/\*|application\/\*/.test(accept) && accept.includes('text/event-stream')) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
      response.end(`data: ${JSON.stringify(message)}\n\n`);
    } else send(response, 200, message, headers);
  }

  async function post(request, response, appName) {
    let text;
    try { text = await body(request); } catch (error) { return send(response, error.status ?? 400, errorReply(null, -32600, error.status === 413 ? 'The message is too large.' : 'The message could not be read.')); }
    let parsed;
    try { parsed = JSON.parse(text); } catch { return send(response, 400, errorReply(null, -32700, 'The body is not JSON.')); }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (!messages.length || !messages.every(message => message && typeof message === 'object')) return send(response, 400, errorReply(null, -32600, 'Send a JSON-RPC message.'));
    const sessionId = request.headers['mcp-session-id'];
    const initializing = messages.some(message => message.method === 'initialize');

    if (!sessionId && !initializing) return oneOff(request, response, appName, messages);
    let session;
    if (initializing) {
      if (!(await makeRoom())) return send(response, 503, errorReply(messages[0].id, -32002, 'All sessions are busy; try again in a moment.'), { 'retry-after': '5' });
      session = start(appName);
    } else {
      session = sessions.get(String(sessionId));
      if (!session || session.app !== appName || session.ended) return send(response, 404, errorReply(messages[0].id, -32001, 'This session is not open; initialize again.'));
    }
    session.used = now();
    const answers = await Promise.all(messages.map(message => (isRequest(message) ? ask(session, message) : (writeTo(session, message), null))));
    const replies = answers.filter(Boolean);
    if (initializing && session.ended) return send(response, 502, replies[0] ?? errorReply(messages[0].id, -32000, `The server did not start: ${session.ended}`));
    if (!replies.length) return send(response, 202, undefined);
    const headers = initializing ? { 'mcp-session-id': session.id } : {};
    // A failed initialize leaves no session behind.
    if (initializing && replies.some(item => item.error)) end(session, 'initialize failed');
    return reply(request, response, Array.isArray(parsed) ? replies : replies[0], headers);
  }

  // A caller with no session: start a process, initialize it for them, ask, stop it.
  async function oneOff(request, response, appName, messages) {
    const asked = messages.filter(isRequest);
    if (!asked.length) return send(response, 202, undefined);
    if (!(await makeRoom())) return send(response, 503, errorReply(asked[0].id, -32002, 'All sessions are busy; try again in a moment.'), { 'retry-after': '5' });
    const session = start(appName);
    try {
      const init = await ask(session, { jsonrpc: '2.0', id: `init-${session.id}`, method: 'initialize', params: { protocolVersion: String(request.headers['mcp-protocol-version'] ?? DEFAULT_PROTOCOL), capabilities: {}, clientInfo: { name: 'stdio-mcp-gateway', version: '1' } } });
      if (init.error) return send(response, 502, errorReply(asked[0].id, init.error.code ?? -32000, init.error.message ?? 'The server did not initialize.'));
      writeTo(session, { jsonrpc: '2.0', method: 'notifications/initialized' });
      const replies = await Promise.all(messages.map(message => (isRequest(message) ? ask(session, message) : (writeTo(session, message), null))));
      return reply(request, response, replies.filter(Boolean).length > 1 ? replies.filter(Boolean) : replies.find(Boolean));
    } finally { end(session, 'one-off request done'); }
  }

  function stream(request, response, appName) {
    const session = sessions.get(String(request.headers['mcp-session-id'] ?? ''));
    if (!request.headers['mcp-session-id']) return send(response, 405, errorReply(null, -32601, 'Open a stream with a session id.'), { allow: 'POST, GET, DELETE' });
    if (!session || session.app !== appName || session.ended) return send(response, 404, errorReply(null, -32001, 'This session is not open; initialize again.'));
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(': open\n\n');
    session.streams.add(response);
    const keep = setInterval(() => { session.used = now(); response.write(': keep-alive\n\n'); }, 15_000);
    keep.unref?.();
    request.on('close', () => { clearInterval(keep); session.streams.delete(response); });
  }

  function stop(request, response, appName) {
    const session = sessions.get(String(request.headers['mcp-session-id'] ?? ''));
    if (!session || session.app !== appName) return send(response, 404, errorReply(null, -32001, 'This session is not open.'));
    end(session, 'closed by the caller');
    return send(response, 200, { ok: true });
  }

  return {
    async handle(request, response) {
      try {
        const url = new URL(request.url, 'http://gateway');
        if (url.pathname === '/' && request.method === 'GET') return send(response, 200, { ok: true, apps: Object.keys(apps), sessions: sessions.size, max_sessions: maxSessions });
        const appName = APP_PATH.exec(url.pathname)?.[1];
        if (!appName || !Object.hasOwn(apps, appName)) return send(response, 404, { error: 'No such app.', apps: Object.keys(apps) });
        if (request.method === 'POST') return await post(request, response, appName);
        if (request.method === 'GET') return stream(request, response, appName);
        if (request.method === 'DELETE') return stop(request, response, appName);
        return send(response, 405, { error: 'Use POST, GET or DELETE.' }, { allow: 'POST, GET, DELETE' });
      } catch (error) {
        log(`request failed: ${error?.stack ?? error}`);
        if (!response.headersSent) send(response, 500, errorReply(null, -32603, 'The gateway failed on this request.'));
        else response.end();
      }
    },
    sessions: () => [...sessions.values()].map(session => ({ id: session.id, app: session.app, busy: session.busy, idle_ms: now() - session.used })),
    close() { clearInterval(reaper); for (const session of [...sessions.values()]) end(session, 'the gateway closed'); },
  };
}
