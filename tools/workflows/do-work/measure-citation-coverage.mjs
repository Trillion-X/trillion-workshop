import { readFileSync, realpathSync } from 'node:fs';
import { measureCitationCoverage } from '../read-data/citation-coverage.mjs';
import { pathToFileURL } from 'node:url';

export { measureCitationCoverage };

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(`${JSON.stringify(measureCitationCoverage(input))}\n`);
}
