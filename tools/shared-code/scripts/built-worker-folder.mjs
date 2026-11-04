// scripts/built-worker-folder.mjs
//
// PURPOSE
//   Where the two Workers sit in a folder built the way a deploy builds it (scripts/deploy-worker.mjs, visual-check.mjs,
//   check-narrow-widths.mjs, worker-in-browser.mjs): the Worker's main module, the chunks the build splits out
//   (scripts/build-worker.mjs) and the locked box's compiled modules live in `worker/`; the engines Worker
//   (src/hosts/cloudflare/engines-worker.mjs) and the compiled engines it loads live in `engines/`; both beside `assets/` (the
//   workspace's files). scripts/build-worker.mjs, given WORKER_OUT=builtWorkerFile(out) and
//   ENGINES_OUT=builtEnginesFile(out), puts each compiled module beside the Worker its row in
//   scripts/compiled-modules.mjs names.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Wrangler uploads every file its rules match under the main module's folder as a Worker module, and every
//      isolate compiles each uploaded .wasm when it starts, imported or not. So nothing but the Worker's own modules
//      may sit under `worker/`: the workspace's wasm and licence texts once rode along as Worker modules (about 11 MB
//      of wasm compiled on every store's start, found 2026-10-06). The compiled engines are about 12 MB more, so they
//      sit under `engines/`, uploaded with the engines Worker alone, and the main Worker reaches them through its
//      ENGINES service binding (enginesBinding).
//   2. The chunks are named by WORKER_MODULE_RULES, relative to `worker/`; wrangler's own rules take the rest (.wasm).
//      The rule falls through, because wrangler reads only the first rule of each type: a caller's own ESModule rule
//      after it (worker-in-browser.mjs names worker.mjs and the glue) would otherwise be ignored.
//
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The folder holding the Worker's modules inside a built folder `out`. */
export const builtWorkerFolder = out => join(out, 'worker');
/** The Worker's main module inside a built folder `out`. */
export const builtWorkerFile = out => join(builtWorkerFolder(out), 'worker.mjs');
/** The Worker's main module relative to a config file kept in `out`. */
export const BUILT_WORKER_MAIN = './worker/worker.mjs';
/** Modules uploaded beside the main module beyond wrangler's own rules: the split-out chunks. */
export const WORKER_MODULE_RULES = [{ type: 'ESModule', globs: ['chunks/*.mjs'], fallthrough: true }];
/**
 * The Worker's settings as wrangler.jsonc in the checkout `source` keeps them (its comments are whole lines). Its
 * compatibility date and flags are the Worker's everywhere: a deploy (scripts/deploy-worker.mjs), a run in workerd for
 * a browser (worker-in-browser.mjs) and the deploy gate's test read them here, so a flag is never on in one and off in
 * another.
 */
export const localWorkerSettings = source => JSON.parse(readFileSync(join(source, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
/** The engines Worker's folder and main module inside a built folder `out` (src/hosts/cloudflare/engines-worker.mjs). */
export const builtEnginesFolder = out => join(out, 'engines');
export const builtEnginesFile = out => join(builtEnginesFolder(out), 'worker.mjs');
/** The engines Worker's name beside the Worker named `script`, and the main Worker's binding to it. */
export const enginesScript = script => `${script}-engines`;
export const enginesBinding = script => ({ binding: 'ENGINES', service: enginesScript(script) });

/** The private provider is built from its own source, never from the main Worker's module folder. */
export function writePagesDomainProviderConfig(out, { name, source, accountId, project, appKv, saas }) {
  if (saas && (!/^[a-f0-9]{32}$/.test(saas.zoneId ?? '') || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(saas.carrierHost ?? '')
    || saas.defaultProvider && !['cloudflare-pages', 'cloudflare-saas'].includes(saas.defaultProvider))) throw new Error('Declare the provisioned SaaS zone, carrier and selected provider.');
  mkdirSync(out, { recursive: true });
  const file = join(out, 'wrangler-domain-provider.json');
  writeFileSync(file, JSON.stringify({
    name, main: resolve(source, 'src/public-app-domain-provider.mjs'), compatibility_date: '2026-09-01',
    workers_dev: false, preview_urls: false,
    kv_namespaces: [{ binding: 'APP_KV', id: appKv }],
    vars: { CLOUDFLARE_ACCOUNT_ID: accountId, PUBLIC_APP_PAGES_PROJECT: project, ...(saas ? {
      PUBLIC_APP_SAAS_ZONE_ID: saas.zoneId, PUBLIC_APP_SAAS_CARRIER_HOST: saas.carrierHost,
      ...(saas.defaultProvider ? { PUBLIC_APP_DEFAULT_DOMAIN_PROVIDER: saas.defaultProvider } : {}),
    } : {}) },
  }, null, 2));
  return file;
}

/** The SaaS zone's catch-all ingress; provisioning its DNS/route is separate. */
export function writePublicAppDomainCarrierConfig(out, { name, source, service, zoneId, route }) {
  if (!/^[a-f0-9]{32}$/.test(zoneId ?? '') || route !== '*/*') throw new Error('A SaaS carrier needs its exact zone catch-all route.');
  mkdirSync(out, { recursive: true });
  const file = join(out, 'wrangler-domain-carrier.json');
  writeFileSync(file, JSON.stringify({ name, main: resolve(source, 'src/public-app-domain-carrier.mjs'), compatibility_date: '2026-09-01',
    workers_dev: false, preview_urls: false, routes: [{ pattern: route, zone_id: zoneId }],
    services: [{ binding: 'TRILLION', service }],
  }, null, 2));
  return file;
}

/**
 * The engines Worker's wrangler config, written into a built folder `out` beside the main Worker's (its main module is
 * relative to it). `script` names the main Worker; `extra` is what a deploy adds (logs, limits, no public address).
 * Returns the config file's path.
 */
export function writeEnginesConfig(out, { script, compatibility_date, compatibility_flags, extra = {} }) {
  mkdirSync(out, { recursive: true });
  const file = join(out, 'engines-wrangler.json');
  writeFileSync(file, JSON.stringify({
    name: enginesScript(script), main: './engines/worker.mjs', no_bundle: true, find_additional_modules: true,
    rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'] }], compatibility_date, compatibility_flags, ...extra,
  }));
  return file;
}
