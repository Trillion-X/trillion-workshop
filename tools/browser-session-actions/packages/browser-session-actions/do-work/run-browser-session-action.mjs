#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BrowserSessionRouteError, selectBrowserSessionRoute, validateIsolatedSurfaceProof } from './browser-session-actions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const inputIndex = process.argv.indexOf('--input-json');
if (inputIndex < 0 || !process.argv[inputIndex + 1]) {
  process.stderr.write(JSON.stringify({ ok: false, code: 'missing_input', error: '--input-json is required' }) + '\n');
  process.exit(2);
}

try {
  const [request, policyDoc] = await Promise.all([
    readFile(process.argv[inputIndex + 1], 'utf8').then(JSON.parse),
    readFile(join(here, '..', 'browser-session-providers.json'), 'utf8').then(JSON.parse),
  ]);
  const route = selectBrowserSessionRoute(request, policyDoc);
  const result = request.surface_proof === undefined
    ? { usable: route.surface_class !== 'task_isolated_agent_screen', route }
    : validateIsolatedSurfaceProof(route, request.surface_proof);
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
} catch (error) {
  const code = error instanceof BrowserSessionRouteError ? error.code : 'unexpected_error';
  process.stderr.write(JSON.stringify({ ok: false, code, error: String(error?.message ?? error) }) + '\n');
  process.exit(1);
}
