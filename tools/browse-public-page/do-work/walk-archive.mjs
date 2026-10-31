// tools/browse-public-page/do-work/walk-archive.mjs
//
// PURPOSE
//   Walk an outlet's archive with the same page reader that reads one page: from a start address (an archive listing
//   page, or a sitemap) follow its next, older listing pages, collect the entries they list with their days, choose
//   the entries a caller asked for (a window of days, or the eras early, middle and recent, a count of each), and read
//   those pages. Politely: robots.txt first and obeyed, one request at a time, at least min_delay_seconds between
//   requests, at most max_listing_pages listing pages and max_count entry pages.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No network here: `read(address)` fetches one checked page ({ url, final_url, status, media, body }) and `sleep(ms)`
//      waits; both are injected, so the walk is tested with made-up pages and run with the checked, pinned reader.
//   2. Every request is of the start address's own site, is allowed by that site's robots.txt, and follows the delay.
//   3. Nothing is guessed: an entry without a day is never in a window or an era; every shortfall is said in `stopped`
//      and `reached_oldest`, never hidden.

import conventions from './page-conventions.json' with { type: 'json' };
import { checkedUrl, extractPage } from './page-facts.mjs';
import { cdxEntries, eraOf, eraSpans, evenlyDated, inWindow, isSitemap, listingEntries, nextListing, pageDate, robotsRules, sameSite, sitemapEntries, waybackQuery } from './archive-facts.mjs';

const archive = conventions.archive;

const integer = (value, name, low, high, fallback) => {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < low || value > high) throw new Error(`${name} must be a whole number from ${low} to ${high}.`);
  return value;
};
const day = (value, name) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${name} must be a day as YYYY-MM-DD.`);
  return value;
};

/** The walk the caller asked for, checked and filled from the conventions: { source, collapse, window, eras, count, listingPages, delaySeconds }. */
export function checkedWalk(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('walk must be an object.');
  const window = input.window === undefined ? undefined : { from: day(input.window?.from, 'window.from'), to: day(input.window?.to, 'window.to') };
  if (window?.from && window?.to && window.from > window.to) throw new Error('window.from must not be after window.to.');
  const eras = input.eras === undefined ? undefined : input.eras;
  if (eras !== undefined && (!Array.isArray(eras) || !eras.length || eras.some(name => !archive.eras.includes(name)))) throw new Error(`eras must name some of ${archive.eras.join(', ')}.`);
  if (eras && window) throw new Error('Ask for a window of days or for eras, not both.');
  const source = input.source ?? 'listing';
  if (!['listing', 'wayback'].includes(source)) throw new Error('source must be listing or wayback.');
  const collapse = input.collapse ?? archive.wayback.default_collapse;
  if (!Object.hasOwn(archive.wayback.collapse, collapse)) throw new Error(`collapse must be one of ${Object.keys(archive.wayback.collapse).join(', ')}.`);
  const delaySeconds = input.delay_seconds ?? archive.default_delay_seconds;
  if (typeof delaySeconds !== 'number' || !(delaySeconds >= archive.min_delay_seconds && delaySeconds <= archive.max_delay_seconds)) throw new Error(`delay_seconds must be from ${archive.min_delay_seconds} to ${archive.max_delay_seconds}.`);
  return {
    source,
    collapse,
    window,
    eras: eras ? [...new Set(eras)] : undefined,
    count: integer(input.count, 'count', 0, archive.max_count, archive.default_count),
    listingPages: integer(input.max_listing_pages, 'max_listing_pages', 1, archive.max_listing_pages, archive.default_listing_pages),
    delaySeconds,
  };
}

/** Walk an archive: `walkArchive(startAddress, walk, { read, sleep })` => { first, walk }. `first` is the start page as read
 *  (so the caller gives its facts as the single-page read does); `walk` is what the walk found and read:
 *  { listing_pages, entries_seen, dated, span, reached_oldest, eras, pages, requests, delay_seconds, stopped }. */
export async function walkArchive(startAddress, asked, { read, sleep }) {
  const walk = checkedWalk(asked);
  const page0 = checkedUrl(startAddress);
  // The walk's listing is the page's own archive listing, or the Wayback index of snapshots of the page; every request is of the listing's own site.
  const wayback = walk.source === 'wayback';
  const start = wayback ? new URL(waybackQuery(page0.href, walk)) : page0;
  let requests = 0;
  let delayMs = walk.delaySeconds * 1000;
  const paced = async address => {
    if (requests > 0) await sleep(delayMs);
    requests += 1;
    return read(address);
  };

  let rules;
  try {
    const robots = await paced(new URL('/robots.txt', start).href);
    rules = robotsRules(robots.body, archive.robots_agent);
  } catch (error) {
    if (error.status >= 400 && error.status < 500) rules = robotsRules('', archive.robots_agent);
    else throw new Error(`robots.txt could not be read, so nothing was walked: ${error.message}`);
  }
  if (rules.crawlDelay !== null) {
    if (rules.crawlDelay > archive.max_delay_seconds) throw new Error(`The site's robots.txt asks for ${rules.crawlDelay} seconds between requests, more than the ${archive.max_delay_seconds} the walk allows.`);
    delayMs = Math.max(delayMs, rules.crawlDelay * 1000);
  }
  const allowed = address => rules.allows(new URL(address).pathname + new URL(address).search);

  const entries = new Map();
  const listings = [];
  const queue = [start.href];
  const seenListings = new Set();
  let first = null;
  let stopped = 'listing pages ended';
  while (queue.length) {
    if (listings.length >= walk.listingPages) { stopped = `listing page limit of ${walk.listingPages} reached`; break; }
    const address = queue.shift();
    if (seenListings.has(address)) continue;
    seenListings.add(address);
    if (!allowed(address)) { stopped = 'robots.txt does not allow the next listing page'; break; }
    let page;
    try { page = await paced(address); } catch (error) {
      if (!first) throw error;
      stopped = `a listing page could not be read: ${error.message}`;
      break;
    }
    first ??= wayback ? { ...page, body: '' } : page;
    const base = new URL(page.final_url);
    if (!sameSite(base.href, start.href)) { stopped = 'a listing page redirected off the start address\'s site'; break; }
    const sitemap = !wayback && isSitemap(page.body);
    const found = wayback ? { entries: cdxEntries(page.body), sitemaps: [] } : sitemap ? sitemapEntries(page.body, base) : { entries: listingEntries(page.body, base), sitemaps: [] };
    const next = wayback || sitemap ? null : nextListing(page.body, base);
    for (const entry of found.entries) if (!entries.has(entry.url)) entries.set(entry.url, entry);
    for (const child of found.sitemaps) queue.push(child);
    if (next) queue.push(next);
    listings.push({ url: address, final_url: page.final_url, status: page.status, kind: wayback ? 'wayback-cdx' : sitemap ? (found.sitemaps.length ? 'sitemap-index' : 'sitemap') : 'listing', entries: found.entries.length, next: next ?? null });
    const dates = found.entries.map(entry => entry.date).filter(Boolean);
    if (!wayback && !sitemap && walk.window?.from && dates.length && dates.every(date => date < walk.window.from)) { stopped = 'the listing is older than the window'; break; }
  }
  if (!first) throw new Error('robots.txt does not allow the start address, so nothing was read.');
  const reachedOldest = stopped === 'listing pages ended';

  const seen = [...entries.values()];
  const spans = eraSpans(seen.map(entry => entry.date));
  const eraOfEntry = entry => eraOf(entry.date, spans);
  let chosen;
  if (walk.eras) {
    if (!spans) throw new Error('Eras need dated entries, and no entry the listing pages showed has a day.');
    chosen = walk.eras.flatMap(name => evenlyDated(seen.filter(entry => entry.date && eraOfEntry(entry) === name), walk.count));
  } else if (walk.window) {
    chosen = evenlyDated(seen.filter(entry => inWindow(entry.date, walk.window)), walk.count);
  } else {
    chosen = seen.slice(0, walk.count);
  }

  const pages = [];
  for (const entry of chosen) {
    if (!allowed(entry.url)) { pages.push({ url: entry.url, error: 'robots.txt does not allow this page.' }); continue; }
    try {
      const page = await paced(entry.url);
      if (!sameSite(page.final_url, entry.url)) throw new Error('The page redirected off its own site.');
      const facts = extractPage(page.body, new URL(page.final_url), page.media === 'text/plain');
      const own = wayback ? { date: null, source: null } : pageDate(page.body);
      pages.push({
        url: entry.url,
        final_url: page.final_url,
        status: page.status,
        title: facts.title || entry.title,
        description: facts.description,
        date: own.date ?? entry.date,
        date_source: own.date ? own.source : entry.date_source,
        era: eraOfEntry(entry),
        text: facts.text,
        ...(wayback ? { snapshot_of: entry.original } : {}),
      });
    } catch (error) {
      pages.push({ url: entry.url, error: error.message });
    }
  }

  const dated = seen.filter(entry => entry.date);
  return {
    first,
    walk: {
      listing_pages: listings,
      entries_seen: seen.length,
      dated: dated.length,
      span: spans ? { from: spans[0].from, to: spans[spans.length - 1].to } : null,
      reached_oldest: reachedOldest,
      eras: spans ? spans.map(span => ({ ...span, seen: seen.filter(entry => eraOfEntry(entry) === span.name).length, read: pages.filter(page => page.era === span.name).length })) : null,
      pages,
      requests,
      delay_seconds: delayMs / 1000,
      stopped,
    },
  };
}
