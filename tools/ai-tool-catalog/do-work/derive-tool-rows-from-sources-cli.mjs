// Explicit command entry; reusable consumers import the sibling library only.
// node parts/ai-tool-catalog/do-work/derive-tool-rows-from-sources-cli.mjs <records file or folder> ...
import { payloadsIn, toolRowsFromSources } from './derive-tool-rows-from-sources.mjs';

void (async () => {
  const paths = process.argv.slice(2);
  if (!paths.length) throw new Error('usage: derive-tool-rows-from-sources-cli.mjs <records file or folder> ...');
  const derived = await toolRowsFromSources(paths.flatMap(payloadsIn));
  process.stdout.write(JSON.stringify({ rows: derived.rows.length, ids: derived.rows.map(row => row.id), unread: derived.unread, refused: derived.refused }, null, 2) + '\n');
  if (derived.unread.length) process.exitCode = 1;
})().catch(error => {
  process.stderr.write(`${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
});
