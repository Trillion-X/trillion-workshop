// tools/browse-public-page/do-work/page-facts.mjs
//
// PURPOSE
//   What one public page says about itself, from its bytes alone: its title, the words a person reads on it, its links,
//   and the card it describes itself with (its pictures, videos, a line of description, its site's name and icon, from
//   Open Graph and the plain head tags) plus its structured data (schema.org JSON-LD). The one reader of page bytes:
//   the container tool (browse_public_page.mjs) and the Worker's link card (Trillion's src/read-link.mjs) both call it, so a page
//   reads the same wherever it was fetched. Which tags carry which fact is DATA (./page-conventions.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no network, no file system, no Node-only module, so a Worker and a container import the same file.
//   2. Nothing is guessed: a fact the page does not state is null (an empty list for pictures, videos and data); a
//      picture, video or icon is kept only as an absolute http(s) address resolved against the page.
//   3. Bounded: at most MAX_TEXT characters of text, MAX_LINKS links, 500 characters of title and 280 of description;
//      pictures, videos and structured data are capped by page-conventions.json. A block of structured data that is
//      not JSON is skipped, never a failure.

import conventions from './page-conventions.json' with { type: 'json' };

const MAX_TEXT = 30_000;
const MAX_LINKS = 100;
const MAX_DESCRIPTION = 280;

/** The page address a reader may fetch: http(s) on its standard port, with a host and no user name or password. */
export function checkedUrl(input) {
  if (typeof input !== 'string' || !input || input.length > 4096) throw new Error('url must be a web address under 4096 characters.');
  let url;
  try { url = new URL(input); } catch { throw new Error('url must include a valid host name.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only public HTTP and HTTPS pages are supported.');
  if (url.username || url.password) throw new Error('Page addresses cannot include a username or password.');
  if (!url.hostname) throw new Error('url must include a host name.');
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new Error('Only the standard HTTP and HTTPS ports are supported.');
  return url;
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = value => value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity) => {
  if (entity[0] === '#') {
    const value = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : whole;
  }
  return entities[entity.toLowerCase()] ?? whole;
});
const lines = value => value.replace(/[ \t\f\v]+/g, ' ').split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n');
const oneLine = value => decode(String(value ?? '')).replace(/\s+/g, ' ').trim();

// An attribute of one tag, whichever quotes it uses; undefined when the tag has none.
const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'))?.slice(1).find(value => value !== undefined);

// A web address the page names, resolved against it; null unless it is http(s).
function absolute(value, base) {
  if (!value) return null;
  try {
    const url = new URL(decode(value), base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

// Every address in a structured-data value: a web address, an object carrying one as url, or a list of them.
const addressesIn = value => (typeof value === 'string' ? [value]
  : Array.isArray(value) ? value.flatMap(addressesIn)
    : value && typeof value === 'object' && typeof value.url === 'string' ? [value.url] : []);

/** The page's structured data: its JSON-LD objects (a block's @graph as its objects), bounded by the conventions,
 *  and every picture and video address they name under the conventions' keys. */
function structuredData(body) {
  const { max_blocks: maxBlocks, max_characters: maxCharacters, max_depth: maxDepth, picture_keys: pictureKeys, video_keys: videoKeys } = conventions.structured_data;
  const data = [];
  const pictures = [];
  const videos = [];
  let characters = 0;
  const walk = (value, depth) => {
    if (depth > maxDepth || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    for (const [key, inner] of Object.entries(value)) {
      if (pictureKeys.includes(key)) pictures.push(...addressesIn(inner));
      if (videoKeys.includes(key)) videos.push(...addressesIn(inner));
      walk(inner, depth + 1);
    }
  };
  for (const [, attributes, content] of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (data.length >= maxBlocks) break;
    if (!/^application\/ld\+json$/i.test((attribute(attributes, 'type') ?? '').trim())) continue;
    let parsed;
    try { parsed = JSON.parse(content.trim()); } catch { continue; }
    const objects = (Array.isArray(parsed) ? parsed : [parsed]).flatMap(item => (item && Array.isArray(item['@graph']) ? item['@graph'] : [item]));
    for (const object of objects) {
      if (data.length >= maxBlocks || !object || typeof object !== 'object' || Array.isArray(object)) continue;
      const size = JSON.stringify(object).length;
      if (characters + size > maxCharacters) continue;
      characters += size;
      data.push(object);
      walk(object, 0);
    }
  }
  return { data, pictures, videos };
}

// Absolute http(s) addresses, each once, in the order given, at most `limit`.
const addresses = (values, base, limit) => [...new Set(values.map(value => absolute(value, base)).filter(Boolean))].slice(0, limit);

/** The card a page describes itself with, from its meta and link tags and its structured data, as
 *  page-conventions.json names them: its heading, description, site, icon, every picture and every video. */
function selfDescription(body, base) {
  const meta = {};
  for (const [tag] of body.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attribute(tag, 'property') ?? attribute(tag, 'name') ?? '').toLowerCase();
    const content = attribute(tag, 'content');
    if (key && content) (meta[key] ??= []).push(oneLine(content));
  }
  const first = keys => keys.map(key => meta[key]?.find(Boolean)).find(Boolean) ?? null;
  const every = keys => keys.flatMap(key => meta[key] ?? []);
  let icon = null;
  for (const [tag] of body.matchAll(/<link\b[^>]*>/gi)) {
    const rels = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    if (!conventions.icon_rels.some(rel => rels.includes(rel))) continue;
    icon = absolute(attribute(tag, 'href'), base);
    if (icon) break;
  }
  let description = first(conventions.description);
  if (description && description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`;
  const structured = structuredData(body);
  const images = addresses([...every(conventions.pictures), ...structured.pictures], base, conventions.max_pictures);
  return {
    heading: first(conventions.title),
    description,
    image: images[0] ?? null,
    images,
    videos: addresses([...every(conventions.videos), ...structured.videos], base, conventions.max_videos),
    site: first(conventions.site),
    icon,
    data: structured.data,
  };
}

/** What a link that is itself a file adds, by its media type (page-conventions.json direct_files): { images, videos },
 *  each holding the address when its media type names that list, else empty. */
export function fileFacts(address, mediaType) {
  const facts = { images: [], videos: [] };
  const row = conventions.direct_files.find(file => String(mediaType ?? '').toLowerCase().startsWith(file.media_type_starts));
  const url = absolute(address, address);
  if (row && url && Array.isArray(facts[row.adds_to])) facts[row.adds_to].push(url);
  return facts;
}

/** Everything one page's bytes say: { title, text, links, description, image, images, videos, site, icon, data }.
 *  `plain` reads the bytes as plain text, which has no title, links, card or structured data. */
export function extractPage(body, base, plain = false) {
  if (plain) return { title: '', text: lines(body).slice(0, MAX_TEXT), links: [], description: null, image: null, images: [], videos: [], site: null, icon: null, data: [] };
  const own = selfDescription(body, base);
  const plainTitle = oneLine((/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(body)?.[1] ?? '').replace(/<[^>]*>/g, ''));
  const links = [];
  for (const match of body.matchAll(/<[a]\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi)) {
    if (links.length >= MAX_LINKS) break;
    const target = absolute(match[1] ?? match[2] ?? match[3], base);
    if (target) { const url = new URL(target); url.hash = ''; links.push(url.href); }
  }
  const withoutHidden = body.replace(/<(script|style|noscript|svg|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const separated = withoutHidden.replace(/<\/?(?:br|p|div|section|article|li|tr|h[1-4]|blockquote)\b[^>]*>/gi, '\n');
  return {
    title: (own.heading || plainTitle).slice(0, 500),
    text: lines(decode(separated.replace(/<[^>]*>/g, ''))).slice(0, MAX_TEXT),
    links,
    description: own.description,
    image: own.image,
    images: own.images,
    videos: own.videos,
    site: own.site,
    icon: own.icon,
    data: own.data,
  };
}
