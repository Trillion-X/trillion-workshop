import { readFileSync } from 'node:fs';
import { prepareContentForDiscovery } from './prepare-content-for-discovery.mjs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(`${JSON.stringify(prepareContentForDiscovery(input))}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
