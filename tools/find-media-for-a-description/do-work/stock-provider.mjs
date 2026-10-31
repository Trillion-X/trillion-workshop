#!/usr/bin/env node
/**
 * file: tools/find-media-for-a-description/do-work/stock-provider.mjs
 *
 * PURPOSE: The `stock` provider executable for find_media.mjs: free-licence (cc0) stock lookup over the libraries in
 * read-data/stock-sources.json, tried in order; the first hit downloads to the requested output.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Sources are data rows: adding one is a row, not a branch (read-data/stock-sources.json, read by stock-pick.mjs)
 * 2. API keys come ONLY from the environment variable the source row names; nothing embedded; a missing key skips
 *    that source with a notice
 * 3. license=cc0 is the only accepted request license
 * 4. A key is sent to the library it belongs to, on the search request only, never to the address the file is
 *    downloaded from
 * 5. Downloads bytes to --out; emits which source satisfied the request
 *
 * Usage: node stock-provider.mjs --describe "<text>" --kind still|clip --license cc0 --out <file> [--sources <file>]
 */
import { createWriteStream, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { pickUrl, searchUrl } from '../read-data/stock-pick.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const DESCRIBE = args.get('describe') ?? '';
const KIND = args.get('kind') ?? 'clip';
const LICENSE = args.get('license') ?? 'cc0';
const OUT = args.get('out');
if (!OUT || !DESCRIBE) {
  console.error('usage: stock-provider.mjs --describe <text> --kind still|clip --license cc0 --out <file> [--sources <file>]');
  process.exit(2);
}

const table = JSON.parse(readFileSync(args.get('sources') ?? join(here, '..', 'read-data', 'stock-sources.json'), 'utf8'));
if (LICENSE !== table.license) {
  console.error(`stock provider serves ${table.license} only; got "${LICENSE}"`);
  process.exit(3);
}

async function trySource(source) {
  const rule = source.kinds?.[KIND];
  if (!rule) {
    console.error(`[find-media:stock] ${source.id}: does not serve ${KIND} — skipped`);
    return null;
  }
  const key = process.env[source.key_env];
  if (!key) {
    console.error(`[find-media:stock] ${source.id}: no ${source.key_env} in env — skipped`);
    return null;
  }
  const headers = source.key_header ? { [source.key_header]: key } : {};
  const response = await fetch(searchUrl(rule.search, DESCRIBE, key), { headers });
  if (!response.ok) {
    console.error(`[find-media:stock] ${source.id}: search failed ${response.status}`);
    return null;
  }
  const mediaUrl = pickUrl(await response.json(), rule.pick);
  if (!mediaUrl) {
    console.error(`[find-media:stock] ${source.id}: no result for "${DESCRIBE}"`);
    return null;
  }
  const media = await fetch(mediaUrl);
  if (!media.ok || !media.body) {
    console.error(`[find-media:stock] ${source.id}: download failed ${media.status}`);
    return null;
  }
  await pipeline(media.body, createWriteStream(OUT));
  return source.id;
}

let satisfied = null;
for (const source of table.sources) {
  satisfied = await trySource(source);
  if (satisfied) break;
}
if (!satisfied) {
  console.error(`no stock source satisfied "${DESCRIBE}" (keys present: ${table.sources.filter((s) => process.env[s.key_env]).map((s) => s.id).join(', ') || 'none'})`);
  process.exit(4);
}
console.log(`[find-media:stock] "${DESCRIBE}" kind=${KIND} -> ${OUT} (source ${satisfied})`);
