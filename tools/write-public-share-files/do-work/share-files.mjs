// tools/write-public-share-files/do-work/share-files.mjs
//
// PURPOSE
//   The public files of every live public share, as data: what a public server serves read-only from one folder for
//   /share/. Moved from Trillion's src/record-share-pages.mjs (the listed documents, the data read and the list and
//   row pages), src/record-sharing.mjs (a link's admission, listRows, latestDay, one row of a list) and
//   src/list-public-comparison.mjs (comparisonRows). Pure: the shell (write-share-files.mjs) reads the records and
//   writes the folder; this reads and writes nothing.
//
//   <code>.json (and <name>.json)   the share as data: { kind: "list", title, about, changed, fields,
//                                   rows: [{ id, title, address, url, values }], files: [{ identity, name, url, media_type }] },
//                                   whole, never paged
//   <name>/index.html               the list's page; <name>/<row address>/index.html one page per row
//   files/<identity>                each file a shown row names, by its identity, and no other
//   sitemap.xml, llms.txt           every listed live public share and its rows (parts under sitemap/ and llms/ when large)
//
// NON-NEGOTIABLE INVARIANTS
//   1. A link has public files only while it is published, not revoked, not expired and open to anyone (scope public).
//      A link for named people, an email, an audience or an access code has none. Ended links are named so the shell
//      removes their files.
//   2. What leaves is the List rule of share-files.json share_from_private less the sharing row's leave_out, with a
//      match-only field refused rather than shown (read-data/shareable-copy.mjs), and only the rows whose own rules hold
//      and the files they name (read-data/list-copy.mjs).
//   3. What a file on a public server cannot check at each open is never published: a link's own condition (`when`), a
//      row rule that counts opens or reads the clock. Such a link is left out with its reason, never shown unchecked.
//   4. Only a listed link drops noindex and is named in sitemap.xml and llms.txt; comparison evidence rows are never
//      named there.
//   5. Nothing here names a list, field or person; record-sharing DATA (share-files.json) does.
import data from '../read-data/share-files.json' with { type: 'json' };
import { listCopy } from '../read-data/list-copy.mjs';
import { shareableCopy } from '../read-data/shareable-copy.mjs';

const A = data.addresses;
const W = data.words;
const ADDRESS = new RegExp(A.pattern);
const LOOKS_LIKE_CODE = /^[0-9a-f]{20,}$/;
// The folder's own names: a link's readable address never takes one, so it keeps its code instead.
const RESERVED = new Set(['files', 'sitemap', 'llms', 'manifest']);

/** A name made of a text's first words (Trillion's src/readable-names.mjs nameFromWords), or null. */
export function nameFromWords(words, { first, longest, pattern }) {
  const slug = String(words ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, first).join('-')
    .slice(0, longest).replace(/-+$/, '');
  return pattern.test(slug) && !LOOKS_LIKE_CODE.test(slug) ? slug : null;
}
export const addressFromWords = words => nameFromWords(words, { first: A.first_words, longest: A.longest, pattern: ADDRESS });

/** Whether a link is open right now: published, not revoked, and not past a valid expiry (an invalid one has ended). */
export function linkOpen(grant, now) {
  if (!grant || grant.published === false || grant.revoked_at) return false;
  if (!grant.expires_at) return true;
  const until = Date.parse(grant.expires_at);
  return Number.isFinite(until) && until > now;
}

/** The part of a record a reference names: `list:<id>:rows:<row id>` is one row of a list, else null. */
export function partOf(ref) {
  const match = /^([a-z-]+:[^:]+):([a-z-]+):(.+)$/.exec(ref ?? '');
  if (!match || match[2] !== data.row_part.segment || !match[1].startsWith(`${data.list_kind}:`)) return null;
  return { whole: match[1], segment: match[2], id: match[3] };
}

// A shared thing that holds rows gets one page per row: each row's address is its title's first words, numbered when
// two rows read alike, and never one of a link's own parts.
const LINK_PARTS = new Set(['items', 'file', 'files', 'preview', 'poster', 'transcript', 'look', 'prove', 'sign', 'pay', 'index.html']);
export function listRows(copy) {
  const rows = copy?.body?.rows;
  if (!Array.isArray(rows) || !Array.isArray(copy.body.fields)) return null;
  const dates = copy.body.fields.filter(field => A.date_kinds.includes(field.kind)).map(field => field.id);
  const taken = new Set();
  return rows.map(row => {
    const base = addressFromWords(row.title) ?? 'row';
    let address = LINK_PARTS.has(base) ? `${base}-row` : base;
    for (let n = 2; taken.has(address); n++) address = `${base}-${n}`;
    taken.add(address);
    const changed = dates.map(id => row.values?.[id]).filter(day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day)).map(day => day.slice(0, 10)).sort().at(-1) ?? null;
    return { id: row.id, address, title: row.title ?? null, values: row.values ?? {}, changed };
  });
}
/** The newest day any row of a shared list names in a date field, or null. */
export const latestDay = copy => (listRows(copy) ?? []).map(row => row.changed).filter(Boolean).sort().at(-1) ?? null;

// A comparison page lists only its comparison rows; its evidence rows stay off listings.
const words = value => typeof value === 'string' ? value.trim() : '';
export function comparisonRows(page, rows) {
  const source = page?.evidence_rows;
  return source ? rows.filter(row => words(row.values?.[source.kind_field]) === source.comparison_kind) : rows;
}

const valueWords = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' || typeof item === 'number').join(', ')
  : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const excerpt = (text, most = 220) => (text.length > most ? `${text.slice(0, most).replace(/\s+\S*$/, '')}…` : text);
const isAddress = (copy, id) => A.address_kinds.includes((copy.body?.fields ?? []).find(field => field.id === id)?.kind);
const rowSummary = (copy, row) => {
  const fields = (copy.body.fields ?? []).filter(field => !isAddress(copy, field.id) && !field.media);
  const ordered = [...fields.filter(field => A.summary_kinds.includes(field.kind)), ...fields.filter(field => !A.summary_kinds.includes(field.kind))];
  return excerpt(ordered.map(field => valueWords(row.values[field.id])).find(text => text && text !== row.title) ?? '');
};
const shownRows = copy => {
  const rows = listRows(copy) ?? [];
  return copy.body?.public_page?.layout === 'comparison' ? comparisonRows(copy.body.public_page, rows) : rows;
};
const sharePath = (name, rest = '') => `/share/${encodeURIComponent(name)}${rest}`;
const filePath = identity => `/share/files/${identity}`;

/** What a share shows as data (the shape trillion-site/worker/shared-list.js reads): whole, never paged. */
export function shareData({ origin, name, copy }) {
  return {
    kind: 'list', title: copy.title ?? null, about: copy.body?.about ?? null, changed: latestDay(copy),
    fields: copy.body.fields,
    rows: (listRows(copy) ?? []).map(row => ({ id: row.id, title: row.title, address: row.address, url: `${origin}${sharePath(name, `/${row.address}`)}`, values: row.values })),
    files: (copy.body.files ?? []).map(file => ({ identity: file.identity, name: file.name ?? null, url: `${origin}${filePath(file.identity)}`, media_type: file.media_type ?? null })),
  };
}

// The pages: plain HTML with every text escaped, a canonical address, structured data, and noindex unless listed.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const jsonLd = value => JSON.stringify(value).replace(/</g, '\\u003c');
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
function page({ origin, path, title, description, listed, structured, body }) {
  return ['<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`, `<meta name="description" content="${esc(description)}">`,
    listed ? `<link rel="canonical" href="${esc(origin + path)}">` : '<meta name="robots" content="noindex">',
    ...structured.map(item => `<script type="application/ld+json">${jsonLd(item)}</script>`),
    '</head>', '<body>', '<main>', ...body, '</main>', '</body>', '</html>', ''].join('\n');
}

export function sharePages({ origin, name, copy, listed }) {
  const rows = listRows(copy) ?? [];
  const visible = shownRows(copy);
  const listPath = sharePath(name);
  const changed = latestDay(copy);
  const title = copy.title ?? name;
  const description = excerpt(copy.body?.about || `${title}: ${visible.map(row => row.title).filter(Boolean).slice(0, 6).join(', ')}.`, 300);
  const pages = [{ path: `${name}/index.html`, text: page({ origin, path: listPath, title, description, listed, structured: [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description, url: `${origin}${listPath}`, ...(changed ? { dateModified: changed } : {}),
      mainEntity: { '@type': 'ItemList', numberOfItems: visible.length, itemListElement: visible.map((row, index) => ({ '@type': 'ListItem', position: index + 1, name: row.title ?? row.address, url: `${origin}${sharePath(name, `/${row.address}`)}` })) } }],
  body: [`<h1>${esc(title)}</h1>`, ...(copy.body?.about ? [`<p>${esc(copy.body.about)}</p>`] : []), `<h2>${esc(A.rows_heading)}</h2>`, '<ul>',
    ...visible.map(row => { const summary = rowSummary(copy, row);
      return `<li><a href="${esc(sharePath(name, `/${row.address}`))}">${esc(row.title ?? row.address)}</a>${summary ? ` <span>${esc(summary)}</span>` : ''}</li>`; }), '</ul>'] }) }];
  for (const row of rows) {
    const rowPath = sharePath(name, `/${row.address}`);
    const summary = rowSummary(copy, row) || title;
    const fields = (copy.body.fields ?? []).filter(field => !field.media && valueWords(row.values[field.id]) && valueWords(row.values[field.id]) !== row.title);
    // The row's first picture, video or sound, served from files/<identity>.
    const file = (copy.body.fields ?? []).filter(field => field.media).map(field => (copy.body.files ?? []).find(item => [row.values[field.id]].flat().includes(item.identity))).find(Boolean);
    const type = file?.media_type ?? '';
    const media = !file ? [] : type.startsWith('image/') ? [`<img src="${esc(filePath(file.identity))}" alt="${esc(row.title ?? title)}">`]
      : type.startsWith('video/') ? [`<video controls src="${esc(filePath(file.identity))}"></video>`]
      : type.startsWith('audio/') ? [`<audio controls src="${esc(filePath(file.identity))}"></audio>`] : [];
    pages.push({ path: `${name}/${row.address}/index.html`, text: page({ origin, path: rowPath, title: row.title ?? title, description: summary, listed, structured: [
      { '@context': 'https://schema.org', '@type': 'Article', headline: row.title ?? title, description: summary, url: `${origin}${rowPath}`, ...(row.changed ? { dateModified: row.changed } : {}),
        isPartOf: { '@type': 'CollectionPage', name: title, url: `${origin}${listPath}` } },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: title, item: `${origin}${listPath}` },
        { '@type': 'ListItem', position: 2, name: row.title ?? row.address, item: `${origin}${rowPath}` }] }],
    body: [`<h1>${esc(row.title ?? row.address)}</h1>`, ...media, '<dl>',
      ...fields.filter(field => !isAddress(copy, field.id)).map(field => `<dt>${esc(field.label ?? field.id)}</dt><dd>${esc(valueWords(row.values[field.id]))}</dd>`), '</dl>',
      ...fields.filter(field => isAddress(copy, field.id)).flatMap(field => [row.values[field.id]].flat().filter(href => typeof href === 'string' && /^https:\/\//.test(href))
        .map(href => `<p><a href="${esc(href)}" rel="nofollow">${esc(field.label ?? href)}</a></p>`)),
      `<p><a href="${esc(listPath)}">${esc(fill(A.back, { title }))}</a></p>`] }) });
  }
  return pages;
}

// sitemap.xml and llms.txt over every listed share. A sitemap over sitemap_limit addresses or either document over
// crawler_document_byte_limit bytes becomes an index of parts (sitemap/<n>.xml, llms/<n>.txt), each within the bounds.
const xmlEscape = value => String(value).replace(/[<>&'"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]);
const bytes = text => new TextEncoder().encode(text).byteLength + 1;
function parts(entries, head, tail, { limit }) {
  const docs = [];
  let lines = [], size = 0;
  for (const entry of entries) {
    if (lines.length && (lines.length >= limit || size + bytes(entry) > A.crawler_document_byte_limit - 1024)) { docs.push(lines); lines = []; size = 0; }
    lines.push(entry); size += bytes(entry);
  }
  if (lines.length || !docs.length) docs.push(lines);
  return docs.map(body => [...head, ...body, ...tail].join('\n') + '\n');
}
export function listedDocuments({ origin, shares }) {
  const sitemap = [], llms = [];
  for (const { name, copy } of shares) {
    sitemap.push(`<url><loc>${xmlEscape(origin + sharePath(name))}</loc>${copy.changed ? `<lastmod>${xmlEscape(copy.changed)}</lastmod>` : ''}</url>`);
    llms.push(`## [${copy.title ?? name}](${origin}${sharePath(name)})`, '', ...(copy.body?.about ? [copy.body.about, ''] : []));
    for (const row of shownRows(copy)) {
      const lastmod = row.changed ?? copy.changed;
      sitemap.push(`<url><loc>${xmlEscape(origin + sharePath(name, `/${row.address}`))}</loc>${lastmod ? `<lastmod>${xmlEscape(lastmod)}</lastmod>` : ''}</url>`);
      const summary = rowSummary(copy, row);
      llms.push(`- [${row.title ?? row.address}](${origin}${sharePath(name, `/${row.address}`)})${summary ? `: ${summary}` : ''}`);
    }
    if (shownRows(copy).length) llms.push('');
  }
  const llmsHead = [`# ${A.llms_heading}`, '', `> ${A.llms_about}`, ''];
  const maps = parts(sitemap, ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'], ['</urlset>'], { limit: A.sitemap_limit });
  const texts = parts(llms, llmsHead, [], { limit: Infinity });
  const out = [];
  if (maps.length === 1) out.push({ path: 'sitemap.xml', media_type: 'application/xml', text: maps[0] });
  else {
    maps.forEach((text, n) => out.push({ path: `sitemap/${n + 1}.xml`, media_type: 'application/xml', text }));
    out.push({ path: 'sitemap.xml', media_type: 'application/xml', text: ['<?xml version="1.0" encoding="UTF-8"?>', '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...maps.map((_, n) => `<sitemap><loc>${xmlEscape(`${origin}/share/sitemap/${n + 1}.xml`)}</loc></sitemap>`), '</sitemapindex>'].join('\n') + '\n' });
  }
  if (texts.length === 1) out.push({ path: 'llms.txt', media_type: 'text/plain', text: texts[0] });
  else {
    texts.forEach((text, n) => out.push({ path: `llms/${n + 1}.txt`, media_type: 'text/plain', text }));
    out.push({ path: 'llms.txt', media_type: 'text/plain', text: [...llmsHead, ...texts.map((_, n) => `- [${A.llms_heading} ${n + 1}](${origin}/share/llms/${n + 1}.txt)`)].join('\n') + '\n' });
  }
  return out;
}

/**
 * Every public file of the given shares.
 *   shares: [{ sharing: { record, leave_out?, match_only? }, grant, list: { id, label, about?, fields, share_when?,
 *     views?, public_page? } | null, rows: [{ id, title, values }] | null (not granted), files?: [{ identity, media_type, name?, names? }],
 *     fileOf?: async (identity or name) → that file's facts or null }]
 *   filterRows: the formula engine's row filter ({ tree, fields, rows } → { matches, incomplete }).
 * Returns { files: [{ path, media_type, text } | { path, media_type, identity }], published: [{ code, name, listed }],
 *   left_out: [{ code, because }], ended: [code], next_change_at } (the earliest expiry of a published link, or null).
 */
export async function shareFiles({ origin, now, shares, filterRows }) {
  if (!/^https:\/\/[^/]+$/.test(origin ?? '')) throw new TypeError('origin is the https address the files are served under, with no path, like https://example.com.');
  const out = [], published = [], leftOut = [], ended = [], listed = [];
  const fileRows = new Map();
  let nextChange = null;
  for (const share of shares) {
    const { grant, sharing } = share;
    const code = grant?.code;
    if (typeof code !== 'string' || !code) continue;
    if (!linkOpen(grant, now)) { ended.push(code); continue; }
    const refuse = because => leftOut.push({ code, because });
    if (grant.scope?.kind !== 'public') { refuse(W.not_public); continue; }
    if (grant.when) { refuse(W.when); continue; }
    const part = partOf(sharing.record);
    if (!part && !String(sharing.record).startsWith(`${data.list_kind}:`)) { refuse(W.not_a_list); continue; }
    if (!share.list) { refuse(W.missing); continue; }
    if (!Array.isArray(share.rows)) { refuse(W.rows_not_granted); continue; }
    // A file is looked up only when a row that shows names it: by the share's own fileOf, else its files table.
    const byFile = new Map((share.files ?? []).flatMap(file => [file.identity, ...(file.names ?? []), ...(file.name ? [file.name] : [])].map(key => [key, file])));
    const copied = await listCopy({ fields: share.list.fields ?? [], rows: share.rows, facts: { now, opened: 0 }, filterRows,
      share_when: share.list.share_when ?? null, fileOf: share.fileOf ?? (name => byFile.get(name) ?? null) });
    if (copied.names_opened) { refuse(W.counts_opens); continue; }
    if (copied.names_clock) { refuse(W.clock); continue; }
    let copy;
    try {
      copy = shareableCopy(data.list_kind, sharing.record, { ...share.list, fields: copied.fields, rows: copied.rows, files: copied.files },
        { leave_out: sharing.leave_out ?? [], match_only: sharing.match_only ?? [] });
    } catch { refuse(W.match_only); continue; }
    if (part) {
      // One row of a list: only that row and the files it names.
      const rows = (copy.body.rows ?? []).filter(row => row.id === part.id);
      const media = (copy.body.fields ?? []).filter(field => field.media);
      const named = new Set(rows.flatMap(row => media.flatMap(field => [row.values?.[field.id]].flat())));
      copy = { ...copy, title: rows[0]?.title ?? copy.title, body: { ...copy.body, rows, files: (copy.body.files ?? []).filter(file => named.has(file.identity)) } };
    }
    const name = typeof grant.address === 'string' && ADDRESS.test(grant.address) && !RESERVED.has(grant.address) ? grant.address : code;
    const json = `${JSON.stringify(shareData({ origin, name, copy }))}\n`;
    out.push({ path: `${code}.json`, media_type: 'application/json', text: json });
    if (name !== code) out.push({ path: `${name}.json`, media_type: 'application/json', text: json });
    out.push(...sharePages({ origin, name, copy, listed: grant.listed === true }).map(item => ({ ...item, media_type: 'text/html' })));
    for (const file of copy.body.files ?? []) fileRows.set(file.identity, file);
    if (grant.listed === true) listed.push({ name, copy: { ...copy, changed: latestDay(copy) ?? (String(grant.created_at ?? '').slice(0, 10) || null) } });
    published.push({ code, name, listed: grant.listed === true });
    if (grant.expires_at) nextChange = Math.min(nextChange ?? Infinity, Date.parse(grant.expires_at));
  }
  for (const file of fileRows.values()) out.push({ path: `files/${file.identity}`, media_type: file.media_type ?? 'application/octet-stream', identity: file.identity });
  out.push(...listedDocuments({ origin, shares: listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }));
  const seen = new Set();
  for (const item of out) {
    if (seen.has(item.path)) throw new Error(`Two shares would write ${item.path}; each readable address belongs to one link.`);
    seen.add(item.path);
  }
  return { files: out, published, left_out: leftOut, ended, next_change_at: nextChange === null ? null : new Date(nextChange).toISOString() };
}
