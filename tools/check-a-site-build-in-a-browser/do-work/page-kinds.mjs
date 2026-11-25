// tools/check-a-site-build-in-a-browser/do-work/page-kinds.mjs
//
// Purpose
//   Reads the page kinds of a built site from the site's own lists, never a hand list: the locs of its sitemap.xml grouped by
//   path shape, plus the top-level .html pages of the folder the sitemap leaves out. One page stands for each kind.
//
// Non-negotiable invariants
//   1. A path of one segment is its own kind; a path of two or more segments is the kind of its parent folder
//      ("/courses/yoga" and "/courses/tennis" are kind "/courses/*"; "/a/b/c" is "/a/b/*"). The first page the sitemap lists
//      for a kind stands for it.
//   2. A sitemap index is followed to the files it names inside the same folder; a loc's host is ignored (a build's sitemap
//      names the live host).
//   3. A top-level .html file the sitemap does not list is a kind of its own; index.html is "/".
//   4. A candidate (an address, no folder) is read the same way over HTTP: sitemapPathsAt.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileFor } from './serve-build.mjs';

const locsOf = xml => [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map(found => found[1].replace(/&amp;/g, '&'));
const pathOf = loc => { try { return new URL(loc, 'http://local').pathname; } catch { return null; } };
const clean = path => (path.length > 1 ? path.replace(/\/+$/, '') : path) || '/';

/** The kind a path belongs to. */
export function kindOf(path) {
  const parts = clean(path).split('/').filter(Boolean);
  return parts.length < 2 ? clean(path) : `/${parts.slice(0, -1).join('/')}/*`;
}

function sitemapPaths(root, sitemapPath, seen = new Set()) {
  const file = fileFor(root, sitemapPath);
  if (!file || seen.has(file)) return [];
  seen.add(file);
  const xml = readFileSync(file, 'utf8');
  const locs = locsOf(xml).map(pathOf).filter(Boolean);
  return /<sitemapindex/i.test(xml) ? locs.flatMap(path => sitemapPaths(root, path, seen)) : locs;
}

/** The paths a site's sitemap lists when it is asked over HTTP at `origin` (a sitemap index is followed on the same origin); [] when it has none. */
export async function sitemapPathsAt(origin, settings, sitemapPath = settings.sitemap_path, seen = new Set()) {
  if (seen.has(sitemapPath)) return [];
  seen.add(sitemapPath);
  let xml;
  try {
    const answer = await fetch(new URL(sitemapPath, origin), { signal: AbortSignal.timeout(settings.navigation_timeout_ms) });
    if (!answer.ok) return [];
    xml = await answer.text();
  } catch { return []; }
  const locs = locsOf(xml).map(pathOf).filter(Boolean);
  if (!/<sitemapindex/i.test(xml)) return locs.map(clean);
  const nested = [];
  for (const path of locs) nested.push(...await sitemapPathsAt(origin, settings, path, seen));
  return nested;
}

/** Every page kind of the build in `root`: [{ kind, path }], in the order found (the sitemap first). */
export function pageKinds(root, settings) {
  if (!existsSync(root)) throw new Error(`The built folder ${root} does not exist.`);
  const listed = sitemapPaths(root, settings.sitemap_path).map(clean);
  const unlisted = readdirSync(root).filter(name => name.endsWith('.html')).map(name => (name === 'index.html' ? '/' : `/${name.slice(0, -5)}`)).filter(path => !listed.includes(path));
  const kinds = new Map();
  for (const path of [...listed, ...unlisted]) if (!kinds.has(kindOf(path))) kinds.set(kindOf(path), path);
  return [...kinds].map(([kind, path]) => ({ kind, path }));
}
