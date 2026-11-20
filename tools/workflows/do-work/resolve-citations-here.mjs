// tools/workflows/do-work/resolve-citations-here.mjs
//
// Run by tool:resolve-citations on the person's computer, once per repository folder granted to the run:
//
//   node do-work/resolve-citations-here.mjs <the granted folder> < <the input as JSON>
//
// It prints the answer on its last line as { result }, or { error } with a non-zero status when it cannot answer honestly
// (no folder granted, no items). The function it calls is read-data/resolve-citations.mjs.
import { text } from 'node:stream/consumers';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [folder] = process.argv.slice(2);
try {
  if (!folder) throw new Error('usage: resolve-citations-here.mjs <the granted folder> < input.json');
  const here = new URL('../read-data/resolve-citations.mjs', import.meta.url);
  const { resolveCitationsInGrantedRoot } = await import(pathToFileURL(join(here.pathname)).href);
  const input = JSON.parse((await text(process.stdin)) || '{}');
  const answer = await resolveCitationsInGrantedRoot(input, folder);
  process.stdout.write(`${JSON.stringify(answer)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: { message: String(error?.message ?? error) } })}\n`);
  process.exitCode = 1;
}
