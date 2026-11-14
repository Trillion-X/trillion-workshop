#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { buildPoolRequest, BrowserPool } from './browser-pool.mjs';

async function main() {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf('--input-json');
  if (inputIndex === -1 || !args[inputIndex + 1]) {
    console.error('usage: run-browser-pool-request.mjs --input-json <path>');
    process.exit(2);
  }
  const inputPath = args[inputIndex + 1];
  const request = JSON.parse(await readFile(inputPath, 'utf8'));
  const action = buildPoolRequest(request);
  const pool = new BrowserPool();
  let result;
  if (action.operation === 'pool.status') result = await pool.status();
  else if (action.operation === 'page.fetch') result = await pool.fetch(action);
  else if (action.operation === 'pages.fetch-many') result = await pool.fetchMany(action);
  else if (action.operation === 'cache.clear') result = await pool.clearCache();
  else result = { ok: false, error: 'unhandled' };
  // The answer goes to stdout and nowhere else. Writing a second copy beside
  // the request left run output sitting in a source folder, where it reads as
  // something somebody meant to keep and gets committed by the next person who
  // stages that directory.
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || 'internal_error' }));
  process.exit(1);
});
