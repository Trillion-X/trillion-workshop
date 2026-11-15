import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sourceCoverage } from '../read-data/source-coverage.mjs';
export { sourceCoverage };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = sourceCoverage(JSON.parse(readFileSync(0, 'utf8')));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
