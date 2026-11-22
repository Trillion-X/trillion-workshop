import { realpathSync } from 'node:fs';
// tools/save-what-you-watch-and-read/do-work/find-my-x-account.mjs
//
// Answers whose X account the person's connection holds: X's own users/me answer, { data: { id, username, name } }.
// The event listener keeps the id as its route key, so a listening source starts only once the account is known.
// Run by tool:find-my-x-account in the tool container, token on descriptor 3 (see api-source.mjs tokenFrom).
//
//   node do-work/find-my-x-account.mjs < <the input as JSON, e.g. {}>
//
// It reads only; nothing is posted, liked, followed or changed on X.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { accountOf } from './api-source.mjs';

export { accountOf };

async function main() {
  const request = JSON.parse(readFileSync(0, 'utf8') || '{}');
  process.stdout.write(`${JSON.stringify(await accountOf(request))}\n`);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
