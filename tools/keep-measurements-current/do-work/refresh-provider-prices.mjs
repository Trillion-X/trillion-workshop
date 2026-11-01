import { readFile } from 'node:fs/promises';
import { projectPriceSource } from '../read-data/provider-prices.mjs';
const source = JSON.parse(await readFile(new URL('../read-data/provider-price-source.json', import.meta.url), 'utf8'));
process.stdout.write(JSON.stringify(projectPriceSource(source), null, 2) + '\n');
