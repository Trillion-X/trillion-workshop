#!/usr/bin/env node
// tools/use-trillion-from-a-shell/do-work/write-site-pages.mjs
//
// Purpose
//   Writes the pages a site serves so anyone can put the `trillion` command on a computer with one line and sign in at that
//   site: `cli/client.json` (this program's OAuth client document, client-metadata.json), `cli/install` (install.sh) and
//   `cli/program/` (every file trillion.json `install.files` names, and files.txt listing them). {origin} in each is the
//   site's own origin, so one site's pages never name another's.
//
//   node write-site-pages.mjs ORIGIN PAGES_FOLDER
//
// Non-negotiable invariants
//   1. The bytes are this folder's own files; nothing is written by hand, and a page is rewritten only when its bytes change.
//   2. ORIGIN must be an https origin (a loopback http origin is allowed for a test), with no path.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import settings from './trillion.json' with { type: 'json' };

const HERE = dirname(fileURLToPath(import.meta.url));

/** The pages for `origin`, as [{ page, bytes }] with page relative to the pages folder. */
export function sitePages(origin, { rules = settings, from = HERE } = {}) {
  const url = URL.canParse(origin) ? new URL(origin) : null;
  const loopback = url && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!url || (url.protocol !== 'https:' && !loopback) || url.origin !== origin) throw new Error(`${origin} is not an origin (https://host, no path)`);
  const filled = name => Buffer.from(readFileSync(join(from, name), 'utf8').replaceAll('{origin}', origin));
  return [
    { page: 'cli/client.json', bytes: filled('client-metadata.json') },
    { page: 'cli/install', bytes: filled('install.sh') },
    { page: 'cli/program/files.txt', bytes: Buffer.from(`${rules.install.files.join('\n')}\n`) },
    ...rules.install.files.map(name => ({ page: `cli/program/${name}`, bytes: readFileSync(join(from, name)) })),
  ];
}

/** Writes the pages under `folder`; answers each page with whether it changed. */
export function writeSitePages(origin, folder, options) {
  return sitePages(origin, options).map(({ page, bytes }) => {
    const path = join(folder, page);
    let same = false;
    try { same = readFileSync(path).equals(bytes); } catch { /* not there yet */ }
    if (!same) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
    return { page, changed: !same };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [origin, folder] = process.argv.slice(2);
  if (!origin || !folder) { process.stderr.write('usage: write-site-pages.mjs ORIGIN PAGES_FOLDER\n'); process.exit(2); }
  for (const row of writeSitePages(origin, folder)) process.stdout.write(`${row.changed ? 'written' : 'unchanged'}: ${row.page}\n`);
}
