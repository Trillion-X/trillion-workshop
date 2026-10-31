// tools/browse-public-page/do-work/archive-facts.mjs
//
// PURPOSE
//   What an archive listing page says about the pages it lists, from its bytes alone: the entries (address, words, the
//   day it was published), the link to the next, older listing page, the entries of a sitemap, the day a page says it was
//   published, what a robots.txt allows, and how a set of dated entries divides into eras. The pure half of the archive
//   walk (./walk-archive.mjs fetches and sequences); like ./page-facts.mjs it has no network, no file system and no
//   Node-only module. Which rels, words, tags and keys mean what is DATA (./page-conventions.json, "archive").
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure and bounded: no I/O; every list returned is deduplicated and the caller bounds how many it reads.
//   2. Nothing is guessed: a day the page does not state is null; an era needs dated entries; an entry address is kept
//      only as an absolute http(s) address on the listing's own site.
//   3. Dates are calendar days as YYYY-MM-DD in UTC, never local time.

import conventions from './page-conventions.json' with { type: 'json' };

const archive = conventions.archive;
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = value => String(value ?? '').replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity) => {
  if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? whole;
  const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
});
const words = value => decode(String(value ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'))?.slice(1).find(value => value !== undefined);

// A link element with its words, and a grouping element (an article or a list item) with what it holds.
const LINKS = /(<[a]\b[^>]*>)([\s\S]*?)<\/[a]\s*>/gi;
const GROUPS = /<(article|li)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

/** Whether year, month (1-12) and day (1-31) name a real calendar day. */
function realDay(year, month, date) {
  const moment = new Date(Date.UTC(year, month - 1, date));
  return moment.getUTCFullYear() === year && moment.getUTCMonth() === month - 1 && moment.getUTCDate() === date;
}
const day = (year, month, date = 1) => (realDay(year, month, date) ? `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}` : null);

/** The day a web address's path states (/2024/05/12/slug, /2024-05-12-slug, /2024/05/slug as the first of the month, /may-12-2024), else null. */
export function dateOfUrl(address) {
  let path;
  try { path = new URL(address).pathname; } catch { return null; }
  const match = /(?:^|\/)((?:19|20)\d{2})[/-](0[1-9]|1[0-2])(?:[/-](0[1-9]|[12]\d|3[01]))?(?=$|[/-])/.exec(path);
  if (match) return day(Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : 1);
  return dateInText(path.replace(/[-_/]+/g, ' '));
}

// The number (1-12) of the month a written name or abbreviation starts as, 0 when it is none.
const monthOf = name => {
  const lower = name.toLowerCase().replace(/\.$/, '');
  return lower.length < 3 ? 0 : archive.month_names.findIndex(month => month.startsWith(lower)) + 1;
};

/** The day a piece of text states: an ISO day (2024-05-12, optionally followed by a time) or a written one (May 12, 2024; 12 May 2024; 12th May 2024), else null. */
export function dateInText(text) {
  const value = String(text ?? '');
  const iso = /\b((?:19|20)\d{2})-(\d{2})-(\d{2})(?=$|[^\d])/.exec(value);
  if (iso) return day(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const name = '[A-Za-z]{3,9}\\.?';
  const monthFirst = new RegExp(`\\b(${name})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:19|20)\\d{2})\\b`).exec(value);
  if (monthFirst && monthOf(monthFirst[1])) return day(Number(monthFirst[3]), monthOf(monthFirst[1]), Number(monthFirst[2]));
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${name}),?\\s+((?:19|20)\\d{2})\\b`).exec(value);
  if (dayFirst && monthOf(dayFirst[2])) return day(Number(dayFirst[3]), monthOf(dayFirst[2]), Number(dayFirst[1]));
  return null;
}

/** The day a page says it was published: { date, source } from its meta tags, its structured data (date_meta, date_keys) or its time element; { date: null, source: null } when it says none. */
export function pageDate(body) {
  for (const [tag] of body.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attribute(tag, 'property') ?? attribute(tag, 'name') ?? attribute(tag, 'itemprop') ?? '').toLowerCase();
    if (!archive.date_meta.includes(key)) continue;
    const date = dateInText(attribute(tag, 'content'));
    if (date) return { date, source: 'meta' };
  }
  for (const [, attributes, content] of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/^application\/ld\+json$/i.test((attribute(attributes, 'type') ?? '').trim())) continue;
    for (const key of archive.date_keys) {
      const found = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(content);
      const date = found ? dateInText(found[1]) : null;
      if (date) return { date, source: 'structured-data' };
    }
  }
  for (const [tag] of body.matchAll(/<time\b[^>]*>/gi)) {
    const date = dateInText(attribute(tag, 'datetime'));
    if (date) return { date, source: 'time' };
  }
  return { date: null, source: null };
}

const bare = host => host.replace(/^www\./, '');
/** Whether two addresses are on the same site (host names equal, a leading www ignored). */
export const sameSite = (a, b) => bare(new URL(a).hostname) === bare(new URL(b).hostname);

// An address a listing names, resolved against it, without a fragment; null unless http(s).
function resolved(value, base) {
  try {
    const url = new URL(decode(value), base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

const normal = text => words(text).toLowerCase().replace(/&#?\w+;/g, ' ').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The listing's link to its next (older) listing page, from link and anchor rel values and link words (pagination_rels, pagination_words), else null. */
export function nextListing(body, base) {
  for (const [tag] of body.matchAll(/<(?:link|[a])\b[^>]*>/gi)) {
    const rels = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    const target = resolved(attribute(tag, 'href'), base);
    if (target && archive.pagination_rels.some(rel => rels.includes(rel))) return target;
  }
  for (const [, tag, text] of body.matchAll(LINKS)) {
    const target = resolved(attribute(tag, 'href'), base);
    const label = normal(text) || normal(attribute(tag, 'aria-label'));
    if (target && archive.pagination_words.includes(label)) return target;
  }
  return null;
}

/** The entries an HTML listing page lists: [{ url, title, date, date_source }], each address once, on the listing's own
 *  site, not the listing itself, not the pagination link and not a file. An entry is the first link of an article or a
 *  list item, or any link whose path states a day. The day comes from the entry's own time element, its address, or its words. */
export function listingEntries(body, base) {
  const next = nextListing(body, base);
  const here = new URL(base).href.replace(/#.*$/, '');
  const entries = new Map();
  const consider = (anchorTag, inner, block) => {
    const url = resolved(attribute(anchorTag, 'href'), base);
    if (!url || entries.has(url) || url === here || url === next || !sameSite(url, base)) return;
    const path = new URL(url).pathname;
    if (path === '/' || archive.skipped_extensions.some(extension => path.toLowerCase().endsWith(extension))) return;
    const title = words(inner);
    if (!title) return;
    const time = /<time\b[^>]*>/i.exec(block);
    const fromTime = time ? dateInText(attribute(time[0], 'datetime')) : null;
    const fromUrl = dateOfUrl(url);
    const fromText = dateInText(words(block));
    const date = fromTime ?? fromUrl ?? fromText;
    entries.set(url, { url, title: title.slice(0, 300), date, date_source: date === null ? null : fromTime ? 'time' : fromUrl ? 'url' : 'text' });
  };
  for (const [, , block] of body.matchAll(GROUPS)) {
    const first = new RegExp(LINKS.source, 'i').exec(block);
    if (first) consider(first[1], first[2], block);
  }
  for (const [, tag, inner] of body.matchAll(LINKS)) {
    const url = resolved(attribute(tag, 'href'), base);
    if (url && dateOfUrl(url)) consider(tag, inner, tag + inner);
  }
  return [...entries.values()];
}

/** Whether a body is a sitemap (a urlset or a sitemapindex). */
export const isSitemap = body => /<(?:urlset|sitemapindex)\b/i.test(body);

/** What a sitemap lists: { entries: [{ url, title: '', date, date_source }], sitemaps: [address] }, on the sitemap's own site. A day is the address's own, else the sitemap's lastmod. */
export function sitemapEntries(body, base) {
  const entries = [];
  const sitemaps = [];
  const seen = new Set();
  for (const [, kind, inner] of body.matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const loc = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/i.exec(inner)?.[1];
    const url = resolved(words(loc ?? ''), base);
    if (!url || seen.has(url) || !sameSite(url, base)) continue;
    seen.add(url);
    if (kind.toLowerCase() === 'sitemap') { sitemaps.push(url); continue; }
    const fromUrl = dateOfUrl(url);
    const lastmod = dateInText(words(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod\s*>/i.exec(inner)?.[1] ?? ''));
    const date = fromUrl ?? lastmod;
    entries.push({ url, title: '', date, date_source: date === null ? null : fromUrl ? 'url' : 'lastmod' });
  }
  return { entries, sitemaps };
}

/** What a robots.txt lets the agent read: { allows(path), crawlDelay } from the group naming the agent, else the * group. Longest matching rule wins, allow on a tie, no rules allows everything. */
export function robotsRules(text, agent) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const split = line.indexOf(':');
    if (split < 0) continue;
    const field = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], rules: [], delay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') { if (value) current.rules.push({ allow: field === 'allow', path: value }); }
    else if (field === 'crawl-delay' && Number.isFinite(Number(value))) current.delay = Number(value);
  }
  const named = groups.filter(group => group.agents.some(name => name !== '*' && agent.toLowerCase().includes(name)));
  const chosen = named.length ? named : groups.filter(group => group.agents.includes('*'));
  const rules = chosen.flatMap(group => group.rules);
  const pattern = rule => new RegExp(`^${rule.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
  return {
    crawlDelay: chosen.map(group => group.delay).find(delay => delay !== null) ?? null,
    allows(path) {
      let best = null;
      for (const rule of rules) {
        if (!pattern(rule).test(path)) continue;
        if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
      }
      return best ? best.allow : true;
    },
  };
}

const wayback = archive.wayback;
const compact = date => date.replace(/-/g, '');

/** The Wayback CDX request for the snapshots of one page: { window?: { from, to }, collapse: 'year' | 'month' | 'day' } => an address on the public index, newest and oldest alike, one per period, in the window's days when it has them. */
export function waybackQuery(target, { window, collapse = wayback.default_collapse } = {}) {
  const query = new URLSearchParams({ url: target, fl: 'timestamp,original' });
  query.append('filter', `statuscode:${wayback.status}`);
  query.append('filter', `mimetype:${wayback.mimetype}`);
  query.set('collapse', `timestamp:${wayback.collapse[collapse]}`);
  query.set('limit', String(wayback.max_rows));
  if (window?.from) query.set('from', compact(window.from));
  if (window?.to) query.set('to', compact(window.to));
  return `https://${wayback.host}${wayback.cdx_path}?${query}`;
}

/** What a CDX answer lists, one snapshot a line (timestamp, original address): [{ url, original, title: '', date, date_source: 'snapshot' }], each read raw from its own snapshot address; a line that is not a real timestamp and an http(s) address is skipped. */
export function cdxEntries(body) {
  const entries = [];
  const seen = new Set();
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const match = /^(\d{14})\s+(https?:\/\/\S+)$/.exec(line.trim());
    if (!match || seen.has(match[1])) continue;
    const date = day(Number(match[1].slice(0, 4)), Number(match[1].slice(4, 6)), Number(match[1].slice(6, 8)));
    if (!date) continue;
    seen.add(match[1]);
    entries.push({ url: `https://${wayback.host}${wayback.snapshot_path}/${match[1]}${wayback.raw_flag}/${match[2]}`, original: match[2], title: '', date, date_source: 'snapshot' });
  }
  return entries;
}

const moment = date => Date.parse(`${date}T00:00:00Z`);

/** The eras of a set of dated entries: archive.eras (early, middle, recent) as equal thirds of the time between the oldest and the newest day, { name, from, to } each; null when there is no dated entry. */
export function eraSpans(dates) {
  const times = dates.filter(Boolean).map(moment);
  if (!times.length) return null;
  const first = Math.min(...times);
  const last = Math.max(...times);
  const third = (last - first) / archive.eras.length;
  const iso = time => new Date(Math.round(time)).toISOString().slice(0, 10);
  return archive.eras.map((name, index) => ({ name, from: iso(first + third * index), to: iso(index === archive.eras.length - 1 ? last : first + third * (index + 1)) }));
}

/** The era a day falls in, given eraSpans(...): the last span whose from is on or before the day; null for an undated entry. */
export function eraOf(date, spans) {
  if (!date || !spans) return null;
  const time = moment(date);
  const index = spans.findLastIndex(span => time >= moment(span.from));
  return index < 0 ? spans[0].name : spans[index].name;
}

/** `count` of the dated entries, evenly spaced from oldest to newest (so a long group is sampled across its time, not at one end); all of them when there are no more than `count`. */
export function evenlyDated(entries, count) {
  const sorted = [...entries].sort((a, b) => moment(a.date) - moment(b.date));
  if (count >= sorted.length) return sorted;
  if (count === 1) return [sorted[Math.floor((sorted.length - 1) / 2)]];
  return [...new Set(Array.from({ length: count }, (_, index) => Math.round(index * (sorted.length - 1) / (count - 1))))].map(index => sorted[index]);
}

/** Whether a calendar day falls in { from, to } (each optional, inclusive, YYYY-MM-DD); an undated entry never does. */
export function inWindow(date, window) {
  if (!date) return false;
  return (!window?.from || date >= window.from) && (!window?.to || date <= window.to);
}
