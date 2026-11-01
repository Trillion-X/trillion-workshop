// Usage: run-with-stdio-mcp.mjs client.json module.mjs export-name input.json
// client.json supplies argv, resource and optional timeout_ms. It contains no credential.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openStdioRecordsDoor } from '../read-data/stdio-mcp-door.mjs';

const [configFile, moduleFile, name, inputFile] = process.argv.slice(2);
let door;
try {
  if (!configFile || !moduleFile || !name || !inputFile) throw new TypeError('client config, module, export and input file are required.');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const input = JSON.parse(await readFile(inputFile, 'utf8'));
  const fn = (await import(pathToFileURL(resolve(moduleFile)).href))[name];
  if (typeof fn !== 'function') throw new TypeError('The declared module export is not a function.');
  door = openStdioRecordsDoor(config);
  const started = Date.now();
  const result = await fn(input, { door });
  console.log(JSON.stringify({ result, started_at: new Date(started).toISOString(), finished_at: new Date().toISOString() }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, code: error.code ?? null, outcome: error.outcome ?? null }));
  process.exitCode = 1;
} finally { await door?.close(); }
