// tools/publish-content-for-discovery/do-work/site-search-head.mjs
//
// The search and answer-engine head of a built page, and the robots.txt and llms.txt of a site, from per-page DATA. A site keeps one
// row per page (title, description, canonical address, Open Graph and Twitter card words, robots directive, JSON-LD objects, the
// site's feeds a reader or feed reader can subscribe to); the
// build calls withSearchHead(html, meta) on the page it built. The page's own visible words are never changed: this owns only the
// head tags that describe the page.
//
// Exports:
//   searchHeadMarkup(meta)        -> the head tags for one page (throws, listing every problem, when the meta is not valid)
//   withSearchHead(html, meta)    -> the page's HTML with its old title, description, robots, canonical, Open Graph, Twitter,
//                                    feed and JSON-LD tags replaced by the ones searchHeadMarkup writes
//   robotsTxt({ sitemap, groups }) -> a robots.txt body; groups are { agents, allow, disallow } lists of paths
//   llmsTxt({ name, summary, sections }) -> an llms.txt body per llmstxt.org (H1 name, blockquote summary, H2 sections of links)
//
// Invariants:
//   - Every address is https and absolute. Attribute values are escaped; JSON-LD is written with < > & escaped, so no value can end its
//     script tag.
//   - The JSON-LD objects are DATA. Each needs @context (https://schema.org) and @type; nothing here invents a type or a property.
//   - Nothing is emitted for a field the meta leaves out. The caller decides what is a fact.

const OG_TYPES = ['website', 'article', 'profile', 'book'];
const TWITTER_CARDS = ['summary', 'summary_large_image'];
const ROBOTS_WORDS = /^(?:index|noindex|follow|nofollow|noarchive|nosnippet|max-snippet:-?\d+|max-image-preview:(?:none|standard|large))(?:,\s*(?:index|noindex|follow|nofollow|noarchive|nosnippet|max-snippet:-?\d+|max-image-preview:(?:none|standard|large)))*$/;

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isHttps = (value) => {
  if (!isText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
};
const attribute = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// JSON that can sit inside a script element: no character can close the element or open a comment.
const inScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

/** Every problem with a page's search meta, as sentences. An empty list means the meta may be written. */
export function searchMetaProblems(meta) {
  if (!isObject(meta)) return ['The search meta is not an object.'];
  const problems = [];
  if (!isText(meta.title)) problems.push('`title` needs words.');
  if (!isText(meta.description)) problems.push('`description` needs words.');
  if (!isHttps(meta.canonical)) problems.push('`canonical` needs an absolute https address.');
  if (meta.robots !== undefined && (!isText(meta.robots) || !ROBOTS_WORDS.test(meta.robots))) problems.push('`robots` must be a robots directive such as "noindex" or "index, follow".');
  if (meta.og !== undefined) {
    if (!isObject(meta.og)) problems.push('`og` must be an object.');
    else {
      if (!OG_TYPES.includes(meta.og.type)) problems.push(`og.type must be one of ${OG_TYPES.join(', ')}.`);
      if (!isText(meta.og.title)) problems.push('og.title needs words.');
      if (!isText(meta.og.description)) problems.push('og.description needs words.');
      if (meta.og.image !== undefined && !isHttps(meta.og.image)) problems.push('og.image needs an absolute https address.');
      if (meta.og.locale !== undefined && !/^[a-z]{2}_[A-Z]{2}$/.test(meta.og.locale)) problems.push('og.locale must look like en_US.');
      if (meta.og.site_name !== undefined && !isText(meta.og.site_name)) problems.push('og.site_name needs words.');
    }
  }
  if (meta.twitter !== undefined) {
    if (!isObject(meta.twitter)) problems.push('`twitter` must be an object.');
    else if (!TWITTER_CARDS.includes(meta.twitter.card)) problems.push(`twitter.card must be one of ${TWITTER_CARDS.join(', ')}.`);
  }
  if (meta.feeds !== undefined) {
    if (!Array.isArray(meta.feeds)) problems.push('`feeds` must be a list of { href, title }.');
    else {
      meta.feeds.forEach((feed, i) => {
        if (!isObject(feed) || !isHttps(feed.href)) problems.push(`feeds[${i}].href needs an absolute https address.`);
        else if (!isText(feed.title)) problems.push(`feeds[${i}].title needs words.`);
      });
    }
  }
  if (meta.jsonld !== undefined) {
    if (!Array.isArray(meta.jsonld)) problems.push('`jsonld` must be a list of objects.');
    else {
      meta.jsonld.forEach((item, i) => {
        if (!isObject(item)) problems.push(`jsonld[${i}] is not an object.`);
        else {
          if (item['@context'] !== 'https://schema.org') problems.push(`jsonld[${i}] needs @context "https://schema.org".`);
          if (!isText(item['@type']) && !Array.isArray(item['@type'])) problems.push(`jsonld[${i}] needs an @type.`);
        }
      });
    }
  }
  return problems;
}

/** The head tags for one page. Throws, listing every problem, when the meta is not valid. */
export function searchHeadMarkup(meta) {
  const problems = searchMetaProblems(meta);
  if (problems.length > 0) throw new Error(`The search meta is refused: ${problems.join(' ')}`);
  const tags = [
    `<title>${attribute(meta.title)}</title>`,
    `<meta name="description" content="${attribute(meta.description)}"/>`,
    `<link rel="canonical" href="${attribute(meta.canonical)}"/>`,
  ];
  if (meta.robots !== undefined) tags.push(`<meta name="robots" content="${attribute(meta.robots)}"/>`);
  if (meta.og !== undefined) {
    const og = meta.og;
    tags.push(`<meta property="og:type" content="${attribute(og.type)}"/>`);
    tags.push(`<meta property="og:title" content="${attribute(og.title)}"/>`);
    tags.push(`<meta property="og:description" content="${attribute(og.description)}"/>`);
    tags.push(`<meta property="og:url" content="${attribute(meta.canonical)}"/>`);
    if (og.site_name !== undefined) tags.push(`<meta property="og:site_name" content="${attribute(og.site_name)}"/>`);
    if (og.locale !== undefined) tags.push(`<meta property="og:locale" content="${attribute(og.locale)}"/>`);
    if (og.image !== undefined) tags.push(`<meta property="og:image" content="${attribute(og.image)}"/>`);
  }
  if (meta.twitter !== undefined) {
    tags.push(`<meta name="twitter:card" content="${attribute(meta.twitter.card)}"/>`);
    tags.push(`<meta name="twitter:title" content="${attribute(meta.og?.title ?? meta.title)}"/>`);
    tags.push(`<meta name="twitter:description" content="${attribute(meta.og?.description ?? meta.description)}"/>`);
    if (meta.og?.image !== undefined) tags.push(`<meta name="twitter:image" content="${attribute(meta.og.image)}"/>`);
  }
  // A feed is advertised as an RSS alternate of the page, so a feed reader given any page of the site finds it.
  for (const feed of meta.feeds ?? []) {
    tags.push(`<link rel="alternate" type="application/rss+xml" title="${attribute(feed.title)}" href="${attribute(feed.href)}"/>`);
  }
  for (const item of meta.jsonld ?? []) {
    tags.push(`<script type="application/ld+json">${inScript(item)}</script>`);
  }
  return tags.join('');
}

// The tags searchHeadMarkup writes; any page-level copy of them is removed before the new set goes in.
const REPLACED = [
  /<title>[\s\S]*?<\/title>/g,
  /<meta\s+name="(?:description|robots|twitter:[a-z_]+)"[^>]*\/?>/g,
  /<meta\s+property="og:[a-z_]+"[^>]*\/?>/g,
  /<link\s+rel="canonical"[^>]*\/?>/g,
  /<link\s+rel="alternate"\s+type="application\/rss\+xml"[^>]*\/?>/g,
  /<script\s+type="application\/ld\+json">[\s\S]*?<\/script>/g,
];

/** The page's HTML with its search head replaced by the one searchHeadMarkup writes. Throws when the page has no head. */
export function withSearchHead(html, meta) {
  const start = html.indexOf('<head>');
  const end = html.indexOf('</head>');
  if (start < 0 || end < start) throw new Error('A built page has no <head> to carry the search head.');
  const markup = searchHeadMarkup(meta);
  const head = REPLACED.reduce((text, pattern) => text.replace(pattern, ''), html.slice(start, end));
  return html.slice(0, start) + head.replace('<head>', `<head>${markup}`) + html.slice(end);
}

const SITEMAP_LT = String.fromCharCode(60);
const SITEMAP_GT = String.fromCharCode(62);
const sitemapText = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const sitemapTag = (name, value) => `${SITEMAP_LT}${name}${SITEMAP_GT}${sitemapText(value)}${SITEMAP_LT}/${name}${SITEMAP_GT}`;

/** A sitemap.xml body from { urls: [{ loc, lastmod? }] }: every loc an https address, every lastmod a valid date (the page model
 *  prepareContentForDiscovery returns, or a site's own list). serve-content-for-discovery.mjs re-exports it. */
export function serializeSitemapXml(sitemapPage) {
  if (!sitemapPage || !Array.isArray(sitemapPage.urls)) throw new TypeError('A sitemap page model is required.');
  const urls = sitemapPage.urls.map(url => {
    if (!isHttps(url.loc)) throw new TypeError('Every sitemap location must be an HTTPS URL.');
    if (url.lastmod && !Number.isFinite(Date.parse(url.lastmod))) throw new TypeError('Sitemap dates must be valid.');
    return `${SITEMAP_LT}url${SITEMAP_GT}${sitemapTag('loc', url.loc)}${url.lastmod ? sitemapTag('lastmod', url.lastmod) : ''}${SITEMAP_LT}/url${SITEMAP_GT}`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>${SITEMAP_LT}urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${SITEMAP_GT}${urls}${SITEMAP_LT}/urlset${SITEMAP_GT}`;
}

/** A robots.txt body. Each group names its agents and the paths it allows or disallows; the sitemap is one absolute https address. */
export function robotsTxt({ sitemap, groups }) {
  if (!isHttps(sitemap)) throw new TypeError('robots.txt needs its sitemap as an absolute https address.');
  if (!Array.isArray(groups) || groups.length === 0) throw new TypeError('robots.txt needs at least one group.');
  const lines = [];
  for (const group of groups) {
    if (!Array.isArray(group.agents) || group.agents.length === 0 || !group.agents.every(isText)) throw new TypeError('Each robots.txt group needs agent names.');
    for (const agent of group.agents) lines.push(`User-agent: ${agent}`);
    for (const path of group.allow ?? []) lines.push(`Allow: ${path}`);
    for (const path of group.disallow ?? []) lines.push(`Disallow: ${path}`);
    lines.push('');
  }
  lines.push(`Sitemap: ${sitemap}`, '');
  return lines.join('\n');
}

/** An llms.txt body per llmstxt.org. sections: { title, links: [{ title, url, note? }] }; the summary is one plain sentence. */
export function llmsTxt({ name, summary, sections }) {
  if (!isText(name)) throw new TypeError('llms.txt needs a site name.');
  if (!isText(summary)) throw new TypeError('llms.txt needs a one-line summary.');
  if (!Array.isArray(sections)) throw new TypeError('llms.txt needs its sections as a list.');
  const lines = [`# ${name}`, '', `> ${summary}`, ''];
  for (const section of sections) {
    if (!isText(section.title) || !Array.isArray(section.links)) throw new TypeError('Each llms.txt section needs a title and its links.');
    lines.push(`## ${section.title}`, '');
    for (const link of section.links) {
      if (!isText(link.title) || !isHttps(link.url)) throw new TypeError('Each llms.txt link needs a title and an absolute https address.');
      lines.push(`- [${link.title}](${link.url})${link.note ? `: ${link.note}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
