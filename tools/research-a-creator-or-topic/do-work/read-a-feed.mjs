// tools/research-a-creator-or-topic/do-work/read-a-feed.mjs
//
// The latest items of an Atom or RSS feed. Run by the Workshop tool `tool:list-the-latest-items-of-a-feed` in the tool
// container:
//
//   node do-work/read-a-feed.mjs < {"url": "...", "limit": 50}
//
// Prints { source, subject_ref, count, items } on its last line.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchText } from './fetch-text.mjs';
import { readFeed } from './sources.mjs';

const DEFAULT_LIMIT = 50;
const MOST = 200;

export async function readAFeed(input, fetchPage) {
  const url = typeof input?.url === 'string' ? input.url.trim() : '';
  if (!url) throw new Error('Send url: the address of the feed.');
  const limit = input.limit === undefined ? DEFAULT_LIMIT : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MOST) throw new Error(`limit is a whole number from 1 to ${MOST}.`);
  const feed = readFeed(await fetchText(url, { accept: 'application/atom+xml,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5', fetchPage }));
  const items = feed.items.slice(0, limit);
  return { source: feed.source, subject_ref: url, count: items.length, items };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await readAFeed(JSON.parse(readFileSync(0, 'utf8') || '{}')))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 2;
  }
}
