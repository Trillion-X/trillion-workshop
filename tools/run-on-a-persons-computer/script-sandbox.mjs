// computer/script-sandbox.mjs
//
// PURPOSE
//   Runs a script a person (or their AI) wrote against a request or a record, with no more authority than the host chose to
//   hand it. Used by anything that runs user scripts on this computer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Isolation: the script runs in its own worker thread (heap-capped, wall-clock limited) in a vm context whose global has no
//      prototype; `pm` is built inside that context from a single string-only host call, so no object of the worker, the host or
//      Node reaches the script, and the host's process is another thread.
//   2. A finite wall clock by default (computer/script-sandbox.json limits); a script still running is terminated.
//   3. No ambient authority. Each capability is a host-supplied object with an allowlist, and absent means refused in words:
//      files are read only below the one folder given (a symlink or .. that leaves it is refused, a size cap applies); cookies only for
//      allowlisted domains; packages only from the allowlist through the host's own loader, with a timeout; a request a script sends
//      goes through the SAME pipeline as a person's request (`sendRequest`), with file bodies removed first.
//   4. Everything that varies (limits, allowlists, words) is computer/script-sandbox.json; this file names no package, host or domain.
//
import { Worker } from 'node:worker_threads';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostWithin } from '../parts/http-client/do-work/same-origin.mjs';

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
export function makeHostCalls({ settings = sandboxSettings(), files = null, cookies = null, sendRequest = null, loadPackage = null, setCookie = null } = {}) {
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
    throw new Error(fill(settings.words.threw, { error: kind }));
  };
}

/** Runs `code` (a function body; `return` the result) with `input`; resolves { value } or { error }. */
export function runScript({ code, input = null, settings = sandboxSettings(), host = makeHostCalls({ settings }), wall_ms = settings.limits.wall_ms } = {}) {
  return new Promise(done => {
    const worker = new Worker(new URL('./script-sandbox-worker.mjs', import.meta.url), {
      workerData: { code, input, wall_ms, libraries: Object.fromEntries(settings.libraries.map(row => [row.name, row.source])) },
      resourceLimits: { maxOldGenerationSizeMb: settings.limits.heap_mb, stackSizeMb: settings.limits.stack_mb },
    });
    let finished = false;
    const finish = result => { if (finished) return; finished = true; clearTimeout(timer); worker.terminate(); done(result); };
    const timer = setTimeout(() => finish({ error: fill(settings.words.timeout, { ms: wall_ms }) }), wall_ms + 50);
    worker.on('message', async message => {
      if (message.done) {
        if (message.done.error) return finish({ error: fill(settings.words.threw, { error: message.done.error }) });
        return message.done.value.length > settings.limits.result_chars
          ? finish({ error: fill(settings.words.result_big, { chars: settings.limits.result_chars }) })
          : finish({ value: JSON.parse(message.done.value) });
      }
      const { id, request } = message.call;
      let reply;
      try { reply = { value: await host(request.kind, request.args) ?? null }; } catch (error) { reply = { error: String(error?.message ?? error) }; }
      if (!finished) worker.postMessage({ id, reply });
    });
    worker.on('error', error => finish({ error: fill(settings.words.threw, { error: String(error?.message ?? error) }) }));
    worker.on('exit', () => finish({ error: fill(settings.words.threw, { error: 'the script ended without a result' }) }));
  });
}
