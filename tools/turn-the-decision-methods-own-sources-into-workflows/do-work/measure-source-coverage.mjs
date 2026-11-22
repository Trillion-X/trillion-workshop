import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sourceCoverage } from '../read-data/source-coverage.mjs';
export { sourceCoverage };
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const result = sourceCoverage(JSON.parse(readFileSync(0, 'utf8')));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
