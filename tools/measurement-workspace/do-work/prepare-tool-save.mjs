import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const descriptorFile = JSON.parse(await readFile(resolve(root, 'tool-rows.json'), 'utf8'));
const descriptor = descriptorFile.records[0].payload;
const data = JSON.parse(await readFile(resolve(root, 'DATA.json'), 'utf8'));
const screen = await readFile(resolve(root, descriptor.screen.module.file), 'utf8');
const main = await readFile(resolve(root, 'main.mjs'), 'utf8');
const ledger = await readFile(resolve(root, '..', 'measurement-ledger', 'read-data', 'aggregation.mjs'), 'utf8');
descriptor.screen.requests = data.interface.requests;

process.stdout.write(`${JSON.stringify({ descriptor, files: { 'main.mjs': main, 'DATA.json': JSON.stringify(data), 'screen.mjs': screen, 'ledger.mjs': ledger } })}\n`);
