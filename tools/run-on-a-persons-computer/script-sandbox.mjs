// computer/script-sandbox.mjs
//
// PURPOSE
//   Runs a script a person (or their AI) wrote against a request or a record, with no more authority than the host chose to
//   hand it. Used by anything that runs user scripts on this computer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Two walls around the child. It is started through confined-run.mjs (`read-only` tier: a deny-default Seatbelt profile,
//      no writes, no network), the one owner of starting a program inside the OS sandbox, from a Node binary whose BLAKE3 is
//      pinned (computer/script-sandbox.json `node`). Inside that, Node's permission model refuses files, child processes, workers,
//      addons and wasi (no allow flags), so the process refuses them even if the OS wall were missing. The child's environment is
//      the confined environment allowlist. Inside the child, the script runs in a vm context whose global has no prototype, and `pm` is built
//      inside that context from one string-only host call, so no object of the child or Node reaches the script. The vm context
//      keeps the script's realm clean; the process permission is the boundary, not the vm.
//   2. A finite wall clock by default (computer/script-sandbox.json limits); a child still running is killed.
//   3. No ambient authority, and the host does every read. The child has no file grant at all: a script reads files only through
//      `pm.files.read`, which the host answers below the one folder given (a symlink or .. that leaves it is refused, a size cap
//      applies). Cookies only for allowlisted domains; packages only from the allowlist through the host's own loader, with a
//      timeout; a request a script sends goes through the SAME pipeline as a person's request (`sendRequest`), with file bodies
//      removed first.
//   4. Everything that varies (limits, allowlists, words) is computer/script-sandbox.json; this file names no package, host or domain.
//
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostWithin } from '../http-client/do-work/same-origin.mjs';
import { spawnConfined } from './confined-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const sandboxSettings = () => JSON.parse(readFileSync(join(HERE, 'script-sandbox.json'), 'utf8'));
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

function stripFileBodies(request, kinds) {
  if (!request || typeof request !== 'object') return request;
  const { body, ...rest } = request;
  if (body && typeof body === 'object' && kinds.includes(body.kind ?? body.mode)) return rest;
  return request;
}

/** The host side of each capability, over the objects the caller handed in. Returns an async function(kind, args) → value. */
export function makeHostCalls({ settings = sandboxSettings(), files = null, cookies = null, sendRequest = null, loadPackage = null, setCookie = null, callTool = null } = {}) {
  const caps = settings.capabilities;
  const insideFolder = path => {
    if (!files?.folder) throw new Error(settings.words.no_files);
    const root = realpathSync(files.folder);
    let real;
    try { real = realpathSync(join(root, String(path))); } catch { throw new Error(fill(settings.words.outside, { path })); }
    if (real !== root && !real.startsWith(root + sep)) throw new Error(fill(settings.words.outside, { path }));
    return real;
  };
  const allowedDomain = domain => caps.cookies.domains.some(allowed => hostWithin(domain, allowed));
  return async (kind, args) => {
    if (kind === 'files_read') {
      const real = insideFolder(args.path);
      if (statSync(real).size > caps.files.read_max_bytes) throw new Error(fill(settings.words.too_big, { path: args.path, bytes: caps.files.read_max_bytes }));
      return readFileSync(real, 'utf8');
    }
    if (kind === 'cookies_get' || kind === 'cookies_set') {
      if (!cookies || !allowedDomain(args.domain)) throw new Error(fill(settings.words.no_cookies, { domain: args.domain }));
      return kind === 'cookies_get' ? cookies.get(args.domain, args.name) ?? null : (setCookie ?? cookies.set)(args.domain, args.name, args.value) ?? null;
    }
    if (kind === 'require') {
      if (!loadPackage || !caps.packages.allowed.includes(args.name)) throw new Error(fill(settings.words.no_package, { name: args.name }));
      return Promise.race([Promise.resolve(loadPackage(args.name)), new Promise((_, reject) => setTimeout(() => reject(new Error(fill(settings.words.package_slow, { name: args.name, ms: caps.packages.timeout_ms }))), caps.packages.timeout_ms).unref())]);
    }
    if (kind === 'send_request') {
      if (!sendRequest) throw new Error(settings.words.no_requests);
      return sendRequest(stripFileBodies(args, caps.send_request.strip_body_kinds));
    }
    if (kind === 'call_tool') {
      if (!callTool) throw new Error(settings.words.no_tools);
      return callTool(args.tool_id, args.input);
    }
    throw new Error(fill(settings.words.threw, { error: kind }));
  };
}

/** The child's whole program. It is embedded as text and runs under `node --permission`; `vm` is passed in by the host's eval. */
function childMain(vm) {
  const send = message => process.stdout.write(JSON.stringify(message) + '\n');
  const pending = new Map();
  let next = 1;
  // The only function the context ever holds: strings in, one string out through a callback.
  const hostCall = (request, callback) => {
    const id = next++;
    pending.set(id, reply => callback(JSON.stringify(reply)));
    send({ type: 'call', id, request: JSON.parse(request) });
  };
  const BOOT = `(function (call, libraries, input) {
  'use strict';
  const ask = (kind, args) => new Promise((resolve, reject) => {
    call(JSON.stringify({ kind, args }), text => {
      const reply = JSON.parse(text);
      if (reply.error) reject(new Error(reply.error)); else resolve(reply.value);
    });
  });
  const pm = Object.create(null);
  pm.input = input;
  pm.sendRequest = request => ask('send_request', request);
  pm.files = Object.create(null);
  pm.files.read = path => ask('files_read', { path });
  pm.cookies = Object.create(null);
  pm.cookies.get = (domain, name) => ask('cookies_get', { domain, name });
  pm.cookies.set = (domain, name, value) => ask('cookies_set', { domain, name, value });
  pm.require = name => ask('require', { name });
  const global = globalThis;
  global.pm = pm;
  global.call = (toolId, input) => ask('call_tool', { tool_id: toolId, input: input ?? {} });
  for (const [name, source] of Object.entries(libraries)) global[name] = (0, eval)(source);
})`;
  const run = ({ code, input, wall_ms, libraries }) => {
    try {
      const context = Object.create(null);
      vm.createContext(context, { codeGeneration: { strings: true, wasm: false } });
      vm.runInContext(BOOT, context)(hostCall, libraries ?? {}, input ?? null);
      const body = vm.runInContext(`(async function () { 'use strict';\n${code}\n})()`, context, { timeout: wall_ms });
      body.then(
        value => send({ type: 'done', value: JSON.stringify(value === undefined ? null : value) }),
        error => send({ type: 'done', error: String((error && error.message) || error) }),
      );
    } catch (error) {
      send({ type: 'done', error: String((error && error.message) || error) });
    }
  };
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (message.type === 'start') run(message);
      else if (message.type === 'answer' && pending.has(message.id)) {
        const reply = pending.get(message.id);
        pending.delete(message.id);
        reply(message.reply);
      }
    }
  });
}

/** The arguments the child starts with: the permission model on, no allow flag, and the heap cap. The probe test uses the same list. */
export const childArguments = heap_mb => ['--permission', `--max-old-space-size=${heap_mb}`, '--input-type=module',
  '--eval', `import('node:vm').then(vm => (${childMain.toString()})(vm.default));`];

/** Runs `code` (a function body; `return` the result) with `input` in a child process; resolves { value } or { error }. */
export async function runScript({ code, input = null, settings = sandboxSettings(), host = makeHostCalls({ settings }), wall_ms = settings.limits.wall_ms, node = { path: process.execPath, tier: 'read-only', pin: null } } = {}) {
  let child;
  try {
    child = await spawnConfined(node.path, childArguments(settings.limits.heap_mb), { tier: node.tier, pin: node.pin ? { blake3: node.pin } : null });
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
  return new Promise(done => {
    let finished = false;
    let buffer = '';
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      done(result);
    };
    const timer = setTimeout(() => finish({ error: fill(settings.words.timeout, { ms: wall_ms }) }), wall_ms + 50);
    const send = message => { if (!finished) child.stdin.write(JSON.stringify(message) + '\n'); };
    child.stdin.on('error', () => {});
    child.on('error', error => finish({ error: fill(settings.words.threw, { error: String(error?.message ?? error) }) }));
    child.on('exit', () => finish({ error: fill(settings.words.threw, { error: 'the script ended without a result' }) }));
    const answer = async message => {
      let reply;
      try { reply = { value: await host(message.request.kind, message.request.args) ?? null }; } catch (error) { reply = { error: String(error?.message ?? error) }; }
      send({ type: 'answer', id: message.id, reply });
    };
    const handle = line => {
      const message = JSON.parse(line);
      if (message.type === 'call') return answer(message);
      if (message.type !== 'done') return;
      if (message.error) return finish({ error: fill(settings.words.threw, { error: message.error }) });
      return message.value.length > settings.limits.result_chars
        ? finish({ error: fill(settings.words.result_big, { chars: settings.limits.result_chars }) })
        : finish({ value: JSON.parse(message.value) });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > settings.limits.result_chars * 4) return finish({ error: fill(settings.words.result_big, { chars: settings.limits.result_chars }) });
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        handle(line);
      }
    });
    child.stdin.write(JSON.stringify({ type: 'start', code, input, wall_ms, libraries: Object.fromEntries(settings.libraries.map(row => [row.name, row.source])) }) + '\n');
  });
}
