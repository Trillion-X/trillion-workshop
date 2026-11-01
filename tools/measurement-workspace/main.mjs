import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(await readFile(resolve(here, 'DATA.json'), 'utf8'));
const result = { screen: data.label, opens: data.interface.route };
process.stdout.write(`${JSON.stringify(result)}\n`);
