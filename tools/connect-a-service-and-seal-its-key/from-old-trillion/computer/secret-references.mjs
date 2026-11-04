// computer/secret-references.mjs
//
// PURPOSE
//   Lets a request name a secret that lives somewhere else (a password manager's command line, a vault's web interface) and
//   resolves it in the host immediately before the request is sent, so the secret is never stored with the request.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: a provider is a row in computer/secret-references.json; nothing here names one. Credentials the provider itself needs
//      come from the environment of this process by name, never from the request and never from source.
//   2. Memory only: a resolved value is kept for `cache_ms` in this process and nowhere else; the cache key is a BLAKE3 hash of the
//      reference, so a key never shows a path. An error never contains a value.
//   3. Abortable: an AbortSignal stops the lookup (the command is killed, the web call cancelled) and nothing is cached from it.
//   4. One lookup per reference at a time: concurrent asks share it.
//   5. The answer lists the values that were placed, for the caller to mask in anything it keeps (parts/http-client/do-work/request-scopes.mjs scrubValues).
//
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const secretSettings = () => JSON.parse(readFileSync(join(HERE, 'secret-references.json'), 'utf8'));
const REFERENCE = /secret:\/\/([A-Za-z0-9._-]+)\/([^\s"'<>]+)/g;
const fail = (message, status = 400, retry = false) => Object.assign(new Error(message), { status, retry });

export function makeSecretResolver({ settings = secretSettings(), env = process.env, now = () => Date.now(), fetchImpl = fetch } = {}) {
  const cache = new Map();
  const flights = new Map();
  const keyOf = (provider, path) => bytesToHex(blake3(new TextEncoder().encode(`${provider}\0${path}`)));

  const fillWith = (text, provider, path) => text.replace(/\{path\}/g, path).replace(/\{env:([A-Za-z0-9_]+)\}/g, (_, name) => {
    if (env[name] === undefined) throw fail(settings.words.missing_env.replace('{provider}', provider.id).replace('{name}', name));
    return env[name];
  });
  const pick = (value, extract) => String(extract).split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), value);

  async function lookup(provider, path, signal) {
    const timeout = AbortSignal.timeout(settings.timeout_ms);
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (stop.aborted) throw fail(settings.words.aborted);
    let value;
    if (provider.kind === 'command') {
      const argv = provider.argv.map(part => fillWith(part, provider, path));
      value = await new Promise((done, bad) => {
        execFile(argv[0], argv.slice(1), { signal: stop, encoding: 'utf8', maxBuffer: 1_000_000 }, (error, out) => (error ? bad(error) : done(out.replace(/\r?\n$/, ''))));
      });
    } else if (provider.kind === 'http') {
      const headers = Object.fromEntries(Object.entries(provider.headers ?? {}).map(([name, text]) => [name, fillWith(text, provider, path)]));
      const answer = await fetchImpl(fillWith(provider.url, provider, path), { headers, signal: stop });
      if (!answer.ok) throw new Error(`answered ${answer.status}`);
      value = pick(await answer.json(), provider.extract);
    } else throw fail(settings.words.failed.replace('{provider}', provider.id));
    if (typeof value !== 'string' || !value) throw fail(settings.words.empty.replace('{provider}', provider.id), 404);
    return value;
  }

  /** The value of one reference (`secret://provider/path`). */
  async function resolve(reference, { signal } = {}) {
    const match = /^secret:\/\/([A-Za-z0-9._-]+)\/(.+)$/.exec(reference ?? '');
    if (!match) throw fail(settings.words.bad_reference.replace('{reference}', String(reference).slice(0, 80)));
    const provider = settings.providers.find(row => row.id === match[1]);
    if (!provider) throw fail(settings.words.unknown_provider.replace('{provider}', match[1]), 404);
    const key = keyOf(provider.id, match[2]);
    const kept = cache.get(key);
    if (kept && kept.until > now()) return kept.value;
    if (signal?.aborted) throw fail(settings.words.aborted);
    if (!flights.has(key)) {
      flights.set(key, lookup(provider, match[2], signal).then(
        value => { cache.set(key, { value, until: now() + settings.cache_ms }); return value; },
        error => { throw error?.status ? error : fail(error?.name === 'AbortError' || error?.code === 'ABORT_ERR' ? settings.words.aborted : settings.words.failed.replace('{provider}', provider.id), 502, true); },
      ).finally(() => flights.delete(key)));
    }
    return flights.get(key);
  }

  return {
    resolve,
    /** `node` with every secret reference in it replaced by its value; { value, placed: [values] }. */
    async resolveAll(node, options) {
      const references = new Set();
      const find = item => {
        if (typeof item === 'string') for (const match of item.matchAll(REFERENCE)) references.add(match[0]);
        else if (Array.isArray(item)) item.forEach(find);
        else if (item && typeof item === 'object') Object.values(item).forEach(find);
      };
      find(node);
      const values = new Map();
      for (const reference of references) values.set(reference, await resolve(reference, options));
      const replace = item => {
        if (typeof item === 'string') return item.replace(REFERENCE, whole => values.get(whole));
        if (Array.isArray(item)) return item.map(replace);
        if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, replace(v)]));
        return item;
      };
      return { value: replace(node), placed: [...values.values()] };
    },
    forgetAll() { cache.clear(); },
  };
}
