import { readFileSync } from 'node:fs';
import { measureCitationCoverage } from '../read-data/citation-coverage.mjs';

export { measureCitationCoverage };

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(`${JSON.stringify(measureCitationCoverage(input))}\n`);
}
