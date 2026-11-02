// src/feed-items.mjs
//
// Purpose
//   The items of a feed, read from whatever an address answered: an RSS 2.0 channel, an Atom feed (YouTube's included,
//   whose description sits in media:group/media:description), or JSON (a list, or an object holding `items`, `rows` or
//   `entries`); and the uploads on a YouTube channel's videos page, for the days its feeds answer 404. One reader for every
//   tool that follows an address (src/list-feed.mjs fills a list from one, src/watch-sources.mjs watches the places a
//   person follows), so an address is read the same wherever it is asked about.
//
// Non-Negotiable Invariants
//   1. The answer is read by what it holds, never by the kind of address or the content type it claims: text that is
//      not a feed answers null, so the caller can read it as a page instead.
//   2. No dependency: tags are found by name in the text, entities and CDATA are decoded here, and nothing is run or
//      fetched from what a feed says.
//   3. Bounded, as src/read-link.mjs is: at most READ_BYTES bytes are read, `waitMs` is the whole wait, and at most
//      MOST_ITEMS items are returned.
//   4. Nothing is guessed: a fact an item does not state is null; a date that is not a date is null.
//   5. Only a public address is read (checkedUrl, the page reader's own check), and a conditional read (the ETag and
//      Last-Modified an address gave last time) that answers 304 reads as "nothing new", never as a failure.
//
// Shapes
//   feedItems(text, base?) -> { format: 'rss' | 'atom' | 'json', items: [{ id, title, link, published, summary }] } | null
//   youtubeVideos(text) -> [{ id, title, link, published: null, summary: null }]  newest first, as the page lists them
//   readFeedText(read, address, { accept?, waitMs?, headers?, etag?, modified?, browser? })
//     -> { ok, status, type, text, url, etag, modified, not_modified }
//   decodeEntities(text) -> text with its HTML entities decoded; squash(text) -> its runs of space made one
//
import { checkedUrl } from 'trillion-workshop/tools/browse-public-page/do-work/page-facts.mjs';

const READ_BYTES = 2_000_000;
const WAIT_MS = 6000;
const MOST_ITEMS = 200;
const SUMMARY_CHARS = 1000;
export const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5';
const BROWSER = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'accept-language': 'en' };

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = value => value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity) => {
  if (entity[0] === '#') {
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  }
  return ENTITIES[entity.toLowerCase()] ?? whole;
});
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const squash = value => value.replace(/\s+/g, ' ').trim();

// The words in a piece of XML text: CDATA kept as written, the rest with its entities decoded; when what results holds
// markup (a description that is a page's HTML) the tags are taken out and the entities of the words decoded.
function wordsOf(inner) {
  if (inner === null || inner === undefined) return '';
  const decoded = String(inner).split(/(<!\[CDATA\[[\s\S]*?\]\]>)/g).map(part => {
    const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(part);
    return cdata ? cdata[1] : decodeEntities(part);
  }).join('');
  const markup = /<\/?[a-z][^>]*>|<!--/i.test(decoded);
  const plain = markup ? decodeEntities(decoded.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')) : decoded;
  return squash(plain);
}

// The first element called `name` (a prefix included, like media:description) in a block of XML: its attributes and what
// it holds. A tag whose name only ends the same (media:title for title) is not it.
function element(block, name) {
  const start = new RegExp(`<${escapeRegExp(name)}(?=[\\s>/])([^>]*?)(/?)>`, 'i').exec(block);
  if (!start) return null;
  if (start[2] === '/') return { attrs: start[1], inner: '' };
  const tail = block.slice(start.index + start[0].length);
  const end = new RegExp(`</${escapeRegExp(name)}\\s*>`, 'i').exec(tail);
  return { attrs: start[1], inner: end ? tail.slice(0, end.index) : tail };
}
const attribute = (attrs, name) => {
  const found = new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(` ${attrs}`);
  return found ? decodeEntities(found[1] ?? found[2]) : null;
};
const absolute = (value, base) => {
  if (!value) return null;
  try { const url = new URL(value, base); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
};
const isoOf = value => {
  const time = Date.parse(String(value ?? '').trim());
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};
const clip = value => (value ? value.slice(0, SUMMARY_CHARS) : null);

// An Atom entry's address: the link that is an alternate (or says no kind), else the first link that has an href.
function atomLink(block, base) {
  const links = [...block.matchAll(/<link(?=[\s>/])([^>]*?)\/?>/gi)].map(match => ({ rel: attribute(match[1], 'rel'), href: attribute(match[1], 'href') })).filter(link => link.href);
  const chosen = links.find(link => !link.rel || link.rel === 'alternate') ?? links[0];
  return chosen ? absolute(chosen.href, base) : null;
}

function rssItem(block, base) {
  const guid = wordsOf(element(block, 'guid')?.inner);
  const link = absolute(wordsOf(element(block, 'link')?.inner), base) ?? absolute(guid, base);
  const description = wordsOf(element(block, 'description')?.inner) || wordsOf(element(block, 'content:encoded')?.inner);
  return {
    id: guid || link,
    title: wordsOf(element(block, 'title')?.inner) || null,
    link,
    published: isoOf(wordsOf(element(block, 'pubDate')?.inner) || wordsOf(element(block, 'dc:date')?.inner)),
    summary: clip(description),
  };
}

function atomEntry(block, base) {
  const link = atomLink(block, base);
  const summary = wordsOf(element(block, 'summary')?.inner) || wordsOf(element(block, 'media:description')?.inner) || wordsOf(element(block, 'content')?.inner);
  return {
    id: wordsOf(element(block, 'id')?.inner) || link,
    title: wordsOf(element(block, 'title')?.inner) || null,
    link,
    published: isoOf(wordsOf(element(block, 'published')?.inner) || wordsOf(element(block, 'updated')?.inner)),
    summary: clip(summary),
  };
}

const pick = (object, names) => names.map(name => object[name]).find(value => value !== undefined && value !== null && value !== '');
const textOf = value => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null);

function jsonItem(item, base) {
  const link = absolute(textOf(pick(item, ['url', 'link', 'external_url', 'href'])), base);
  const summary = textOf(pick(item, ['summary', 'description', 'content_text', 'excerpt', 'content_html', 'content']));
  return {
    id: textOf(pick(item, ['id', 'guid', 'key'])) || link,
    title: squash(textOf(pick(item, ['title', 'name', 'headline'])) ?? '') || null,
    link,
    published: isoOf(textOf(pick(item, ['date', 'date_published', 'published', 'published_at', 'pubDate', 'updated', 'date_modified', 'created_at']))),
    summary: clip(summary ? wordsOf(summary) : ''),
  };
}

/** The items of a feed in the text an address answered, or null when the text is not a feed (it is a page, or some other file). */
export function feedItems(text, base) {
  if (typeof text !== 'string') return null;
  const head = text.trimStart();
  if (head[0] === '{' || head[0] === '[') {
    let body;
    try { body = JSON.parse(head); } catch { return null; }
    const list = Array.isArray(body) ? body : [body?.items, body?.rows, body?.entries].find(Array.isArray);
    if (!Array.isArray(list) || list.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return null;
    return { format: 'json', items: list.slice(0, MOST_ITEMS).map(item => jsonItem(item, base)).filter(item => item.id || item.link) };
  }
  const root = /<(rss|rdf:RDF|feed)(?=[\s>])/i.exec(head.slice(0, 4000));
  if (!root) return null;
  const atom = root[1].toLowerCase() === 'feed';
  const items = [];
  for (const match of text.matchAll(/<(item|entry)(?=[\s>/])[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    if (items.length >= MOST_ITEMS) break;
    const item = atom ? atomEntry(match[2], base) : rssItem(match[2], base);
    if (item.id || item.link) items.push(item);
  }
  return { format: atom ? 'atom' : 'rss', items };
}

// The index of the brace closing the object that opens at `open`, reading strings and their escapes; -1 when it never closes.
function closingBrace(text, open) {
  let depth = 0;
  let inString = false;
  for (let at = open; at < text.length; at++) {
    const char = text[at];
    if (inString) {
      if (char === '\\') at++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return at;
  }
  return -1;
}

/**
 * The uploads a YouTube channel's videos page lists (the page's own data, ytInitialData): each `lockupViewModel` object
 * holds one video's id (`contentId`, eleven characters; a playlist's is longer) and its title
 * (`lockupMetadataViewModel.title.content`), found inside that object and not by distance from the other. The page names
 * no publish date, so `published` is null and the caller uses the time it first saw the video.
 */
export function youtubeVideos(text) {
  if (typeof text !== 'string') return [];
  const found = [];
  const seen = new Set();
  for (const start of text.matchAll(/"lockupViewModel"\s*:\s*\{/g)) {
    const open = start.index + start[0].length - 1;
    const end = closingBrace(text, open);
    if (end < 0) continue;
    const object = text.slice(open, end + 1);
    const id = /"contentId"\s*:\s*"([A-Za-z0-9_-]{11})"/.exec(object)?.[1];
    const raw = /"lockupMetadataViewModel"\s*:\s*\{\s*"title"\s*:\s*\{\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(object)?.[1];
    if (!id || raw === undefined || seen.has(id)) continue;
    let title;
    try { title = JSON.parse(`"${raw}"`); } catch { title = raw; }
    seen.add(id);
    found.push({ id, title: squash(title) || null, link: `https://www.youtube.com/watch?v=${id}`, published: null, summary: null });
    if (found.length >= MOST_ITEMS) break;
  }
  return found;
}

/**
 * One address read, bounded. read(url, init) is fetch. The text stops at READ_BYTES bytes; an address that does not
 * answer in waitMs milliseconds, or that is not a public web address, answers { ok: false, status: 0 }. etag/modified
 * (what the address gave last time) are sent as If-None-Match / If-Modified-Since; a 304 answers
 * { ok: true, status: 304, not_modified: true } with no text. browser: asks as a desktop browser would, in English.
 */
export async function readFeedText(read, address, { accept = FEED_ACCEPT, waitMs = WAIT_MS, etag = null, modified = null, browser = false } = {}) {
  let url;
  try { url = checkedUrl(address.href ?? String(address)); } catch { return { ok: false, status: 0, type: '', text: '', url: String(address), etag: null, modified: null, not_modified: false }; }
  const failed = status => ({ ok: false, status, type: '', text: '', url: url.href, etag: null, modified: null, not_modified: false });
  let response;
  try {
    response = await read(url.href, {
      redirect: 'follow', signal: AbortSignal.timeout(waitMs),
      headers: { accept, 'user-agent': 'facebookexternalhit/1.1 (+https://gettrillion.ai) Trillion', ...(browser ? BROWSER : {}),
        ...(etag ? { 'if-none-match': etag } : {}), ...(modified ? { 'if-modified-since': modified } : {}) },
    });
  } catch {
    return failed(0);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const type = contentType.split(';')[0].trim().toLowerCase();
  const kept = { type, url: response.url || url.href, etag: response.headers.get('etag'), modified: response.headers.get('last-modified') };
  if (response.status === 304) { response.body?.cancel().catch(() => {}); return { ok: true, status: 304, text: '', not_modified: true, ...kept, etag: kept.etag ?? etag, modified: kept.modified ?? modified }; }
  if (!response.ok || !response.body) return failed(response.status);
  const charset = /charset\s*=\s*["']?([a-z0-9._-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  let decoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder(); }
  const reader = response.body.getReader();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < READ_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    if (!text) return failed(response.status);
  } finally {
    reader.cancel().catch(() => {});
  }
  return { ok: true, status: response.status, text, not_modified: false, ...kept };
}
