#!/usr/bin/env node
/**
 * file: tools/find-media-for-a-description/do-work/find_media.mjs
 *
 * PURPOSE: ONE entry point turning a media REQUEST (description + kind + constraints) into a file, via DATA-selected
 * providers. The resolver reads the provider table, fills the chosen provider's argv template from the request, and
 * runs it. It contains zero provider branches: the person's own media, a stock library, a generator program, and any
 * future provider are rows in read-data/media-providers.json.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. No provider names in code: dispatch is a table lookup by request.provider
 * 2. The argv template is data; {request.<key>} placeholders fill from the request
 * 3. Constraint checks (kind support, license) are data-vs-request comparisons
 * 4. Output: machine-readable JSON as the last stdout line {"result": {provider, file, request}}
 *
 * Usage: node find_media.mjs [--providers <file>] < request.json
 *   request: {provider, description, kind, out, license?, seed?, bank_dir?, ...}
 * A provider's `run.argv` runs from the tool's own folder, so `do-work/...` in a row means this folder's do-work.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const toolRoot = join(here, '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const request = JSON.parse(readFileSync(0, 'utf8') || '{}');
const providersDoc = JSON.parse(readFileSync(args.get('providers') ?? join(toolRoot, 'read-data', 'media-providers.json'), 'utf8'));

const provider = (providersDoc.providers ?? []).find((p) => p.id === request.provider);
if (!provider) {
  console.error(`unknown provider "${request.provider}" — known: ${(providersDoc.providers ?? []).map((p) => p.id).join(', ')}`);
  process.exit(2);
}
if (request.kind && !provider.kind_support.includes(request.kind)) {
  console.error(`provider ${provider.id} does not support kind "${request.kind}" (supports: ${provider.kind_support.join(', ')})`);
  process.exit(3);
}
if (request.license && !provider.licenses.includes(request.license)) {
  console.error(`provider ${provider.id} cannot satisfy license "${request.license}" (offers: ${provider.licenses.join(', ')})`);
  process.exit(4);
}
if (!request.out) {
  console.error('request.out is required');
  process.exit(5);
}

// Fill the argv template: {request.<key>} → request[key]; unresolved → error.
const argv = provider.run.argv.map((token) =>
  token.replace(/\{request\.([a-z_]+)\}/g, (_, key) => {
    if (!(key in request)) throw new Error(`provider ${provider.id} argv needs request.${key}`);
    return String(request[key]);
  }),
);

execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: provider.run.timeout_ms, cwd: toolRoot, stdio: ['ignore', 'inherit', 'inherit'] });

if (!existsSync(request.out)) {
  console.error(`provider ${provider.id} ran but produced no file at ${request.out}`);
  process.exit(6);
}
console.log(`[find-media] req=${request.description ?? ''} provider=${provider.id} -> ${request.out}`);
console.log(JSON.stringify({ result: { provider: provider.id, file: request.out, request } }));
