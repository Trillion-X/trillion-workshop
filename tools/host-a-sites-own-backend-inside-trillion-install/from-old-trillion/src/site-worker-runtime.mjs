// Loads one checked site's original Worker module inside an installation-scoped
// Worker Loader isolate. Resource bindings are supplied by the hosting owner.
// The wrapper keeps the original module unchanged while adapting D1's synchronous
// statement construction to an installation-scoped RPC database.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const SITE_WORKER_WRAPPER = `import source from './source.js';

const INTERNAL = '/_trillion_site_worker/';

function database(service) {
  return {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return statement; },
        first(column) { return service.query(sql, values, 'first', column); },
        all() { return service.query(sql, values, 'all'); },
        run() { return service.query(sql, values, 'run'); },
        raw(options) { return service.query(sql, values, 'raw', options); },
        get sql() { return sql; },
        get values() { return values; },
      };
      return statement;
    },
    batch(statements) {
      return service.batch(statements.map(statement => ({ sql: statement.sql, values: statement.values })));
    },
    exec(sql) { return service.exec(sql); },
  };
}

function sourceEnvironment(env) {
  return env.DATABASE ? { ...env, DB: database(env.DATABASE) } : env;
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith(INTERNAL)) {
      if (request.method !== 'POST') return new Response('Not found', { status: 404 });
      const input = await request.json();
      if (path === INTERNAL + 'scheduled' && source.scheduled) {
        await source.scheduled({ cron: input.cron, scheduledTime: input.scheduledTime }, sourceEnvironment(env), ctx);
        return new Response(null, { status: 204 });
      }
      if (path === INTERNAL + 'email' && source.email) {
        const raw = new TextEncoder().encode(input.raw);
        await source.email({ from: input.from, to: input.to, headers: new Headers(input.headers),
          raw: new ReadableStream({ start(controller) { controller.enqueue(raw); controller.close(); } }) }, sourceEnvironment(env), ctx);
        return new Response(null, { status: 204 });
      }
      return new Response('Not found', { status: 404 });
    }
    return source.fetch(request, sourceEnvironment(env), ctx);
  },
};
`;

export function siteWorkerCode({ source, identity, compatibilityDate, compatibilityFlags = [], bindings = {}, outbound = null,
  limits = { cpuMs: 30_000, subRequests: 100 } }) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('The site Worker module is empty.');
  if (typeof identity !== 'string' || !/^1f:[a-f0-9]{64}$/.test(identity)) throw new Error('The site Worker identity is invalid.');
  if (`1f:${bytesToHex(blake3(new TextEncoder().encode(source)))}` !== identity) throw new Error('The site Worker bytes do not match their identity.');
  if (typeof compatibilityDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) throw new Error('The site Worker compatibility date is invalid.');
  if (!Array.isArray(compatibilityFlags) || compatibilityFlags.some(flag => typeof flag !== 'string')) throw new Error('The site Worker flags are invalid.');
  if (!Number.isSafeInteger(limits.cpuMs) || limits.cpuMs < 1 || limits.cpuMs > 60_000 ||
      !Number.isSafeInteger(limits.subRequests) || limits.subRequests < 1 || limits.subRequests > 1000) {
    throw new Error('The site Worker limits are invalid.');
  }
  return {
    compatibilityDate,
    compatibilityFlags,
    mainModule: 'site-wrapper.js',
    modules: { 'site-wrapper.js': SITE_WORKER_WRAPPER, 'source.js': source },
    env: bindings,
    globalOutbound: outbound,
    limits,
  };
}

// Workerd retains a rejected factory under its name. Keep a bounded set of
// current attempts, replacing a failed attempt before trying those bytes again.
// A fresh nonce on re-entry also prevents an evicted failed name being reused.
const loaderAttempts = new WeakMap();
const MAX_LOADER_ATTEMPTS = 128;
export async function runSiteWorker({ loader, request, installationId, identity, configurationIdentity = identity, code }) {
  if (!loader || typeof loader.get !== 'function') throw new Error('The site Worker Loader is unavailable.');
  if (!/^[a-f0-9]{32}$/.test(installationId ?? '')) throw new Error('The site installation is invalid.');
  if (!/^1f:[a-f0-9]{64}$/.test(configurationIdentity)) throw new Error('The site configuration identity is invalid.');
  let attempts = loaderAttempts.get(loader);
  if (!attempts) loaderAttempts.set(loader, attempts = new Map());
  const key = `site:${installationId}:${identity}:${configurationIdentity}`;
  let attempt = attempts.get(key);
  if (!attempt || attempt.failed) attempt = { nonce: crypto.randomUUID(), failed: false };
  attempts.delete(key);
  attempts.set(key, attempt);
  while (attempts.size > MAX_LOADER_ATTEMPTS) attempts.delete(attempts.keys().next().value);
  return loader.get(`${key}:${attempt.nonce}`, async () => {
    try { return await code(); }
    catch (error) { attempt.failed = true; throw error; }
  }).getEntrypoint().fetch(request);
}
