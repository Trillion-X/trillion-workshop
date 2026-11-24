// The site's link key arrives on descriptor 3. Its name is input, never its value. The result stays with this run's caller.
import { readFileSync } from 'node:fs';
import { newsletterAudience } from './subscriber-audience.mjs';

try {
  const { key_name, ...input } = JSON.parse(readFileSync(0, 'utf8'));
  const secret = readFileSync(3, 'utf8').trim();
  console.log(JSON.stringify(newsletterAudience({ ...input, secret })));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
