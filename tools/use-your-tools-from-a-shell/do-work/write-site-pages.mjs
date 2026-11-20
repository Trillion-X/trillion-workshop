#!/usr/bin/env node
// tools/use-your-tools-from-a-shell/do-work/write-site-pages.mjs
//
// Purpose
//   Writes the pages a site serves so anyone can put the site's own command on a computer with one line and sign in at that
//   site: `cli/client.json` (this program's OAuth client document, client-metadata.json), `cli/install` (install.sh) and
//   `cli/program/` (every file command.json `install.files` names, and files.txt listing them), and the other client
//   documents command.json `site_clients` names (a tool's own file, at its page). {origin} in each is the
//   site's own origin, and {site_name} and {cli} are the site's name and command word, read from any file of its owner's by JSON Pointer (the same values its sign-in pages
//   wear), so one site's pages never name another's and this tool names no product.
//
//   node write-site-pages.mjs ORIGIN PAGES_FOLDER FILE [NAME_POINTER] [CLI_POINTER]   (pointers default to /name and /cli)
//
// Non-negotiable invariants
//   1. The bytes are this folder's own files; nothing is written by hand, and a page is rewritten only when its bytes change.
//   2. ORIGIN must be an https origin (a loopback http origin is allowed for a test), with no path; the site's name is plain
//      words and its cli a plain command name, so neither can break the install line's quoting.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import settings from './command.json' with { type: 'json' };

const HERE = dirname(fileURLToPath(import.meta.url));

/** The pages for `origin` and its site `{ name, cli }`, as [{ page, bytes }] with page relative to the pages folder. */
export function sitePages(origin, site, { rules = settings, from = HERE } = {}) {
  const url = URL.canParse(origin) ? new URL(origin) : null;
  const loopback = url && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!url || (url.protocol !== 'https:' && !loopback) || url.origin !== origin) throw new Error(`${origin} is not an origin (https://host, no path)`);
  // A site's name is words in any script; only what could break the install line's quoting is refused.
  if (!/^[^\p{C}'"\\`$]{1,64}$/u.test(site?.name ?? '') || site.name.trim() !== site.name) throw new Error('the site\'s name must be words with no quote, backslash, backtick, dollar or control character');
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(site?.cli ?? '')) throw new Error('the site\'s command word must be a plain command name');
  const values = { origin, site_name: site.name, cli: site.cli, program: rules.install.files[0] };
  const filled = name => Buffer.from(readFileSync(join(from, name), 'utf8').replace(/\{(origin|site_name|cli|program)\}/g, (whole, key) => values[key]));
  return [
    { page: 'cli/client.json', bytes: filled('client-metadata.json') },
    ...(rules.site_clients?.pages ?? []).map(({ page, file }) => ({ page, bytes: filled(file) })),
    { page: 'cli/install', bytes: filled('install.sh') },
    { page: 'cli/program/files.txt', bytes: Buffer.from(`${rules.install.files.join('\n')}\n`) },
    ...rules.install.files.map(name => ({ page: `cli/program/${name}`, bytes: readFileSync(join(from, name)) })),
  ];
}

/** Writes the pages under `folder`; answers each page with whether it changed, and each page of the program folder this
 *  set no longer holds (a renamed or dropped file) with removed: true, so the site never serves a file the program left. */
export function writeSitePages(origin, site, folder, options) {
  const pages = sitePages(origin, site, options);
  const written = pages.map(({ page, bytes }) => {
    const path = join(folder, page);
    let same = false;
    try { same = readFileSync(path).equals(bytes); } catch { /* not there yet */ }
    if (!same) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
    return { page, changed: !same };
  });
  const kept = new Set(pages.map(({ page }) => page));
  const program = join(folder, 'cli/program');
  const left = existsSync(program) ? readdirSync(program, { recursive: true }).map(name => `cli/program/${name}`).filter(page => !kept.has(page) && statSync(join(folder, page)).isFile()) : [];
  for (const page of left) rmSync(join(folder, page));
  return [...written, ...left.map(page => ({ page, removed: true }))];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [origin, folder, file, namePointer = '/name', cliPointer = '/cli'] = process.argv.slice(2);
  if (!origin || !folder || !file) { process.stderr.write('usage: write-site-pages.mjs ORIGIN PAGES_FOLDER FILE [NAME_POINTER] [CLI_POINTER]\n'); process.exit(2); }
  const whole = JSON.parse(readFileSync(file, 'utf8'));
  const at = pointer => pointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((held, key) => held?.[key], whole);
  const site = { name: at(namePointer), cli: at(cliPointer) };
  for (const row of writeSitePages(origin, site, folder)) process.stdout.write(`${row.removed ? 'removed' : row.changed ? 'written' : 'unchanged'}: ${row.page}\n`);
}
