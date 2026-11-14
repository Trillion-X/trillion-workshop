#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComputerInterfaceAction } from './computer-interface-actions.mjs';
import { dispatchComputerInterfaceAction } from './computer-interface-providers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf('--input-json');
  if (inputIndex === -1 || !args[inputIndex + 1]) {
    console.error('usage: run-computer-interface-action.mjs --input-json <path>');
    process.exit(2);
  }
  const inputPath = args[inputIndex + 1];
  const request = JSON.parse(await readFile(inputPath, 'utf8'));
  const providersDoc = JSON.parse(await readFile(path.join(here, '..', 'computer-interface-providers.json'), 'utf8'));
  const action = buildComputerInterfaceAction(request, providersDoc);
  const provider = providersDoc.providers.find((p) => p.id === action.provider_id);
  const result = await dispatchComputerInterfaceAction(action, provider);
  const outputPath = inputPath.replace(/\.json$/, '.result.json');
  await writeFile(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || 'internal_error' }));
  process.exit(1);
});
