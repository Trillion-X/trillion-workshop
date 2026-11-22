import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { collectAndRefresh } from '../read-data/collect.mjs';
import { resolveConfiguredInputs, validateGrantedRoots, validateSourceConfig } from '../read-data/source-config.mjs';

// Reads and keeps nothing: the source configuration comes in with the request (`config`) and the collection comes back.
export async function run(input, { grantedFolder = process.argv[2] } = {}) {
  if (input.action === 'collect_from_config') {
    const config = validateSourceConfig(input.config);
    await validateGrantedRoots(config, grantedFolder);
    return collectAndRefresh(await resolveConfiguredInputs(config, {
      prices: input.prices,
      prior: input.prior,
      measure_self: input.measure_self,
    }));
  }
  if (Array.isArray(input.source_roots) && Array.isArray(input.receipt_roots)) return collectAndRefresh(input);
  throw new TypeError('action must be collect_from_config.');
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    console.log(JSON.stringify({ result: await run(JSON.parse((await text(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
