// tools/research-a-creator-or-topic/do-work/search-the-public-web.mjs
//
// A public web search: at most ten results, each with the address it cites. Run by the Workshop tool
// `tool:search-the-public-web` in the tool container:
//
//   node do-work/search-the-public-web.mjs < {"query": "..."}
//
// It reads the one search results page and follows no result. Prints { source, subject_ref, count, items } on its last line.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchText } from './fetch-text.mjs';
import { readSearchResults, searchUrl } from './sources.mjs';

export async function searchThePublicWeb(input, fetchPage) {
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  const feed = readSearchResults(await fetchText(searchUrl(query), { accept: 'text/html', fetchPage }));
  return { source: feed.source, subject_ref: query, count: feed.items.length, items: feed.items };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await searchThePublicWeb(JSON.parse(readFileSync(0, 'utf8') || '{}')))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 2;
  }
}
