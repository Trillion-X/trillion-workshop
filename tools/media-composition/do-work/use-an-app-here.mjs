/**
 * file: parts/media-composition/do-work/use-an-app-here.mjs
 *
 * PURPOSE: On the person's own computer, do one operation in a desktop app through that app's own tool server, the
 * way an AI app talks to it: the server is started on this computer (its `start` command in apps-here.json), spoken to
 * over standard input and output with the Model Context Protocol, kept through a job's operations, and stopped. Without an operation it
 * answers which operations the app offers, with the input each one takes, so an AI can choose one and call again.
 * Runs as the Workshop's `tool:use-an-app-on-this-computer` (placement:caller-sandbox), never in a container, because
 * the app and the person's projects live on that computer.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. It names no app, vendor or operation. Which apps there are, how each server starts, how long it may take and how
 *    it is prepared the first time are rows in apps-here.json; the operations are whatever that server says it has.
 * 2. The server's own answer is returned as it said it (its text and structured content); a server that reports an
 *    error is reported as that error, never as success.
 * 3. A server that stops before it answers (not prepared on this computer yet) is prepared once with its row's
 *    `prepare` command, then started again; anything still wrong is reported with the server's own words.
 * 4. The server is always stopped before this program answers.
 * 5. Files a row `places` (a helper the app itself runs, such as a script it loads when it opens) are copied into the
 *    app's own folder for this computer's platform before the server is asked anything, only when what is there
 *    differs, and the answer says which were put in place and when each takes effect.
 * 6. An app a row says must be running is opened for the person, quietly (`openAppQuietly`): a row whose server works
 *    only inside the running app names that app's program in `needs_open.processes` (the ends of the program paths it
 *    runs as). When none is running, `/usr/bin/open -g -j -a <opens.app>` starts it without focus and hidden (the
 *    person's screen is never taken), then the program and the row's `opens.ready` check are polled for a bounded
 *    time (`open_seconds`, a row's `opens.seconds`). An app already running is never launched again. When it does not
 *    come up, the answer is `ok` false with a plain `said` ("<app> did not start within 90 s."); no answer ever tells
 *    the person or an AI to open the app, so nothing is ever filed on Waiting on you for it. When it cannot be told
 *    whether the app runs, that counts as not running. Listing operations needs no app.
 *
 * Usage: node use-an-app-here.mjs --app <row id> [--operation <name>] [--arguments <JSON object>]
 * Output (stdout, one JSON line):
 *   { app, label, operations: [{ name, about, input }], said }                 no operation: what the app offers
 *   { app, label, operation, ok, answer, said }                                one operation done (or refused)
 *   either answer carries `placed: [{ file, takes_effect }]` when files were put in place this time
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import net from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hearingHere as programHere } from '../../computer-programs/read-data/program-here.mjs';

const HERE = new URL('.', import.meta.url);
export const appsHere = () => JSON.parse(readFileSync(new URL('./apps-here.json', HERE), 'utf8'));

const PROTOCOL = { jsonrpc: '2.0' };

/**
 * Puts the row's `places` files where the app looks for them on this platform: each item is { file (beside this
 * program), into: [{ platform, from, path }], takes_effect }, `from` naming a base folder of this computer. Returns
 * the files written this time; a file already there with the same bytes is left alone.
 */
export function placeFiles(row, { platform = process.platform, bases = { home: os.homedir() }, from = HERE } = {}) {
  const placed = [];
  for (const item of row.places ?? []) {
    const into = item.into.find(place => place.platform === platform);
    if (!into) continue;
    const base = bases[into.from];
    if (base === undefined) throw new Error(`${row.label} names a folder base "${into.from}" this computer does not have.`);
    const target = path.join(base, into.path, path.basename(item.file));
    const bytes = readFileSync(new URL(item.file, from));
    let same = false;
    try { same = readFileSync(target).equals(bytes); } catch { same = false; }
    if (same) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    placed.push({ file: target, takes_effect: item.takes_effect });
  }
  return placed;
}

/** One app row by id, or an error that lists the ids there are. */
export function appRow(rows, id) {
  const row = rows.apps.find(item => item.id === id);
  if (!row) throw new Error(`There is no app "${id}" here. Use one of: ${rows.apps.map(item => `${item.id} (${item.label})`).join(', ')}.`);
  return row;
}

/**
 * Starts one server and speaks to it. Returns { ask(method, params), tell(method, params), stop(), said() } where
 * said() is what the server wrote to standard error, and ask rejects when the server exits or the time is up.
 */
export function startServer(argv, { seconds, env = process.env, spawnImpl = spawn }) {
  const child = spawnImpl(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env });
  const waiting = new Map();
  let buffer = '', stderr = '', next = 0, ended = null;
  const fail = error => { error.stopped = true; ended = error; for (const [, { reject }] of waiting) reject(error); waiting.clear(); };
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = waiting.get(message.id);
      if (!waiter) continue;
      waiting.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.on('error', error => fail(new Error(`${argv[0]} could not start: ${error.message}`)));
  child.on('exit', code => fail(new Error(`The app's server stopped (${code ?? 'signal'}) before it answered.`)));
  const write = message => child.stdin.write(`${JSON.stringify({ ...PROTOCOL, ...message })}\n`);
  return {
    ask(method, params = {}) {
      if (ended) return Promise.reject(ended);
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`The app's server did not answer ${method} within ${seconds} seconds.`)); }, seconds * 1000);
        waiting.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        write({ id, method, params });
      });
    },
    tell: (method, params = {}) => write({ method, params }),
    stop() { child.removeAllListeners('exit'); child.stdin.end(); child.kill(); },
    said: () => stderr.trim(),
  };
}

const run = (argv, { seconds, env }) => new Promise(resolve => {
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  const timer = setTimeout(() => child.kill(), seconds * 1000);
  child.stdout.on('data', chunk => { out = (out + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { out = (out + chunk).slice(-4000); });
  child.on('error', error => { clearTimeout(timer); resolve({ code: -1, out: error.message }); });
  child.on('exit', code => { clearTimeout(timer); resolve({ code, out }); });
});

// What an operation answered: its structured content when it has some, else its text (parsed when it is JSON).
export function answerOf(result = {}) {
  if (result.structuredContent !== undefined) return result.structuredContent.result ?? result.structuredContent;
  const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  try { return JSON.parse(text); } catch { return text; }
}

// Whether an answer reports a failure: the protocol's isError, or the server's own error object.
const failed = (result, answer) => Boolean(result.isError) || Boolean(answer && typeof answer === 'object' && answer.error);
const reasonOf = answer => (typeof answer === 'string' ? answer : [answer?.error?.message, answer?.error?.reason, answer?.error?.remediation].filter(Boolean).join(' ') || JSON.stringify(answer?.error ?? answer));

async function initializedSession(row, rows, { startImpl, answered }) {
  const found = row.check ? programHere([row]) : null;
  if (row.check && !found) throw new Error(`${row.label} needs ${row.check[0]} installed on this computer.`);
  const env = { ...process.env, ...(found?.env ?? {}), ...(row.env ?? {}) };
  const argv = found && row.start[0] === row.check[0] ? [found.program, ...row.start.slice(1)] : row.start;
  const server = startImpl(argv, { seconds: row.answer_seconds ?? rows.answer_seconds, env });
  let closed = false;
  const close = () => { if (!closed) { closed = true; server.stop(); } };
  try {
    await server.ask('initialize', { protocolVersion: rows.protocol_version, capabilities: {}, clientInfo: rows.client });
    server.tell('notifications/initialized');
  } catch (error) {
    error.said = server.said();
    close();
    throw error;
  }
  return {
    close,
    async use({ operation = null, args = {} } = {}) {
      if (closed) throw new Error(`${row.label}'s app session is closed.`);
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments is an object of the operation\'s inputs.');
      try {
        if (!operation) {
          const listed = await server.ask('tools/list');
          answered();
          return { operations: (listed.tools ?? []).map(tool => ({ name: tool.name, about: tool.description ?? '', input: tool.inputSchema ?? {} })) };
        }
        // A dispatched edit may have happened even if its reply never arrives. Never replay it.
        answered();
        const submitted = await server.ask('tools/call', { name: operation, arguments: args });
        return { result: await completedAppResult(server, row.completion?.[operation], submitted) };
      } catch (error) {
        error.said = server.said();
        throw error;
      }
    },
  };
}

// An app may answer with a job before it writes the output. Keep its SAME MCP session alive until that job ends;
// stopping and starting a queued app between reads stops its worker, and a queued answer is never the output.
export async function completedAppResult(server, rule, submitted, { sleep = wait, now = Date.now } = {}) {
  if (!rule || submitted?.isError) return submitted;
  const initial = answerOf(submitted);
  const at = (value, path) => String(path ?? '').split('.').filter(Boolean).reduce((part, key) => part?.[key], value);
  const seconds = Number(rule.timeout_seconds);
  const interval = Number(rule.interval_ms);
  if (!rule.poll?.operation || !rule.status_field || !rule.done || !Number.isFinite(seconds) || seconds < 1 || seconds > 900 || !Number.isFinite(interval) || interval < 100 || interval > 30000) throw new Error('The app completion rule needs a bounded timeout, interval and status read.');
  const bind = value => Array.isArray(value) ? value.map(bind) : value && typeof value === 'object'
    ? Object.keys(value).length === 1 && typeof value.reply === 'string'
      ? at(initial, value.reply) ?? (() => { throw new Error(`The app gave no ${value.reply} for its completion read.`); })()
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item)])) : value;
  const pollArgs = bind(rule.poll.arguments ?? {});
  const deadline = now() + seconds * 1000;
  let result = submitted;
  for (;;) {
    const answer = answerOf(result);
    const status = at(answer, rule.status_field);
    if (result?.isError || status === rule.done) return result;
    if ((rule.failed ?? []).includes(status)) return { ...result, isError: true };
    if (now() >= deadline) {
      if (rule.cancel?.operation) await server.ask('tools/call', { name: rule.cancel.operation, arguments: bind(rule.cancel.arguments ?? {}) }).catch(() => {});
      throw new Error(`The app did not finish its job within ${seconds} seconds.`);
    }
    await sleep(Math.min(interval, Math.max(1, deadline - now())));
    result = await server.ask('tools/call', { name: rule.poll.operation, arguments: pollArgs });
  }
}

/** The program paths running on this computer now (`ps`), or null when they cannot be read. */
export function runningPrograms() {
  try { return execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\n').map(line => line.trim()).filter(Boolean); }
  catch { return null; }
}

/** Whether the app a row's `needs_open` names is running now (invariant 6); true for a row that needs none. */
export function appIsOpen(row, programs) {
  const wanted = row.needs_open?.processes;
  if (!Array.isArray(wanted) || !wanted.length) return true;
  return Array.isArray(programs) && programs.some(program => wanted.some(end => program.endsWith(end)));
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** What launching an app needs: the row's `opens` ({ app, args, ready, seconds }), its `app` defaulting to the row's label.
 * Static `args` become separate values after native open's --args; they are never parsed as shell text. */
export const opensOf = row => ({ ...(row.opens ?? {}), app: row.opens?.app ?? row.label });

// The same text as the app's own sorted-key compact JSON, which its signature covers.
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

/** Whether an app's loopback helper answers a signed `health` line (its row's `opens.ready.signed_health.config`, a
 *  JSON file with host, port and token; `~/` is this computer's home). False while the file or the helper is not there. */
export async function signedHealthAnswers(spec, { home = os.homedir(), connect = net.connect } = {}) {
  let config;
  try { config = JSON.parse(readFileSync(String(spec.config).replace(/^~\//, `${home}/`), 'utf8')); } catch { return false; }
  if (!config?.token || !Number.isInteger(config.port)) return false;
  const request = { protocol: '1.0', id: randomBytes(8).toString('hex'), timestamp: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('hex'), operation: 'health', arguments: {} };
  const line = JSON.stringify({ ...request, signature: createHmac('sha256', config.token).update(canonical(request)).digest('hex') });
  return new Promise(resolve => {
    const socket = connect({ host: config.host ?? '127.0.0.1', port: config.port });
    let reply = '';
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(3000, () => done(false));
    socket.on('error', () => done(false));
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', chunk => {
      reply += chunk;
      if (!reply.includes('\n')) return;
      try { done(JSON.parse(reply.split('\n')[0]).ok === true); } catch { done(false); }
    });
    socket.on('close', () => done(false));
  });
}

const READY = { signed_health: signedHealthAnswers };
const readyOf = async (row, deps) => {
  const checks = Object.entries(opensOf(row).ready ?? {});
  for (const [kind, spec] of checks) if (!(await READY[kind]?.(spec, deps))) return false;
  return true;
};

const openApp = (app, launch = spawn, args = []) => new Promise(resolve => {
  const child = launch('/usr/bin/open', ['-g', '-j', '-a', app, ...(args.length ? ['--args', ...args] : [])], { stdio: ['ignore', 'ignore', 'pipe'] });
  let out = '';
  child.stderr.on('data', chunk => { out = (out + chunk).slice(-400); });
  child.on('error', error => resolve({ code: -1, out: error.message }));
  child.on('exit', code => resolve({ code, out }));
});

/**
 * Makes sure the app a row's `needs_open` names is running (invariant 6), opening it in the background without focus
 * when it is closed: `{ ok: true, opened }` once it runs and answers (`opened` false when it already ran, so nothing
 * was launched), else `{ ok: false, said }` in plain words. `deps` (all optional) are the process list, the launch
 * (`/usr/bin/open -g -j -a`, with declared args), the readiness check, the clock and the pause, so a test runs none
 * of them for real. A running process still has to answer its declared readiness check; it is never relaunched.
 */
export async function openAppQuietly(row, { running = runningPrograms, launch = spawn, open = app => openApp(app, launch, opensOf(row).args ?? []), ready = readyOf, sleep = wait, now = Date.now, seconds, pollMs = 1000, rows } = {}) {
  const alreadyOpen = appIsOpen(row, running());
  const { app, seconds: rowSeconds } = opensOf(row);
  const limit = seconds ?? rowSeconds ?? rows?.open_seconds ?? 90;
  if (!alreadyOpen) {
    const launched = await open(app);
    if (launched.code !== 0) return { ok: false, said: `${app} could not be started on this Mac${launched.out?.trim() ? `: ${launched.out.trim().slice(-300)}` : '.'}` };
  }
  const deadline = now() + limit * 1000;
  for (;;) {
    if (appIsOpen(row, running()) && await ready(row)) return { ok: true, opened: !alreadyOpen };
    if (now() >= deadline) return { ok: false, said: alreadyOpen ? `${app} is running, but its connection did not answer within ${limit} s.` : `${app} did not start within ${limit} s.` };
    await sleep(pollMs);
  }
}

/** One initialized app session for an entire job. The child is closed even when the job throws. */
export async function withAppSession({ app, rows = appsHere(), startImpl = startServer, runImpl = run, placeImpl = placeFiles, runningImpl = runningPrograms, openImpl = openAppQuietly, openDeps = {}, platform = process.platform, arch = process.arch, openForOperation = true }, work) {
  const row = appRow(rows, app);
  if (row.platforms && !row.platforms.includes(`${platform}-${arch}`)) throw new Error(`${row.label} does not run on this computer (${platform}-${arch}).`);
  if (typeof work !== 'function') throw new Error('An app session needs a job to run.');
  // Files go in place before the app is opened, so an app started now loads a helper put there this time.
  const placed = placeImpl(row);
  if (openForOperation) {
    const opened = await openImpl(row, { running: runningImpl, rows, ...openDeps });
    if (!opened.ok) return { app: row.id, label: row.label, ok: false, said: opened.said };
  }
  const placedSaid = placed.map(item => ` Put ${path.basename(item.file)} in place; it works ${item.takes_effect}.`).join('');
  const withPlaced = answer => (placed.length ? { ...answer, placed, said: `${answer.said}${placedSaid}` } : answer);
  let answered = false;
  const perform = async () => {
    const session = await initializedSession(row, rows, { startImpl, answered: () => { answered = true; } });
    try {
      return await work({
        close: session.close,
        async use({ operation = null, args = {} } = {}) {
          const done = await session.use({ operation, args });
          if (!operation) return withPlaced({ app: row.id, label: row.label, operations: done.operations, said: `${row.label} offers ${done.operations.length} operations on this computer.` });
          const answer = answerOf(done.result);
          const ok = !failed(done.result, answer);
          const content = (done.result.content ?? []).filter(part => part.type !== 'text');
          return withPlaced({ app: row.id, label: row.label, operation, ok, answer, ...(content.length ? { content } : {}), said: ok ? `${row.label} did ${operation}.` : `${row.label} did not do ${operation}: ${reasonOf(answer)}` });
        },
      });
    } finally {
      session.close();
    }
  };
  try { return await perform(); }
  catch (error) {
    // Once an operation was dispatched, restarting could replay an edit whose reply was lost.
    if (!row.prepare || !error.stopped || answered) throw error;
    const prepared = await runImpl(row.prepare, { seconds: row.prepare_seconds ?? rows.prepare_seconds, env: { ...process.env, ...(row.env ?? {}) } });
    if (prepared.code !== 0) throw new Error(`${row.label} could not be prepared on this computer: ${prepared.out.trim().slice(-600) || error.message}`);
    return perform();
  }
}

/** The single-operation entry point uses the same session lifetime and result shape. */
export async function useAnAppHere({ operation = null, args = {}, ...options }) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments is an object of the operation\'s inputs.');
  const answer = await withAppSession({ ...options, openForOperation: Boolean(operation) }, session => session.use({ operation, args }));
  return operation && answer.ok === false && answer.operation === undefined ? { ...answer, operation } : answer;
}

const option = (argv, name) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const raw = option(argv, 'arguments');
  useAnAppHere({ app: option(argv, 'app'), operation: option(argv, 'operation') || null, args: raw ? JSON.parse(raw) : {} })
    .then(answer => process.stdout.write(`${JSON.stringify(answer)}\n`))
    .catch(error => { process.stderr.write(`${error.message}${error.said ? `\n${error.said.slice(-1500)}` : ''}\n`); process.exitCode = 1; });
}
