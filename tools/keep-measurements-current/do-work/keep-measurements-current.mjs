import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { collectAndRefresh } from '../read-data/collect.mjs';
import { readSourceConfig, resolveConfiguredInputs, validateGrantedRoots } from '../read-data/source-config.mjs';

export async function run(input, { door, grantedFolder = process.argv[4] }) {
  if (input.action === 'read_source_config') return readSourceConfig(door, input.config_id);
  if (input.action === 'collect_from_config') {
    const config = await readSourceConfig(door, input.config_id);
    await validateGrantedRoots(config, grantedFolder);
    return collectAndRefresh(await resolveConfiguredInputs(config, {
      prices: input.prices,
      prior: input.prior,
      measure_self: input.measure_self,
    }));
  }
  if (Array.isArray(input.source_roots) && Array.isArray(input.receipt_roots)) return collectAndRefresh(input);
  throw new TypeError('action must be read_source_config or collect_from_config.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const input = JSON.parse((await text(process.stdin)) || '{}');
  const result = await collectAndRefresh(input);
  console.log(JSON.stringify({ result }));
}
