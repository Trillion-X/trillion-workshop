// src/record-share-pages.mjs
//
// PURPOSE
//   The one page a share link opens (/share/<code>), whatever it shares: a file, words, a link, a record, a collection,
//   a sales contract. The grant owner (src/record-sharing.mjs) remains the only authority: the page and every byte
//   request resolve the current grant before reading anything. What the link lets its recipient do beyond seeing it
//   (record-sharing.json abilities: sign, pay) is drawn by ABILITY_SECTIONS, one section per ability id the link
//   carries, so a kind of record never has a page of its own.
//
//   GET  /share/<code>                    the page; ?paid=1 settles a payment on the way back from checkout
//   GET  /share/<code>[/items/<n>]/<part> a shared file's bytes (file, preview, poster) or its timed words
//   GET  /share/<code>/_sender            the current sender name for a deferred public-page attribution
//   GET  /share/<code>/look               the sharer's logo, when the link carries their brand
//   GET  /share/<code>.json               what the page shows, as data any site or AI can read (CORS open): a list's
//                                         fields, the rows shown right now and a link to each file they name
//   GET  /share/<code>/files/<identity>   one file a shared list's shown rows name (src/list-copy.mjs), and no other
//   POST /share/<code>/prove              { email } sends a code; { email, code } proves it (src/share-visitor.mjs);
//                                         { access_code } opens a link that needs its code
//   POST /share/<code>/sign               { name } signs, for a link that asks for a signature
//   POST /share/<code>/pay                starts checkout, for a link that takes a payment
//   GET  /share/<code>/sealed             a sealed link's sealed copy { content_id, value, role, can } (CORS closed; the
//                                         key is in the link's fragment, so only its holder opens it)
//   POST /share/<code>/sealed             { sealed_copy, expected_content_id } a writer's replacement (compare-and-set)
//   POST /share/<code>/add                adds files to a folder link that takes them: a page's multipart form, or
//                                         JSON { name, byte_length } from a computer, answered with where to send bytes
//
// NON-NEGOTIABLE INVARIANTS
//   1. Who the recipient is comes only from the route: a signed-in account, or an email this browser proved with a
//      code. A form field never names a recipient.
//   2. Every page ends with record-sharing.json look.made_with, whichever brand it carries.
//   3. A POST is accepted only from this service's own pages (its Origin header).
//   4. Nothing here names a kind of record; abilities are drawn by their id from ABILITY_SECTIONS.
//
import { availabilityPageSections } from '../parts/calendar-booker/read-data/availability-page-sections.mjs';
import { htmlPage } from './html-page.mjs';
import { sharedSiteViewResponse } from './shared-site-view.mjs';
import { nativeShareOwnerFor } from './native-record-sharing.mjs';
import { wornLook } from './page-look.mjs';
import { backgroundTone } from './brand-assets.mjs';
import sharing from './record-sharing.json' with { type: 'json' };
import { configurationOpenPath } from './configurations.mjs';
import { crawlerDocumentKey } from './crawler-document-key.mjs';
import { RECORD_SHARE_LINK_INDEX, RECORD_SHARE_LISTED_INDEX, SEALED_LINK_KIND, SharingError, latestDay, listRows } from './record-sharing.mjs';
import { checkShareCode, sendShareCode } from './share-visitor.mjs';
import { paidRoom, reservePaid } from './payment.mjs';
import { keepStream, lazyChunkCopiesFor, rangeStream, scopedOriginForRead, startUploadFor } from './namespace.mjs';
import { HOT_PREFIX_BYTES, namespaceEdgeRange } from './namespace-edge-cache.mjs';
import { multipartByteStream, parseByteRange } from './byte-range.mjs';
import { sampledStorageProbe } from './rpc-storage-probe.mjs';
import { MAX_ORIGINAL_COVER_BYTES, TRANSPARENT_COVER, rasterImageTypeFor, savedImageCover } from './share-image-cover.mjs';
import { markdownText } from '../parts/ui/show/document-page/document-page-html.mjs';
import { comparisonIndexSections, comparisonRowSections, comparisonRows } from './list-public-comparison.mjs';
import { LIST_PUBLIC_COMPARISON_CSS } from '../parts/screen-look/show/list-public-comparison.mjs';

const noCache = { 'cache-control': 'private, no-store' };
// The owner reports only its code version and the bounded outcome of the
// selected clock. A missing duration must not be mistaken for zero admission.
const shareAdmissionDiagnostics = timing => {
  const fields = [];
  if (['measured', 'selection-failed', 'start-failed', 'finish-failed', 'nonfinite'].includes(timing?.admission_state))
    fields.push(`access_admission_state;desc="${timing.admission_state}"`);
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(timing?.owner_version ?? ''))
    fields.push(`owner_version;desc="${timing.owner_version}"`);
  return fields;
};
const sharedFileCors = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'content-range, content-length, content-type, content-disposition, accept-ranges, retry-after, x-trillion-expected-bytes',
};
const withSharedFileCors = response => {
  for (const [name, value] of Object.entries(sharedFileCors)) response.headers.set(name, value);
  return response;
};
const noShareReferrer = { 'referrer-policy': 'no-referrer' };
const sharedDataFailure = (status, method, message = status === 503 ? 'This share is temporarily unavailable.' : 'This share is not available.') => {
  const headers = { ...noCache, ...noShareReferrer, 'access-control-allow-origin': '*',
    'access-control-expose-headers': 'retry-after', 'x-content-type-options': 'nosniff',
    ...(status === 503 ? { 'retry-after': '10' } : {}) };
  return method === 'HEAD'
    ? new Response(null, { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } })
    : Response.json({ error: message }, { status, headers });
};
// The owner can refuse a call before its method starts. Keep only a fixed reason
// category in logs: an exception message may contain a private file or link.
function shareOwnerFailureCategory(error) {
  const said = [error?.message, error?.cause?.message].filter(value => typeof value === 'string').join(' ');
  if (/Exceeded the maximum database size|SQLITE_FULL/i.test(said)) return 'store-full';
  if (/\b(?:timed? out|timeout|deadline|did not respond|aborted)\b/i.test(said)) return 'timeout';
  if (/\b(?:overloaded?|too many requests|queue(?:d|ing)?|capacity)\b/i.test(said)) return 'overload';
  if (/\b(?:CPU|memory|resource) limit\b/i.test(said)) return 'owner-limit';
  if (/\b(?:Durable Object|jsrpc|RPC)\b/i.test(said)) return 'owner-rpc';
  if (/\b(?:database|storage|sqlite)\b/i.test(said)) return 'storage';
  return 'other';
}
// A recipient may cancel before Server-Timing reaches their browser. Name only
// the pending stage, never the link, recipient or file, so slow live reads can
// be located without weakening the current grant check or logging private data.
const SLOW_SHARE_STAGE_MS = 1_000;
async function watchedShareStage(stage, work, probeId = null) {
  const started = performance.now();
  const probe = probeId ? { probe_id: probeId } : {};
  const waiting = setTimeout(() => console.warn('public share stage waiting', { stage, ...probe, elapsed_ms: Math.round(performance.now() - started) }), SLOW_SHARE_STAGE_MS);
  try { return await work(); }
  finally {
    clearTimeout(waiting);
    const elapsed = performance.now() - started;
    if (elapsed >= SLOW_SHARE_STAGE_MS) console.warn('public share stage ended', { stage, ...probe, elapsed_ms: Math.round(elapsed) });
  }
}
const gone = (body = 'This share link has ended.') => shareErrorPage(body, 404);
const temporarilyUnavailable = () => shareErrorPage('This share is temporarily unavailable.', 503,
  'Try opening the link again in a moment.');
const wordsFor = name => String(name ?? 'shared file').split(/[\\/]/).pop().replace(/[:*?"<>|]/g, '-').slice(0, 160) || 'shared-file';
const mediaTypeFor = (declared, name) => {
  if (declared && declared !== 'application/octet-stream') return declared;
  const extension = String(name ?? '').split(/[?#]/)[0].match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  return ({ mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[extension] ?? declared ?? 'application/octet-stream';
};
// How a shared file of words is read on its page (record-sharing.json reading): as markdown, as plain words whose line
// breaks are kept, or not at all (any other file shows its player, picture or buttons).
const endingOf = name => String(name ?? '').split(/[?#]/)[0].match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? null;
const readingOf = (type, name) => {
  const media = String(type ?? '').split(';')[0].trim();
  const ending = endingOf(name);
  // The name's ending wins over the declared type: words saved as text/plain under a .md name are still markdown.
  return ['markdown', 'plain'].find(kind => sharing.reading[kind].endings.includes(ending))
    ?? ['markdown', 'plain'].find(kind => sharing.reading[kind].media_types.includes(media)) ?? null;
};
// A file of words is titled by its name without its ending, and a first heading that only repeats that title is not
// drawn twice.
const readingTitle = title => String(title ?? '').replace(/\.(md|markdown|mdown|txt|text)$/i, '');
const withoutRepeatedTitle = (words, title) => {
  const first = /^\s*#{1,2}\s+(.+?)\s*#*\s*(?:\n|$)/.exec(words);
  const plain = value => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return first && plain(first[1]) === plain(title) ? words.slice(first[0].length) : words;
};

// The words of a shared file of words, read through the same grant as its bytes: at most reading.most_bytes, cut at the
// last whole line when the file is longer. Null when the file is not words, or its words cannot be read right now (the
// page then shows the file's own buttons, as for any file).
async function sharedWords({ request, env, ctx, person, code, recipient, copy }) {
  if (copy?.kind !== 'file') return null;
  const name = copy.body?.name ?? copy.title;
  const reading = readingOf(mediaTypeFor(copy.body?.media_type, name), name);
  if (!reading) return null;
  const range = `bytes=0-${sharing.reading.most_bytes - 1}`;
  try {
    const access = await person.sharedFileForLink(code, recipient, 'file', range, true, Date.now(), crypto.randomUUID());
    if (access?.copy?.kind !== 'file' || access.copy.body?.identity !== copy.body?.identity) return null;
    const answer = await sharedBytes(new Request(request.url, { signal: request.signal }), env, access, 'file', () => {}, ctx, person, range, recipient);
    if (!answer.ok) return null;
    const bytes = new Uint8Array(await answer.arrayBuffer());
    const total = Number(answer.headers.get('content-range')?.split('/')[1] ?? bytes.byteLength);
    const whole = !(total > bytes.byteLength);
    const text = new TextDecoder().decode(bytes);
    return { reading, whole, text: whole ? text : text.slice(0, Math.max(0, text.lastIndexOf('\n'))) };
  } catch (error) {
    console.error('shared words could not be read', { reason: shareOwnerFailureCategory(error) });
    return null;
  }
}

const readableSteps = steps => Array.isArray(steps)
  ? steps.map((step, index) => {
    const words = typeof step?.do === 'string' ? step.do : typeof step?.label === 'string' ? step.label : null;
    return words?.trim() ? `${index + 1}. ${words.trim()}` : null;
  }).filter(Boolean).join(' · ')
  : '';

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => values[name] ?? whole);
const sharePath = (code, rest = '') => `/share/${encodeURIComponent(code)}${rest}`;
const withCode = (path, accessCode) => `${path}${accessCode ? `${path.includes('?') ? '&' : '?'}access_code=${encodeURIComponent(accessCode)}` : ''}`;
const COLLECTION_PAGE_SIZE = 32;
const COLLECTION_VIEW_PAGE_SIZE = 12;
const collectionWindow = (copy, pageSize = COLLECTION_PAGE_SIZE) => {
  const offset = Number.isSafeInteger(copy.item_offset) && copy.item_offset >= 0 ? copy.item_offset : 0;
  const allItems = Array.isArray(copy.items) ? copy.items : [];
  const items = allItems.slice(0, pageSize);
  const count = Number.isSafeInteger(copy.item_count) && copy.item_count >= 0 ? copy.item_count : offset + allItems.length;
  return { offset, items, count, hasMore: copy.has_more === true || offset + items.length < count };
};
const collectionPath = (code, offset = 0, data = false) => sharePath(code, `${data ? '.json' : ''}${offset ? `?offset=${offset}` : ''}`);
const collectionItemPath = (code, index) => sharePath(code, `?item=${index}`);
const collectionPagination = (code, window, accessCode) => {
  const pageCount = Math.ceil(window.count / COLLECTION_VIEW_PAGE_SIZE);
  if (pageCount < 2) return null;
  const current = Math.min(pageCount, Math.floor(window.offset / COLLECTION_VIEW_PAGE_SIZE) + 1);
  const visible = new Set([1, pageCount]);
  for (let page = Math.max(1, current - 2); page <= Math.min(pageCount, current + 2); page++) visible.add(page);
  const pages = [];
  let last = 0;
  for (const number of [...visible].sort((a, b) => a - b)) {
    if (number - last > 1) pages.push({ ellipsis: true });
    pages.push({ number, current: number === current, href: withCode(collectionPath(code, (number - 1) * COLLECTION_VIEW_PAGE_SIZE), accessCode) });
    last = number;
  }
  return { label: 'Shared items pages', pages,
    previous: { label: 'Previous', ...(window.offset > 0 ? { href: withCode(collectionPath(code, Math.max(0, window.offset - COLLECTION_VIEW_PAGE_SIZE)), accessCode) } : {}) },
    next: { label: 'Next', ...(window.hasMore && window.items.length ? { href: withCode(collectionPath(code, window.offset + window.items.length), accessCode) } : {}) },
  };
};
const money = terms => new Intl.NumberFormat('en', { style: 'currency', currency: terms.currency.toUpperCase() }).format(terms.amount_cents / 100);
const paymentWords = terms => terms.payment_timing === 'subscription'
  ? `${money(terms)} every ${terms.interval_count && terms.interval_count > 1 ? `${terms.interval_count} ` : ''}${terms.interval}${terms.interval_count && terms.interval_count > 1 ? 's' : ''}${Number.isSafeInteger(terms.billing_cycles) ? ` for ${terms.billing_cycles} payments` : ''}`
  : `${money(terms)} one time`;
const termItems = terms => [
  ...(Number.isSafeInteger(terms.total_contract_amount_cents) ? [{ heading: 'Agreement total', body: new Intl.NumberFormat('en', { style: 'currency', currency: terms.currency.toUpperCase() }).format(terms.total_contract_amount_cents / 100) }] : []),
  ...(terms.description ? [{ heading: 'Details', body: terms.description }] : []),
  ...(Array.isArray(terms.line_items) && terms.line_items.length > 1 ? terms.line_items.map(line => ({
    heading: line.label,
    body: new Intl.NumberFormat('en', { style: 'currency', currency: terms.currency.toUpperCase() }).format(line.amount_cents / 100),
  })) : []),
  ...(Array.isArray(terms.included) ? terms.included.map(row => ({
    heading: row.label,
    body: Number.isSafeInteger(row.quantity) ? `${row.quantity} ${row.unit ?? 'included'}${row.per ? ` per ${row.per}` : ''}` : 'Included with this order',
  })) : []),
];
const dateWords = at => new Date(at).toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' });

// The look a recipient page wears: the sharer's own worn look (look.worn, from their store), else the look every page
// starts with; the brand a link carries (record-sharing.json look) only sets the accent, name and logo over it. One look
// owner (src/page-look.mjs wornLook): a share never wears a look of its own or the service operator's.
const pageLookOf = look => wornLook(look?.worn);
// The Trillion marks are drawn in the tone of the ground they sit on (black ink on a light look, white on a dark one).
const toned = (src, look) => `${src}?tone=${backgroundTone(pageLookOf(look).palette)}`;
// The brand a page carries (record-sharing.json look): the sharer's own name, logo and colour, or Trillion's.
function brandSection(code, look) {
  if (look.kind === 'own') return {
    emphasis: 'share-brand',
    ...(look.logo ? { mark: { src: sharePath(code, '/look'), alt: '' } } : {}),
    body: look.name,
  };
  return { emphasis: 'share-brand', mark: { src: toned(sharing.look.trillion.logo, look), alt: sharing.look.trillion.name } };
}
const madeWith = look => ({ emphasis: 'share-footer', actions: [{ label: sharing.look.made_with.label, href: sharing.look.made_with.href, tone: 'quiet', mark_after: true, mark: { src: toned(sharing.look.made_with.mark, look), alt: sharing.look.made_with.alt, loading: sharing.look.made_with.loading, underline: sharing.look.made_with.underline } }] });
// A brand's colour becomes the page's accent: the page shell reads its buttons and accents from these variables.
const lookWith = look => {
  const worn = pageLookOf(look);
  const base = { ...worn, stylesheets: [...worn.stylesheets, '/workspace/public-share.css'] };
  return look.kind === 'own' && look.accent
    ? { ...base, palette: { ...worn.palette, '--button-primary-bg': look.accent, '--button-primary-bg-hover': look.accent, '--accent-primary': look.accent } }
    : base;
};
const shareFrame = (code, look, sections) => ({
  layout: 'share', look: lookWith(look),
  sections: [brandSection(code, look), ...sections, madeWith(look)],
});
function shareErrorPage(title, status, body) {
  return htmlPage({
    ...shareFrame('', { kind: 'trillion', name: sharing.look.trillion.name }, [
      { emphasis: 'share-heading', heading: title, heading_level: 1, ...(body ? { body } : {}) },
    ]),
    robots: 'noindex', island: null, title,
    share: { type: 'website', site_name: sharing.look.trillion.name, title,
      image: 'https://app.gettrillion.ai/icon-512.png', image_alt: 'Trillion needle and red thread', image_card: 'summary' },
  }, { ...noCache, ...noShareReferrer, ...(status === 503 ? { 'retry-after': '10' } : {}) }, status);
}
// A listed link (record-sharing.json addresses `listed`) is a page for search and answer engines: indexed, described by
// its own words, with structured data, and kept briefly by browsers and the edge; every other link stays noindex and
// unkept, so a revoked link stops at once.
// Chromium sends Origin: null for a form POST from a no-referrer document. Keep
// cross-site referrers absent while allowing same-origin action forms to pass the
// destination owner's Origin check.
const hasPostAction = section => Boolean(section?.choices?.href || section?.actions?.some(action => action?.post)
  || section?.items?.some(hasPostAction));
const page = ({ origin, code, look, title, sections, island = null, status = 200, headers = {}, listed = false, path = sharePath(code), description = null, structured = null, previewImage = null, inline_css = null }) => htmlPage({
  ...shareFrame(code, look, sections), robots: listed ? 'index, follow' : 'noindex', island: inline_css ? { ...(island ?? {}), inline_css } : island, title, canonical_origin: origin, canonical_path: path, ...(inline_css ? { inline_css } : {}),
  ...(listed && description ? { meta_description: description } : {}),
  ...(listed && structured ? { structured_data: structured } : {}),
  share: { type: 'website', site_name: look.name, title, description: listed && description ? description : `Open this shared item on ${look.name}.`, url: `${origin}${path}`,
    image: previewImage?.url ?? `${origin}/icon-512.png`, image_alt: previewImage?.alt ?? 'Trillion needle and red thread', image_card: previewImage ? 'summary_large_image' : 'summary' },
}, { ...(listed ? { 'cache-control': `public, max-age=${sharing.addresses.fresh_seconds}` } : noCache),
  ...headers, 'referrer-policy': sections?.some(hasPostAction) ? 'same-origin' : 'no-referrer' }, status);

// A field's value as words on a row page: text as it is, a list joined, a number as written.
const valueWords = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' || typeof item === 'number').join(', ')
  : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const excerpt = (words, most = 220) => (words.length > most ? `${words.slice(0, most).replace(/\s+\S*$/, '')}…` : words);
// A gallery tile names the destination, while its focused page keeps the full address.
// Paths and query strings can be arbitrarily long and do not help someone scan a collection.
const linkDestination = address => {
  if (typeof address !== 'string') return '';
  try {
    const url = new URL(address);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host.replace(/^www\./i, '') : '';
  } catch { return ''; }
};
const fileNameForCard = name => typeof name === 'string' ? name.split('/').filter(Boolean).at(-1) ?? '' : '';
const cardDescription = (item, destination) => {
  if (item.kind === 'withdrawn') return 'This item is no longer available.';
  if (item.kind === 'text') return item.body?.text;
  if (item.kind === 'link') return item.title === item.body?.url ? '' : destination;
  if (item.kind === 'file') {
    const name = fileNameForCard(item.body?.name);
    return name && name !== item.title ? name : '';
  }
  if (item.kind === 'workflow') return item.body?.job
    ?? (item.preview?.fields ?? []).find(field => field.id === 'job')?.value
    ?? (item.preview?.fields ?? []).find(field => field.id === 'goal')?.value
    ?? '';
  return (item.preview?.fields ?? []).map(field => field.value).find(value => typeof value === 'string'
    && value.trim() && value !== item.title) ?? '';
};
const fieldOf = (copy, id) => (copy.body?.fields ?? []).find(field => field.id === id);
const isAddress = (copy, id) => sharing.addresses.address_kinds.includes(fieldOf(copy, id)?.kind);
// The words that describe a row: its first field of a describing kind (record-sharing.json addresses summary_kinds),
// else its first other words after the title.
const rowSummary = (copy, row) => {
  const fields = (copy.body.fields ?? []).filter(field => !isAddress(copy, field.id) && !field.media);
  const ordered = [...fields.filter(field => sharing.addresses.summary_kinds.includes(field.kind)), ...fields.filter(field => !sharing.addresses.summary_kinds.includes(field.kind))];
  return excerpt(ordered.map(field => valueWords(row.values[field.id])).find(words => words && words !== row.title) ?? '');
};

// A sealed link's page: the words only (record-sharing.json sealed.page_words) and one host the share script fills in
// the browser, after opening the sealed copy with the key the link's fragment carries. Nothing here can read the record.
const sealedLinkPage = ({ origin, code, copy, access }) => {
  const words = sharing.sealed.page_words;
  return page({
    origin, code, look: access.look, title: words.heading, listed: false, description: words.heading, path: sharePath(code), headers: noCache,
    island: SHARE_ISLAND,
    sections: [
      { emphasis: 'share-heading', heading: words.heading, heading_level: 1, body: copy.body.role === 'writer' ? words.role_writer : words.role_reader },
      { emphasis: 'share-entry', views: [{ as: 'sealed-link', label: words.heading, settings: { code, words }, fields: [], rows: [], files: [] }] },
    ],
  });
};

// The saved views a list copy says to draw another way (src/list-copy.mjs shown_views): one section for each, headed by the
// view's own label, holding an empty host with the fields and the rows that view keeps; the page's script draws it
// (src/workspace/share-view.tsx). Nothing here names a kind of view: `display.as` goes through as written.
const shownViewSections = (copy, rows, code, accessCode) => {
  const byId = new Map(rows.map(row => [row.id, row]));
  return (copy.body?.shown_views ?? []).filter(view => view?.display?.as).map(view => ({
    emphasis: 'share-entry', heading: view.label ?? view.display.as, heading_level: 2,
    views: [{ as: view.display.as, label: view.label, settings: view.display.settings,
      fields: copy.body.fields ?? [], files: (copy.body.files ?? []).map(file => ({ identity: file.identity,
        media_type: mediaTypeFor(file.media_type, file.name), url: withCode(sharePath(code, `/files/${file.identity}`), accessCode),
        ...(file.poster_identity && file.poster_media_type?.startsWith('image/')
          ? { poster_url: withCode(sharePath(code, `/files/${file.identity}/poster`), accessCode) } : {}) })),
      rows: (view.row_ids ?? []).map(id => byId.get(id)).filter(Boolean).map(row => ({ id: row.id, title: row.title, values: row.values })) }],
  }));
};
// A page that carries a shown view loads the share script and sheet, whatever the view is drawn as.
const SHARE_ISLAND = { bundle_url: '/workspace/share-view.js', stylesheet_url: '/workspace/share-view.css' };

// A shared thing that holds rows (src/record-sharing.mjs listRows): the list page names every row with its own
// address, and each row has its own page with every field the list shows. Nothing here names a kind of record.
function rowsPage({ origin, code, copy, access, accessCode = null, rowAddress = null }) {
  const rows = listRows(copy);
  const listPath = sharePath(code);
  const listVisitPath = withCode(listPath, accessCode);
  const presentation = copy.body?.public_page?.layout === 'comparison' ? copy.body.public_page : null;
  const visibleRows = presentation ? comparisonRows(presentation, rows) : rows;
  const pageOf = (title, description, sections, path, structured, island = null) => page({ origin, code, look: access.look, title, sections, listed: access.listed, path, description, structured, island,
    ...(presentation ? { inline_css: LIST_PUBLIC_COMPARISON_CSS } : {}) });
  const changed = latestDay(copy);
  if (rowAddress === null) {
    const description = excerpt(copy.body?.about || `${copy.title}: ${visibleRows.map(row => row.title).filter(Boolean).slice(0, 6).join(', ')}.`, 300);
    const viewSections = shownViewSections(copy, rows, code, accessCode);
    return pageOf(copy.title, description, [...(presentation ? comparisonIndexSections({ page: presentation, copy, rows,
      rowPath: row => withCode(sharePath(code, `/${row.address}`), accessCode) }) : [
      { emphasis: 'share-heading', heading: copy.title, heading_level: 1, ...(copy.body?.about ? { body: copy.body.about } : {}) },
      { emphasis: 'share-entry', heading: sharing.addresses.rows_heading, heading_level: 2,
        items: rows.map(row => ({ heading: row.title ?? row.address, body: rowSummary(copy, row), actions: [{ label: sharing.addresses.row_open, href: withCode(sharePath(code, `/${row.address}`), accessCode), tone: 'quiet' }] })) },
    ]), ...viewSections], listPath, [
      { '@context': 'https://schema.org', '@type': 'CollectionPage', name: copy.title, description, url: `${origin}${listPath}`, ...(changed ? { dateModified: changed } : {}),
        mainEntity: { '@type': 'ItemList', numberOfItems: visibleRows.length, itemListElement: visibleRows.map((row, index) => ({ '@type': 'ListItem', position: index + 1, name: row.title ?? row.address, url: `${origin}${sharePath(code, `/${row.address}`)}` })) } },
    ], viewSections.length ? SHARE_ISLAND : null);
  }
  const row = visibleRows.find(item => item.address === rowAddress);
  if (!row) return null;
  const rowPath = sharePath(code, `/${row.address}`);
  if (presentation) {
    const description = rowSummary(copy, row) || copy.title;
    const sections = comparisonRowSections({ page: presentation, copy, row, rows: [...rows, ...(copy.body?.evidence_rows ?? [])], listPath: listVisitPath,
      rowPath: other => withCode(sharePath(code, `/${other.address}`), accessCode) });
    return pageOf(row.title ?? copy.title, description, sections, rowPath, [
      { '@context': 'https://schema.org', '@type': 'Article', headline: row.title ?? copy.title, description, url: `${origin}${rowPath}`,
        ...(row.changed ? { dateModified: row.changed } : {}), isPartOf: { '@type': 'CollectionPage', name: copy.title, url: `${origin}${listPath}` } },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: copy.title, item: `${origin}${listPath}` },
        { '@type': 'ListItem', position: 2, name: row.title ?? row.address, item: `${origin}${rowPath}` }] },
    ]);
  }
  const shownFields = (copy.body.fields ?? []).filter(field => !field.media && valueWords(row.values[field.id]) && valueWords(row.values[field.id]) !== row.title);
  const description = rowSummary(copy, row) || copy.title;
  // The row's first picture, video or sound (a media field, src/list-copy.mjs), served through this same link.
  const file = (copy.body.fields ?? []).filter(field => field.media).map(field => (copy.body.files ?? []).find(item => item.identity === row.values[field.id])).find(Boolean);
  const fileType = file ? mediaTypeFor(file.media_type, file.name) : '';
  const media = file && /^(image|video|audio)\//.test(fileType) ? { src: withCode(sharePath(code, `/files/${file.identity}`), accessCode), type: fileType, label: row.title ?? copy.title } : null;
  return pageOf(row.title ?? copy.title, description, [
    { emphasis: 'share-featured', heading: row.title ?? row.address, heading_level: 1, ...(media ? { media } : {}),
      items: shownFields.filter(field => !isAddress(copy, field.id)).map(field => ({ heading: field.label, body: valueWords(row.values[field.id]) })),
      actions: [
        ...shownFields.filter(field => isAddress(copy, field.id)).flatMap(field => [row.values[field.id]].flat().filter(href => typeof href === 'string' && /^https:\/\//.test(href)).map(href => ({ label: field.label, href, tone: 'quiet' }))),
        { label: fill(sharing.addresses.back, { title: copy.title }), href: listVisitPath, tone: 'quiet' },
      ] },
  ], rowPath, [
    { '@context': 'https://schema.org', '@type': 'Article', headline: row.title ?? copy.title, description, url: `${origin}${rowPath}`, ...(row.changed ? { dateModified: row.changed } : {}),
      isPartOf: { '@type': 'CollectionPage', name: copy.title, url: `${origin}${listPath}` } },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.title, item: `${origin}${listPath}` },
      { '@type': 'ListItem', position: 2, name: row.title ?? row.address, item: `${origin}${rowPath}` }] },
  ]);
}

// Proving an email (src/share-visitor.mjs): the email form, then the code form. Words are record-sharing.json proof.
const proofForm = (code, { named, sender, email = '', error = null, heading = null }) => ({
  emphasis: 'share-featured', heading: heading ?? fill(sharing.proof.heading, { sender }), heading_level: 1,
  body: error ?? (named ? sharing.proof.body_named : sharing.proof.body),
  choices: { href: sharePath(code, '/prove'), values: {}, fields: [{ name: 'email', label: sharing.proof.email_label, kind: 'email', autocomplete: 'email', required: true, value: email }], submit: { label: sharing.proof.send, tone: 'primary' } },
  actions: [{ label: sharing.proof.sign_in_instead, href: `/account?next=${encodeURIComponent(sharePath(code))}`, tone: 'quiet' }],
});
const codeForm = (code, email, error = null) => ({
  emphasis: 'share-featured', heading: sharing.proof.code_heading, heading_level: 1,
  body: error ?? fill(sharing.proof.code_body, { email }),
  choices: { href: sharePath(code, '/prove'), values: { email }, fields: [{ name: 'code', label: sharing.proof.code_label, kind: 'text', autocomplete: 'one-time-code', inputmode: 'numeric', required: true, max_length: 6 }], submit: { label: sharing.proof.check, tone: 'primary' } },
  actions: [{ label: sharing.proof.send, href: sharePath(code), tone: 'quiet' }],
});

// One section per ability a link carries beyond seeing it (record-sharing.json abilities). Each gets the access the
// owner answered, the person store and the recipient, and answers its sections. Adding an ability is a row in the
// DATA and an entry here; nothing else on the page changes.
const addFilesForm = (code, accessCode, sender, body = null) => ({ emphasis: 'share-entry', heading: sharing.adding.heading, heading_level: 2,
  body: body ?? fill(sharing.adding.body, { sender }),
  choices: { href: withCode(sharePath(code, '/add'), accessCode), values: {}, fields: [{ name: 'files', label: sharing.adding.files_label, kind: 'file', multiple: true, required: true }], submit: { label: sharing.adding.submit, tone: 'primary' } } });
const ABILITY_SECTIONS = {
  book: async ({code,access,accessCode}) => [{emphasis:'share-entry',heading:'Find a time',heading_level:2,body:'Choose an available time for this meeting.',actions:[{label:'Choose a time',href:withCode(sharePath(code,'/book'),accessCode),tone:'primary'}]}],
  async add_files({ code, access, accessCode }) {
    return [addFilesForm(code, accessCode, access.sender ?? sharing.delivery.someone)];
  },
  async sign({ code, access }) {
    if (access.signed_by_you || (access.signatures.length && !access.proven)) {
      return access.signatures.map(item => ({ emphasis: 'share-entry', heading: sharing.signing.heading, heading_level: 2, body: fill(sharing.signing.signed, { name: item.name, date: dateWords(item.signed_at) }) }));
    }
    if (!access.proven) return [];
    return [{ emphasis: 'share-entry', heading: sharing.signing.heading, heading_level: 2, body: sharing.signing.body,
      choices: { href: sharePath(code, '/sign'), values: {}, fields: [{ name: 'name', label: sharing.signing.name_label, kind: 'text', autocomplete: 'name', required: true, min_length: 2, max_length: 200 }], submit: { label: sharing.signing.submit, tone: 'primary' } } }];
  },
  async pay({ code, access, person, recipient }) {
    const owed = await person.sharePaymentTerms(code, recipient);
    if (!owed) return [];
    let { terms, status, payment_end_reason: paymentEndReason, amount_due_today_cents: amountDueTodayCents, payments_received: paymentsReceived } = owed;
    if (status === 'payment-received' && recipient.buyer_ref) {
      await person.settleSharePayment(code, recipient).catch(paidCheckFailed);
      ({ terms, status, payment_end_reason: paymentEndReason, amount_due_today_cents: amountDueTodayCents, payments_received: paymentsReceived } = await person.sharePaymentTerms(code, recipient));
    }
    const price = { emphasis: 'share-entry', heading: terms.label, heading_level: 2, body: paymentWords(terms), ...(termItems(terms).length ? { items: termItems(terms) } : {}) };
    if (status === 'paid') return [{ ...price, body: amountDueTodayCents === 0
      ? sharing.paying.no_payment_required : Number.isSafeInteger(terms.billing_cycles)
        ? `Payment ${paymentsReceived || 1} of ${terms.billing_cycles} received. ${paymentWords(terms)}.`
        : `${sharing.paying.paid} ${paymentWords(terms)}.` }];
    if (status === 'awaiting-payment') return [{ ...price, body: 'Your payment method is saved. Your first payment is being checked.',
      actions: [{ label: sharing.paying.check_again, href: sharePath(code), tone: 'primary' }] }];
    if (status === 'payment-ended') return [{ ...price, body: paymentEndReason === 'disputed' ? sharing.paying.disputed
      : paymentEndReason === 'subscription-ended' ? sharing.paying.subscription_ended : sharing.paying.refunded }];
    if (status === 'payment-received') return [{ ...price, body: sharing.paying.received, actions: [{ label: sharing.paying.check_again, href: sharePath(code), tone: 'primary' }] }];
    if (status === 'taken') return [{ ...price, body: 'This was already accepted by someone else.' }];
    if (!access.proven) return [price];
    if (access.can.includes('sign') && !access.signatures.length) return [{ ...price, body: `${paymentWords(terms)}. ${sharing.paying.sign_first}` }];
    return [{ ...price, actions: [{ label: sharing.paying.submit, href: sharePath(code, '/pay'), tone: 'primary', post: {} }] }];
  },
};

const recordPage = async ({ origin, code, copy, access, person, recipient, accessCode = null, rowAddress = null, words = null, focusIndex = null }) => {
  if (copy.kind === SEALED_LINK_KIND) return sealedLinkPage({ origin, code, copy, access });
  if (listRows(copy)) return rowsPage({ origin, code, copy, access, accessCode, rowAddress }) ?? gone('This row is not in this list.');
  if (rowAddress !== null) return gone('This page is not in this share.');
  const collection = copy.kind === 'collection';
  const window = collection ? collectionWindow(copy, COLLECTION_VIEW_PAGE_SIZE) : null;
  const focused = collection && focusIndex !== null;
  const localFocus = focused ? focusIndex - window.offset : -1;
  if (focused && (localFocus < 0 || localFocus >= window.items.length)) return gone('This item is not in this share.');
  const title = focused ? window.items[localFocus].title || 'Shared item'
    : (words ? readingTitle(copy.title) : copy.title) || (copy.kind === 'file' ? 'Shared file' : collection ? 'Shared items' : 'Shared item');
  const sectionFor = (item, index) => {
    const file = item.kind === 'file';
    const link = item.kind === 'link';
    const text = item.kind === 'text';
    const itemTitle = (words ? readingTitle(item.title) : item.title) || (file ? 'Shared file' : 'Shared item');
    const type = mediaTypeFor(item.body?.media_type, item.body?.name ?? itemTitle);
    const prefix = sharePath(code, collection ? `/items/${window.offset + index}` : '');
    const filePath = withCode(`${prefix}/file`, accessCode);
    const previewPath = withCode(`${prefix}/preview`, accessCode);
    const posterPath = withCode(`${prefix}/poster`, accessCode);
    const transcriptPath = withCode(`${prefix}/transcript`, accessCode);
    const hasPreview = typeof item.body?.preview_identity === 'string' && item.body.preview_media_type?.startsWith('video/');
    const shownType = hasPreview ? item.body.preview_media_type : type;
    const playable = /^(audio|video)\//.test(shownType);
    const downloadPath = `${filePath}${filePath.includes('?') ? '&' : '?'}download=1`;
    const detailFields = file ? [] : (item.preview?.fields ?? []).filter(field => field.value && field.value !== itemTitle
      && field.label && field.label !== field.id && (!field.hide_when_ability || !access.can.includes(field.hide_when_ability)));
    const details = detailFields.map(field => ({
      heading: field.label,
      body: item.kind === 'workflow' && field.id === 'steps' ? readableSteps(item.body?.steps) || field.value : field.value,
    }));
    if (item.kind === 'workflow' && !detailFields.some(field => field.id === 'steps')) {
      const steps = readableSteps(item.body?.steps);
      if (steps) details.push({ heading: 'Steps', body: steps });
    }
    const presentation = { emphasis: collection && !focused ? 'share-entry' : 'share-featured', heading: itemTitle, heading_level: collection && !focused ? 2 : 1 };
    if (item.kind === 'withdrawn') return { ...presentation, body: 'This item is no longer available.' };
    if (link) return { ...presentation, body: item.body?.url ?? '', actions: [{ label: 'Open link', href: item.body?.url, tone: 'primary' }] };
    if (text) return { ...presentation, body: item.body?.text ?? '' };
    const view = (sharing.source_references ?? []).find(row => row.kind === item.kind)?.view;
    if (view) return { ...presentation, items: details, actions: [{ label: view.label,
      href: withCode(`${prefix}/${view.path}${view.entry_path}`, accessCode), tone: 'primary' }] };

    // A file of words reads as a page: its words under its title, then the file itself to open or keep.
    if (file && words) return { ...presentation,
      markdown: `${withoutRepeatedTitle(words.text, itemTitle)}${words.whole ? '' : `\n\n*${sharing.reading.more}*`}`,
      ...(words.reading === 'plain' ? { markdown_breaks: true } : {}),
      actions: [{ label: 'Open file', href: filePath, tone: 'quiet' }, { label: 'Download', href: downloadPath, tone: 'quiet' }] };
    return { ...presentation,
      ...(file ? { ...(playable || shownType.startsWith('image/') ? { media: { src: hasPreview ? previewPath : filePath, type: shownType, label: itemTitle, ...(playable ? { player: true, transcript: transcriptPath,
        ...(item.body?.poster_identity && item.body?.poster_media_type?.startsWith('image/') ? { poster: posterPath, ...(focused || index === 0 ? { poster_loading: 'eager' } : {}) } : {}) } : {}) } } : {}),
        actions: [{ label: hasPreview ? 'Open original' : 'Open file', href: filePath, tone: 'quiet' }, { label: hasPreview ? 'Download original' : 'Download', href: downloadPath, tone: 'primary' }] } : { items: details }) };
  };
  const cardFor = (item, index) => {
    const absolute = window.offset + index;
    const file = item.kind === 'file';
    const type = file ? mediaTypeFor(item.body?.media_type, item.body?.name ?? item.title) : '';
    const image = type.startsWith('image/');
    const video = type.startsWith('video/') || item.body?.preview_media_type?.startsWith('video/');
    const audio = type.startsWith('audio/');
    const label = item.kind === 'withdrawn' ? 'Unavailable' : file ? video ? 'Video' : image ? 'Image' : audio ? 'Audio' : 'File'
      : item.kind === 'workflow' ? 'Workflow' : item.kind === 'link' ? 'Link' : item.kind === 'text' ? 'Note' : 'Shared item';
    const glyph = item.kind === 'withdrawn' ? '—' : video ? '▶' : image ? '▧' : audio ? '♫' : file ? '▤' : item.kind === 'workflow' ? '✣' : item.kind === 'link' ? '↗' : item.kind === 'text' ? '¶' : '·';
    const prefix = sharePath(code, `/items/${absolute}`);
    const poster = file && video && item.body?.poster_identity && item.body?.poster_media_type?.startsWith('image/')
      ? withCode(`${prefix}/poster`, accessCode) : null;
    const imageCover = file && image ? withCode(`${prefix}/cover`, accessCode) : null;
    const destination = item.kind === 'link' ? linkDestination(item.body?.url) : '';
    const summary = cardDescription(item, destination);
    // Use already shared words as the cover when a record carries prose. The collection overview never reads file
    // bytes just to make a tile; a file without a saved text preview keeps its visual fallback.
    const coverText = !file && item.kind !== 'link' && item.kind !== 'withdrawn' && typeof summary === 'string'
      ? excerpt(summary.replace(/\s+/g, ' ').trim(), 240) : '';
    const heading = item.kind === 'link' && (!item.title || item.title === item.body?.url)
      ? destination || 'Shared link' : item.title || (file ? 'Shared file' : 'Shared item');
    return { heading, ...(coverText ? {} : { body: excerpt(String(summary ?? '').trim(), 96) }),
      cover: { label, glyph, ...(coverText ? { text: coverText } : {}), ...(poster || imageCover ? { src: poster || imageCover, alt: '' } : {}) },
      ...(item.kind !== 'withdrawn' ? { href: withCode(collectionItemPath(code, absolute), accessCode) } : {}) };
  };
  const entries = collection ? window.items : [copy];
  const nearbyCards = focused ? window.items.map((item, index) => ({ item, index }))
    .filter(({ index }) => index !== localFocus)
    .sort((left, right) => Math.abs(left.index - localFocus) - Math.abs(right.index - localFocus) || left.index - right.index)
    .slice(0, 4).sort((left, right) => left.index - right.index)
    .map(({ item, index }) => cardFor(item, index)) : [];
  // A public overview shows its first bounded picture; an item link shows only
  // that item's picture. The image route checks the grant again for crawlers.
  const hasVideoPoster = item => item.kind === 'file' && typeof item.body?.poster_identity === 'string' && item.body.poster_media_type?.startsWith('image/')
    && (mediaTypeFor(item.body?.media_type, item.body?.name ?? item.title).startsWith('video/') || item.body.preview_media_type?.startsWith('video/'));
  const smallImage = item => item.kind === 'file' && mediaTypeFor(item.body?.media_type, item.body?.name ?? item.title).startsWith('image/')
    && Number.isSafeInteger(item.body?.byte_length) && item.body.byte_length >= 0 && item.body.byte_length <= MAX_ORIGINAL_COVER_BYTES;
  const hasLinkPicture = item => hasVideoPoster(item) || smallImage(item);
  const posterIndex = collection && access.public === true
    ? focused ? hasLinkPicture(entries[localFocus]) ? localFocus : -1 : entries.findIndex(hasLinkPicture)
    : -1;
  const previewImage = posterIndex >= 0 ? {
    url: `${origin}${sharePath(code, `/items/${window.offset + posterIndex}/${hasVideoPoster(entries[posterIndex]) ? 'poster' : 'cover'}`)}`,
    alt: `Preview of ${entries[posterIndex].title || 'shared file'}`,
  } : access.public === true && !collection && smallImage(copy) ? {
    url: `${origin}${sharePath(code, '/cover')}`, alt: `Preview of ${copy.title || 'shared file'}`,
  } : null;
  const hasPlayer = (focused ? [window.items[localFocus]] : collection ? [] : entries).some(item => {
    if (item.kind !== 'file') return false;
    const type = mediaTypeFor(item.body?.media_type, item.body?.name ?? item.title);
    return /^(audio|video)\//.test(item.body?.preview_media_type?.startsWith('video/') ? item.body.preview_media_type : type);
  });
  const configuration = copy.kind === 'record:configuration' && copy.body?.settings && typeof copy.body?.open_path === 'string';
  let configurationLink = configuration ? configurationOpenPath(copy.body.open_path, code, 'shared_configuration') : null;
  if (configurationLink && accessCode) {const link = new URL(configurationLink, origin); link.searchParams.set('access_code', accessCode); configurationLink = `${link.pathname}${link.search}`;}
  const acting = configurationLink ? [{emphasis: 'share-entry', heading: 'Use this configuration', heading_level: 2,
    body: 'Open these saved settings in Trillion. The accounts and records you see follow their own sharing permissions.',
    actions: [{label: 'Open configuration', href: configurationLink, tone: 'primary'}]}] : [];
  for (const ability of access.can) if (ABILITY_SECTIONS[ability]) acting.push(...await ABILITY_SECTIONS[ability]({ code, access, person, recipient, accessCode }));
  // Acting (signing, paying) names someone: a recipient who has not proved an email yet is asked for it once.
  const proving = access.acts_need_proof && !access.proven ? [proofForm(code, { named: false, sender: access.sender, heading: access.can.includes('edit') ? 'Edit this configuration' : 'Sign or pay' })] : [];
  const pagination = collection && !focused ? collectionPagination(code, window, accessCode) : null;
  const collectionDescription = !collection ? null : entries.length
    ? `Showing ${window.offset + 1}–${window.offset + entries.length} of ${window.count} items.`
    : window.count ? 'No items on this page.' : 'There are no items in this share yet.';
  return page({
    origin, code, look: access.look, title, listed: access.listed, previewImage, description: excerpt((words ? markdownText(withoutRepeatedTitle(words.text, title)).replace(/\s+/g, ' ').trim() : null)
      || ((focused ? entries[localFocus] : copy).preview?.fields ?? []).map(field => field.value).find(Boolean) || title, 300),
    path: focused ? collectionItemPath(code, focusIndex) : collection ? collectionPath(code, window.offset) : sharePath(code),
    // A collection can include an independently withdrawn item while its outer link stays open.
    headers: collection ? noCache : {},
    island: hasPlayer ? { bundle_url: '/workspace/share-view.js', stylesheet_url: '/workspace/share-view.css' } : null,
    sections: [
      ...(focused ? [{ emphasis: 'share-back', actions: [{ label: 'All shared items', href: withCode(collectionPath(code, window.offset), accessCode), tone: 'quiet' }] }]
        : collection ? [{ emphasis: 'share-heading', heading: title, heading_level: 1, body: collectionDescription, ...(pagination ? { pagination } : {}) }] : []),
      ...(focused ? [sectionFor(window.items[localFocus], localFocus)]
        : collection ? [{ emphasis: 'share-collection', cards: entries.map(cardFor), ...(pagination ? { pagination } : {}) }]
          : entries.map(sectionFor)),
      ...(nearbyCards.length ? [{ emphasis: 'share-collection', heading: 'More in this link', heading_level: 2, cards: nearbyCards }] : []),
      ...acting,
      ...proving,
    ],
  });
};

// /share/sitemap.xml and /share/llms.txt: the listed-link directory (src/record-sharing.mjs
// RECORD_SHARE_LISTED_INDEX). Large directories link to bounded parts; a part names a link or its list rows only
// after the current owner admits it. Search engines read the sitemap tree; answer engines read the llms links.
const xmlEscape = value => String(value).replace(/[<>&'"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]);
const crawlerLimit = sharing.addresses.sitemap_limit;
const crawlerPartSize = sharing.addresses.crawler_part_size;
const crawlerFullLimit = sharing.addresses.crawler_full_document_limit;
const crawlerConcurrency = sharing.addresses.crawler_owner_concurrency;
const crawlerOwnerMs = sharing.addresses.crawler_owner_timeout_ms;
const crawlerBuildMs = sharing.addresses.crawler_build_timeout_ms;
const crawlerRetrySeconds = sharing.addresses.crawler_retry_seconds;
const crawlerKeepSeconds = sharing.addresses.crawler_last_good_seconds;
const crawlerDocumentBytes = sharing.addresses.crawler_document_byte_limit;
const crawlerEncoder = new TextEncoder();
const crawlerBytes = line => crawlerEncoder.encode(line).byteLength + 1;
const crawlerContentType = path => path.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8';
const crawlerLink = (origin, path, part, value = null) => {
  const link = new URL(path, origin);
  link.searchParams.set('part', part);
  if (value !== null) link.searchParams.set(part === 'page' ? 'cursor' : 'name', value);
  return link.href;
};
const crawlerResponse = (body, path, headers, status = 200) => new Response(body, {
  status, headers: { ...headers, 'content-type': crawlerContentType(path) },
});
const sitemapIndex = links => ['<?xml version="1.0" encoding="UTF-8"?>', '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...links.map(link => '<sitemap><loc>' + xmlEscape(link.href) + '</loc></sitemap>'), '</sitemapindex>'].join('\n');
const llmsIndex = links => ['# ' + sharing.addresses.llms_heading, '', '> ' + sharing.addresses.llms_about, '',
  ...links.map(link => '- [' + link.label + '](' + link.href + ')')].join('\n');

// A saved link locates an installed grant owner; it grants no private file access.
async function currentShareOwner(resolve, { index, code, request, recipient = null, listed = false }) {
  if (typeof resolve !== 'function') throw Object.assign(new Error('The shared record owner is unavailable.'), { status: 503, code: 'share_owner_unavailable' });
  const owner = await resolve({ index, code, request, recipient, listed });
  if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) throw Object.assign(new Error('The shared record owner is unavailable.'), { status: 503, code: 'share_owner_unavailable' });
  return owner;
}

// One owner that is slow or refusing must not hold a crawler: each read has its own deadline and the whole round has
// another. The answer for a name is a share, null (the owner says it is not listed), or absent (it was not answered).
const withinMs = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Object.assign(new Error('The shared record owner did not answer in time.'), { status: 503, code: 'share_owner_timeout' })), ms);
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

async function askListedOwners(names, { kv, request, shareOwnerFor }) {
  const deadline = Date.now() + crawlerBuildMs;
  const answers = new Map();
  // An owner (person_ref) that missed its deadline or refused is not asked again this round: its other links would each wait
  // the same deadline and use up the build's time before any other owner is reached. They keep their last-known entries.
  const sick = new Set();
  let failure = null;
  for (let start = 0; start < names.length; start += crawlerConcurrency) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await Promise.all(names.slice(start, start + crawlerConcurrency).map(async name => {
      let person = null;
      try {
        answers.set(name, await withinMs((async () => {
          const index = await kv.get(RECORD_SHARE_LINK_INDEX + name, 'json');
          if (!index?.person_ref) return null;
          person = index.person_ref;
          if (sick.has(person)) throw Object.assign(new Error('This owner did not answer earlier in this round.'), { status: 503, code: 'share_owner_skipped', skipped: true });
          const owner = await currentShareOwner(shareOwnerFor, { index, code: name, request, listed: true });
          return (await owner.listedShare(name)) ?? null;
        })(), Math.min(crawlerOwnerMs, left)));
      } catch (error) {
        failure ??= error;
        if (error?.skipped) return;
        // Asked at most once per owner and round. The one line that says why a listed link's owner could not answer (it is
        // otherwise dropped from the document silently): the error's name, status, code and first line only, never values.
        if (person !== null) sick.add(person);
        console.warn('listed share owner unavailable', { name: String(error?.name ?? '').slice(0, 60), status: error?.status ?? null, code: error?.code ?? null,
          message: String(error?.message ?? error).split('\n')[0].slice(0, 200), link: name });
      }
    }));
  }
  return { answers, failure };
}

function listedBody(shares, { origin, path, headers, oneShare = false }) {
  const xml = path.endsWith('.xml');
  const links = [];
  const lines = xml
    ? ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    : ['# ' + sharing.addresses.llms_heading, '', '> ' + sharing.addresses.llms_about, ''];
  let bytes = lines.reduce((sum, line) => sum + crawlerBytes(line), 0);
  let overflow = false;
  const add = line => { lines.push(line); bytes += crawlerBytes(line); };
  const tooLarge = () => !oneShare && (bytes > crawlerDocumentBytes || xml && lines.length - 2 > crawlerLimit);
  for (const share of shares) {
    links.push({ href: crawlerLink(origin, path, 'share', share.name), label: share.title ?? share.name });
    if (overflow) continue;
    const listedRows = listRows(share.copy) ?? [];
    const presentation = share.copy.body?.public_page?.layout === 'comparison' ? share.copy.body.public_page : null;
    const rows = presentation ? comparisonRows(presentation, listedRows) : listedRows;
    if (xml) {
      if (!oneShare && lines.length + rows.length - 1 > crawlerLimit) { overflow = true; continue; }
      const addEntry = (loc, lastmod) => {
        add('<url><loc>' + xmlEscape(loc) + '</loc>' + (lastmod ? '<lastmod>' + xmlEscape(lastmod) + '</lastmod>' : '') + '</url>');
        if (tooLarge()) overflow = true;
      };
      addEntry(origin + sharePath(share.name), share.changed);
      for (const row of rows) {
        if (overflow) break;
        addEntry(origin + sharePath(share.name, '/' + row.address), row.changed ?? share.changed);
      }
    } else {
      add('## [' + (share.title ?? share.name) + '](' + origin + sharePath(share.name) + ')');
      add('');
      if (share.copy.body?.about) { add(share.copy.body.about); add(''); }
      if (tooLarge()) overflow = true;
      for (const row of rows) {
        if (overflow) break;
        const summary = rowSummary(share.copy, row);
        add('- [' + (row.title ?? row.address) + '](' + origin + sharePath(share.name, '/' + row.address) + ')' + (summary ? ': ' + summary : ''));
        if (tooLarge()) overflow = true;
      }
      if (rows.length && !overflow) add('');
    }
    if (tooLarge()) overflow = true;
  }
  if (overflow) return crawlerResponse(xml ? sitemapIndex(links) : llmsIndex(links), path, headers);
  if (xml) add('</urlset>');
  return crawlerResponse(lines.join('\n'), path, headers);
}

// What a crawler gets when no owner answered and nothing is kept: a valid empty document it should fetch again. The
// refusal is typed (busy, retryable, when to ask again) and the route turns it into this document (crawlerRefusal).
const crawlerRetryResponse = path => crawlerResponse(
  path.endsWith('.xml') ? '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>' : '# ' + sharing.addresses.llms_heading + '\n',
  path, { ...noCache, 'retry-after': String(crawlerRetrySeconds) }, 503);
const listedUnavailable = failure => Object.assign(new Error('The listed share documents are unavailable: ' + (failure?.message ?? 'no owner answered'), { cause: failure }),
  { status: 503, failure_code: 'service-busy', not_begun: true, retry_after_ms: crawlerRetrySeconds * 1000, crawler_refusal: true });
/** The route's answer to a refusal from the listed documents (valid empty document, 503, Retry-After), or null for any other failure. */
export const crawlerRefusal = (error, path) => error?.crawler_refusal === true ? crawlerRetryResponse(path) : null;

// What each listed name last said, kept in the edge cache with when it was asked: { built, attempted, complete, shares:
// { name: { at, share } } } (share is null when its owner said it is not listed). The names themselves always come
// from the listed index in KV, so a link that was revoked leaves the document on the next read, inside the fresh window
// too. A name whose owner cannot answer keeps its last answer for at most crawler_last_good_seconds; only an owner
// that answers "not listed" (or a name gone from the index) removes it.
const documentKey = url => crawlerDocumentKey(url.pathname, url.search);

async function readKept(cache, key) {
  const copy = cache ? await cache.match(key) : null;
  if (!copy) return null;
  try { return await copy.json(); } catch { return null; }
}

async function keepDocument(cache, key, kept) {
  await cache.put(key, new Response(JSON.stringify(kept), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=' + crawlerKeepSeconds } }));
}

async function renewListed(names, context, kept) {
  const now = Date.now();
  const { answers, failure } = await askListedOwners(names, context);
  const shares = {};
  let complete = true;
  for (const name of names) {
    if (answers.has(name)) { shares[name] = { at: now, share: answers.get(name) }; continue; }
    complete = false;
    const last = kept?.shares?.[name];
    if (last && now - last.at < crawlerKeepSeconds * 1000) shares[name] = last;
  }
  const renewed = { built: now, attempted: now, complete, shares };
  if (context.cache) await keepDocument(context.cache, documentKey(context.url), renewed);
  return { renewed, failure };
}

function listedFrom(names, kept, context, failure = null) {
  const shares = names.map(name => kept.shares[name]?.share).filter(Boolean);
  if (!shares.length && !kept.complete && names.length) throw listedUnavailable(failure);
  const response = listedBody(shares, context);
  if (kept.complete) return response;
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'public, max-age=' + crawlerRetrySeconds);
  headers.set('retry-after', String(crawlerRetrySeconds));
  return new Response(response.body, { status: response.status, headers });
}

async function cachedListedBody(names, context) {
  const { cache, ctx } = context;
  const now = Date.now();
  let kept = await readKept(cache, documentKey(context.url));
  // A name no longer in the listed index (revoked, unlisted, erased) takes its kept words with it on the next read.
  if (kept && Object.keys(kept.shares).some(name => !names.includes(name))) {
    kept = { ...kept, shares: Object.fromEntries(Object.entries(kept.shares).filter(([name]) => names.includes(name))) };
    await keepDocument(cache, documentKey(context.url), kept);
  }
  const covered = kept && names.every(name => Object.hasOwn(kept.shares, name));
  const lately = kept && now - kept.attempted < crawlerRetrySeconds * 1000;
  const fresh = covered && now - kept.built < (kept.complete ? sharing.addresses.fresh_seconds : crawlerRetrySeconds) * 1000;
  let answer = kept;
  let failure = null;
  if (!fresh && !lately) {
    if (covered && typeof ctx?.waitUntil === 'function') {
      await keepDocument(cache, documentKey(context.url), { ...kept, attempted: now });
      ctx.waitUntil(renewListed(names, context, kept).catch(() => {}));
    } else ({ renewed: answer, failure } = await renewListed(names, context, kept));
  }
  return listedFrom(names, answer, context, failure);
}

async function listedDocument(request, { kv, origin, url, shareOwnerFor, ctx, cache }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const headers = { 'cache-control': 'public, max-age=' + sharing.addresses.fresh_seconds };
  const part = url.searchParams.get('part');
  if (part && part !== 'page' && part !== 'share') return crawlerResponse('No such document.', url.pathname, noCache, 404);
  const name = url.searchParams.get('name');
  if (part === 'share' && (!name || !new RegExp(sharing.addresses.pattern).test(name))) return crawlerResponse('No such document.', url.pathname, noCache, 404);
  if (request.method === 'HEAD' && part !== 'share') return crawlerResponse(null, url.pathname, headers);
  if (part === 'share') {
    // One link's document is asked of its own owner on every read: a revoked or unlisted link never outlives its grant.
    const { answers } = await askListedOwners([name], { kv, request, shareOwnerFor });
    const share = answers.get(name);
    if (share === undefined) return crawlerRetryResponse(url.pathname);
    if (!share) return crawlerResponse(request.method === 'HEAD' ? null : 'No such document.', url.pathname, noCache, 404);
    return request.method === 'HEAD' ? crawlerResponse(null, url.pathname, headers) : listedBody([share], { origin, path: url.pathname, headers, oneShare: true });
  }
  const cursor = part === 'page' ? url.searchParams.get('cursor') ?? undefined : undefined;
  if (cursor && cursor.length > 4096) return crawlerResponse('No such document.', url.pathname, noCache, 404);
  let found = await kv.list({ prefix: RECORD_SHARE_LISTED_INDEX, cursor, limit: crawlerPartSize });
  const namesOf = page => page.keys.map(key => key.name.slice(RECORD_SHARE_LISTED_INDEX.length));
  if (part === 'page' || found.list_complete && found.keys.length <= crawlerFullLimit) {
    return cachedListedBody(namesOf(found), { kv, origin, url, path: url.pathname, headers, request, shareOwnerFor, ctx, cache });
  }
  const links = [];
  let position = 0;
  let before;
  while (position < crawlerLimit) {
    const names = namesOf(found).slice(0, crawlerLimit - position);
    if (names.length) links.push({ href: crawlerLink(origin, url.pathname, 'page', before), label: 'Shares ' + (position + 1) + '–' + (position + names.length) });
    position += names.length;
    if (found.list_complete || position >= crawlerLimit) break;
    if (!found.cursor || found.cursor === before || !names.length) throw new Error('Listed share cursor did not advance.');
    before = found.cursor;
    found = await kv.list({ prefix: RECORD_SHARE_LISTED_INDEX, cursor: before, limit: Math.min(crawlerPartSize, crawlerLimit - position) });
  }
  return crawlerResponse(url.pathname.endsWith('.xml') ? sitemapIndex(links) : llmsIndex(links), url.pathname, headers);
}

function boundedPreviewRange(header) {
  const open = /^bytes=(\d+)-$/.exec(header?.trim() ?? '');
  if (!open) return header;
  const start = Number(open[1]);
  if (!Number.isSafeInteger(start) || start > Number.MAX_SAFE_INTEGER - HOT_PREFIX_BYTES) return header;
  return `bytes=${start}-${start + HOT_PREFIX_BYTES - 1}`;
}

async function sharedBytes(request, _env, access, part = 'file', measure = () => {}, ctx = null, owner = null, rangeHeader = request.headers.get('range'), selection = {}) {
  const cover = sharedCoverResponse(request, access, part);
  if (cover) return cover;
  const headers = new Headers(request.headers);
  if (rangeHeader === null) headers.delete('range'); else if (rangeHeader !== undefined) headers.set('range', rangeHeader);
  const byteRequest = new Request(request, { headers });
  const publicResponse = async response => {
    if (request.signal.aborted) {
      await response.body?.cancel(request.signal.reason).catch(() => {});
      request.signal.throwIfAborted();
    }
    const publicHeaders = new Headers({ ...noCache, ...sharedFileCors, ...noShareReferrer, 'x-content-type-options': 'nosniff' });
    for (const name of ['content-range', 'content-length', 'content-type', 'accept-ranges', 'retry-after'])
      if (response.headers.has(name)) publicHeaders.set(name, response.headers.get(name));
    const expected = response.headers.get('x-trillion-expected-bytes') ?? response.headers.get('content-length');
    if (/^(0|[1-9]\d{0,15})$/.test(expected ?? '') && Number.isSafeInteger(Number(expected)))
      publicHeaders.set('x-trillion-expected-bytes', expected);
    if (response.ok) publicHeaders.set('content-disposition', `${part === 'file' && new URL(request.url).searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(wordsFor(access.copy?.body?.name ?? access.copy?.title))}`);
    // A native reader may be waiting inside an origin or grant RPC when the
    // recipient leaves. Cancel its supplied body immediately, including a
    // pending read; a later chunk must not be needed to notice the request.
    const body = response.body?.pipeThrough(new TransformStream(), { signal: request.signal }) ?? null;
    return new Response(body, { status: response.status, statusText: response.statusText, headers: publicHeaders });
  };
  if (typeof owner?.readSharedBytes === 'function') return publicResponse(await owner.readSharedBytes(byteRequest,
    { ...access, _native_selection: { ...(access?._native_selection ?? {}), ...selection } }, part));
  // A trusted installed grant owner rechecks the selected file/preview/poster,
  // binds the actual Namespace carrier and owns ongoing stream revocation.
  if (typeof owner?.withSharedNamespace !== 'function') throw Object.assign(new Error('The shared file owner is unavailable.'), { status: 503, code: 'share_namespace_unavailable' });
  return owner.withSharedNamespace({ request: byteRequest, access, part, range_header: rangeHeader,
    ...(selection.item_index === undefined ? {} : { item_index: selection.item_index }),
    ...(selection.file_identity ? { file_identity: selection.file_identity } : {}) }, async supplied => {
    // The installed native supplier owns streaming and per-chunk grant checks;
    // its response is already opened at the independently addressed Namespace.
    if (supplied?.response instanceof Response) {
      return publicResponse(supplied.response);
    }
    if (!supplied?.env || !supplied?.namespace || !supplied?.access) throw Object.assign(new Error('The shared file owner is unavailable.'), { status: 503, code: 'share_namespace_unavailable' });
    return sharedNamespaceBytes(request, supplied.env, supplied.access, part, measure, ctx, supplied.namespace, rangeHeader);
  });
}

function sharedCoverResponse(request, access, part) {
  if (part !== 'cover') return null;
  const { copy, row } = access ?? {};
  if (copy?.kind !== 'file' || !row || row.growing || row.identity !== copy.body?.identity) return null;
  const size = Number(row.byte_length);
  if (!Number.isSafeInteger(size) || size < 0) return null;
  const type = rasterImageTypeFor(row.media_type, row.names?.[0] ?? copy.title);
  if (type && size <= MAX_ORIGINAL_COVER_BYTES) return null;
  // A gallery cover must never open a large original. The current grant owner
  // can supply its bounded saved picture; otherwise the visible kind remains.
  const saved = savedImageCover({ poster: access.cover_poster });
  const bytes = saved?.bytes ?? TRANSPARENT_COVER;
  return new Response(request.method === 'HEAD' ? null : bytes, { headers: { ...noCache, ...sharedFileCors,
    'content-type': saved?.type ?? 'image/png', 'content-length': String(bytes.length), 'x-content-type-options': 'nosniff',
    'x-cover-source': saved ? 'saved-preview' : 'kind-glyph' } });
}

async function sharedNamespaceBytes(request, env, access, part = 'file', measure = () => {}, ctx = null, person = null, rangeHeader = request.headers.get('range')) {
  const { copy, row, owner_user_id: ownerId } = access;
  const identity = part === 'preview' ? copy.body?.preview_identity : part === 'poster' ? copy.body?.poster_identity : copy.body?.identity;
  if (copy.kind !== 'file' || typeof identity !== 'string') return withSharedFileCors(gone('This link does not contain a file.'));
  if (!row || row.growing || row.identity !== identity || (part === 'preview' && !/^(video|image)\//.test(row.media_type ?? ''))
    || (part === 'poster' && !row.media_type?.startsWith('image/'))) return withSharedFileCors(gone('This file is not available right now.'));
  if (!ownerId) return withSharedFileCors(gone('This file is not available right now.'));
  const size = Number(row.byte_length);
  if (!Number.isSafeInteger(size) || size < 0) return withSharedFileCors(gone('This file is not available right now.'));
  if (part === 'cover') {
    // This address is only a gallery picture. A large original is never read
    // just to fill a card. Use the compact preview that Files and Media have
    // already kept, or leave the card's visible kind glyph underneath.
    const type = rasterImageTypeFor(row.media_type, row.names?.[0] ?? copy.title);
    const saved = size > MAX_ORIGINAL_COVER_BYTES || !type ? savedImageCover({ poster: access.cover_poster }) : null;
    if (saved) return new Response(request.method === 'HEAD' ? null : saved.bytes, { headers: { ...noCache, ...sharedFileCors,
      'content-type': saved.type, 'content-length': String(saved.bytes.length), 'x-content-type-options': 'nosniff', 'x-cover-source': 'saved-preview' } });
    if (!type || size > MAX_ORIGINAL_COVER_BYTES) {
      return new Response(request.method === 'HEAD' ? null : TRANSPARENT_COVER, { headers: { ...noCache, ...sharedFileCors,
        'content-type': 'image/png', 'content-length': String(TRANSPARENT_COVER.length), 'x-content-type-options': 'nosniff', 'x-cover-source': 'kind-glyph' } });
    }
  }
  const range = parseByteRange(rangeHeader, size);
  if (range?.invalid) return new Response(null, { status: 416, headers: { ...noCache, ...sharedFileCors, 'content-range': `bytes */${size}` } });
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const url = new URL(request.url);
  const headers = {
    ...noCache, ...sharedFileCors, 'content-type': mediaTypeFor(row.media_type, row.names?.[0] ?? copy.title), 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
    'content-length': String(size ? end - start + 1 : 0),
    'content-disposition': `${part === 'file' && url.searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(wordsFor(row.names?.[0] ?? copy.title))}`,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
  };
  if (request.method === 'HEAD' && !range?.ranges) return new Response(null, { status: range ? 206 : 200, headers });
  if (!size) return new Response(null, { status: 200, headers });
  const started = performance.now();
  const grantedAttached = Array.isArray(access.attached_origin_ids)
    ? scopedOriginForRead(env, ownerId, access.attached_origin_ids, access.attached_origins)
    : access.attached_origins ?? null;
  const scopedOrigins = typeof grantedAttached === 'function' ? grantedAttached : null;
  const copies = request.method === 'HEAD' || row.growing ? null : lazyChunkCopiesFor(env, ownerId, request, ctx, scopedOrigins);
  const open = ({ start, end }, index = 0) => namespaceEdgeRange(request, ownerId, row, start, end,
    (from = start, to = end) => rangeStream(env, ownerId, row, from, to, measure,
      index === 0 && from === start ? access.first_spans ?? null : null, grantedAttached, copies), {
      waitUntil: ctx?.waitUntil?.bind(ctx), observe: measure, firstSpan: index === 0 ? access.first_spans?.[0] ?? null : null,
      rememberPrefix: index === 0 && person && access.first_spans?.[0]
        ? digest => person.namespaceRememberPrefix(row.identity, digest, access.first_spans[0].chunk) : null,
    });
  if (range?.ranges) {
    const multipart = multipartByteStream(range.ranges, size, headers['content-type'], open,
      { signal: request.signal, headersOnly: request.method === 'HEAD' });
    delete headers['content-range'];
    headers['content-type'] = multipart.contentType;
    headers['content-length'] = multipart.contentLength;
    if (request.method === 'HEAD') return new Response(null, { status: 206, headers });
    await multipart.stream.firstBytes;
    measure('first_byte', started);
    return new Response(multipart.stream, { status: 206, headers });
  }
  const edge = await open({ start, end });
  const stream = edge.stream;
  await (edge.firstBytes ?? stream.firstBytes);
  measure('first_byte', started);
  return new Response(stream, { status: range ? 206 : 200, headers });
}

// Kept words are requested after the player appears, through this same grant. The result's aliases and owner records
// stay private; only the transcript itself is shared with the recording.
async function sharedTranscript(person, copy, row, recipient = {}) {
  const identity = copy.kind === 'file' ? copy.body?.identity : null;
  if (typeof identity !== 'string' || row?.identity !== identity) return gone('This file is not available right now.');
  if (typeof person?.readSharedTranscript !== 'function') throw Object.assign(new Error('The shared recording owner is unavailable.'), { status: 503, code: 'share_transcript_unavailable' });
  const answer = await person.readSharedTranscript({ identity, ...(recipient.item_index === undefined ? {} : { item_index: recipient.item_index }), ...(recipient.file_identity ? { file_identity: recipient.file_identity } : {}) });
  if (answer?.busy) return Response.json({ error: 'The words are busy. Try again in a second.' }, { status: 429, headers: { ...noCache, 'retry-after': String(answer.retry_after_seconds ?? 1) } });
  const kept = answer;
  return Response.json({ text: typeof kept?.text === 'string' ? kept.text : '', segments: Array.isArray(kept?.segments) ? kept.segments : [] }, { headers: { ...noCache, 'x-content-type-options': 'nosniff' } });
}

// What a recipient the link does not admit yet sees: the way in they can take (record-sharing.json proof).
const refusedPage = ({ origin, code, access, accessCode }) => {
  const sectionsFor = {
    email: () => [proofForm(code, { named: true, sender: access.sender })],
    code: () => [{ emphasis: 'share-featured', heading: fill(sharing.proof.heading, { sender: access.sender }), heading_level: 1, body: accessCode ? 'That code is not right.' : 'Type the code you were given with this link.',
      choices: { href: sharePath(code, '/prove'), values: {}, fields: [{ name: 'access_code', label: sharing.proof.code_label, kind: 'text', required: true }], submit: { label: sharing.proof.check, tone: 'primary' } } }],
    phone: () => [{ emphasis: 'share-featured', heading: fill(sharing.proof.heading, { sender: access.sender }), heading_level: 1, body: sharing.proof.phone_needs_sign_in,
      actions: [{ label: 'Sign in', href: `/account?next=${encodeURIComponent(sharePath(code))}`, tone: 'primary' }] }],
    account: () => [{ emphasis: 'share-featured', heading: fill(sharing.proof.heading, { sender: access.sender }), heading_level: 1, body: 'This was shared with one Trillion account. Sign in to open it.',
      actions: [{ label: 'Sign in', href: `/account?next=${encodeURIComponent(sharePath(code))}`, tone: 'primary' }] }],
  };
  const sections = access.closed ? [{ emphasis: 'share-featured', heading: 'This share link is not open right now.', heading_level: 1 }] : (sectionsFor[access.needs]?.() ?? []);
  return page({ origin, code, look: access.look, title: sections[0]?.heading ?? 'Shared item', sections, status: access.closed ? 403 : 200 });
};
const paidCheckFailed = error => { console.error('share payment check failed:', String(error?.message ?? error)); return null; };
const formOf = async request => {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(await request.text()));
  return request.json().catch(() => ({}));
};
const back = (origin, code, headers = {}, accessCode = null) => new Response(null, { status: 303, headers: { location: `${origin}${withCode(sharePath(code), accessCode)}`, ...noCache, ...headers } });

// The account a proved recipient is given things as: their own, else the one kept for their email.
// Booking is a DATA description rendered by the same shared page controls.
async function availabilityShare({request,origin,code,person,recipient,accessCode}) {
  const access=await person.shareAccess(code,recipient);
  if(!access.admitted)return refusedPage({origin,code,access});
  if(!(access.can??[]).includes('book'))throw new SharingError('This share does not allow booking.');
  const url=new URL(request.url),json=(request.headers.get('accept')??'').includes('application/json')||(request.headers.get('content-type')??'').includes('application/json');
  if(request.method==='POST') {
    const form=await formOf(request),action=form.action??'reserve';
    if(!['reserve','move','cancel','reconcile'].includes(action))throw new SharingError('Choose a booking action.');
    const input=Object.fromEntries(['reservation_id','operation_id','request_key','name'].filter(key=>form[key]!==undefined).map(key=>[key,form[key]]));
    if(form.start_ms!==undefined)input.start_ms=Number(form.start_ms);
    const result=await person.shareAvailability(code,recipient,{action,input});
    if(json)return Response.json(result,{headers:noCache});
    const reservation=result.reservation?.id??input.reservation_id;
    return new Response(null,{status:303,headers:{location:`${origin}${withCode(sharePath(code,'/book'),accessCode)}${accessCode?'&':'?'}reservation=${encodeURIComponent(reservation??'')}`,...noCache}});
  }
  const reservationId=url.searchParams.get('reservation');
  if(reservationId){
    const result=await person.shareAvailability(code,recipient,{action:'reservation-read',input:{reservation_id:reservationId}});
    if(json)return Response.json(result,{headers:noCache});
    const reservation=result.reservation??result;
    const pending=['pending','unknown'].includes(result.operation?.state);
    const label=pending?'Your meeting change is being checked':({booked:'Your meeting is booked',pending:'Your booking is being checked',requested:'Your request is waiting for the host',cancelled:'Your meeting is cancelled',failed:'Your booking could not be completed'}[reservation.state]??'Your booking');
    const path=withCode(sharePath(code,'/book'),accessCode);
    const sections=[{emphasis:'share-featured',heading:label,heading_level:1,body:reservation.start_ms?new Date(reservation.start_ms).toLocaleString('en-US',{dateStyle:'full',timeStyle:'short',timeZone:result.timezone??'UTC'})+' '+(result.timezone??'UTC'):null,
      actions:[...(!pending&&result.may_move?[{label:'Choose another time',href:`${path}${accessCode?'&':'?'}move=${encodeURIComponent(reservationId)}`,tone:'quiet'}]:[]),
        ...(!pending&&result.may_cancel?[{label:'Cancel meeting',href:path,tone:'quiet',post:{action:'cancel',reservation_id:reservationId,request_key:crypto.randomUUID()}}]:[]),
      ...(pending?[{label:'Check booking',href:path,tone:'primary',post:{action:'reconcile',operation_id:result.operation.id}}]:[])]}];
    return page({origin,code,look:access.look,title:label,sections,headers:noCache,path:sharePath(code,'/book')});
  }
  const offered=await person.shareAvailability(code,recipient,{action:'read',input:{...(url.searchParams.has('from')?{from:url.searchParams.get('from'),to:url.searchParams.get('from')}:{})}});
  if(json)return Response.json(offered,{headers:noCache});
  const sections=availabilityPageSections({code,offered,accessCode,verified:Boolean(recipient.verified_email),requestKey:crypto.randomUUID(),move:url.searchParams.get('move'),afterMs:url.searchParams.has('after_ms')?Number(url.searchParams.get('after_ms')):null});
  return page({origin,code,look:access.look,title:offered.link.title,sections,headers:noCache,path:sharePath(code,'/book')});
}

const buyerOf = async (recipient, buyerFor) => recipient.buyer_ref ?? (recipient.verified_email && buyerFor ? await buyerFor(recipient.verified_email) : null);

const sharedUploadMethods = { bytes: 'PUT', chunk: 'PUT', spans: 'POST', finish: 'POST', cancel: 'POST', demands: 'GET' };
async function continueSharedUpload(request, person) {
  if (typeof person.stepSharedUpload !== 'function') throw Object.assign(new Error('The shared upload owner is unavailable.'), { status: 503 });
  const url = new URL(request.url), action = url.searchParams.get('action') ?? 'bytes';
  const method = Object.hasOwn(sharedUploadMethods, action) ? sharedUploadMethods[action] : null;
  if (!method) return Response.json({ error: 'Unknown upload action.' }, { status: 400, headers: noCache });
  if (request.method !== method) return Response.json({ error: `Use ${method} for this upload action.` }, { status: 405, headers: { ...noCache, allow: method } });
  const input = action === 'chunk' ? { chunk: request.headers.get('x-content-identity') }
    : action === 'bytes' ? { ...(url.searchParams.has('offset') ? { offset: Number(url.searchParams.get('offset')) } : {}) }
      : method === 'GET' ? {} : await request.json().catch(() => ({}));
  let bytes;
  if (action === 'chunk' || action === 'bytes') {
    const limit = 1048576, reader = request.body?.getReader(), chunks = [];
    let size = 0;
    if (!reader) throw new SharingError('Send the upload bytes.');
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return Response.json({ error: 'Send at most 1 MiB per chunk.' }, { status: 413, headers: noCache });
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  }
  // The factory owns the recipient and the saved upload owns its original
  // growing file. Body fields can never replace the route's upload or action.
  return Response.json(await person.stepSharedUpload({ ...input, upload: url.searchParams.get('upload'), action }, bytes), { headers: noCache });
}

// A recipient acting through the link (POST): proving an email, opening with a code, signing, paying.
// A sealed link's copy, or a writer's replacement (src/record-sharing.mjs sealedShareRequest): the store checks the
// grant and the role; nothing here can open the copy. A replacement body is bounded before it is parsed.
const SEALED_BODY_LONGEST = 400_000;
async function sealedShare(request, person, code, recipient) {
  let input = null;
  if (request.method === 'POST') {
    const text = await request.text();
    try { input = text.length <= SEALED_BODY_LONGEST ? JSON.parse(text) : null; } catch { input = null; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return Response.json({ error: 'Send JSON { sealed_copy, expected_content_id }.' }, { status: 400, headers: noCache });
  }
  const answer = await person.sealedShareRequest(code, recipient, input);
  if (answer?.refused) return Response.json({ error: answer.refused.error, refused: answer.refused }, { status: answer.refused.status, headers: noCache });
  return request.method === 'HEAD' ? new Response(null, { headers: noCache }) : Response.json(answer, { headers: noCache });
}

async function act({ request, env, origin, code, part, person, recipient, buyerFor, accessCode = null, files = null }) {
  // Computers start with JSON and continue their bound upload with bytes or a
  // typed action. Foreign browser origins remain refused on every action.
  const continuingUpload = part === 'add' && new URL(request.url).searchParams.has('upload');
  const fromComputer = (part === 'add' || part === 'book' || part === 'sealed') && !request.headers.get('origin')
    && (continuingUpload || (request.headers.get('content-type') ?? '').includes('application/json'));
  if (request.headers.get('origin') !== origin && !fromComputer) return new Response('Not allowed.', { status: 403, headers: noCache });
  if (part === 'book') return availabilityShare({request,origin,code,person,recipient,accessCode});
  if (part === 'sealed') return sealedShare(request, person, code, recipient);
  if (continuingUpload) return continueSharedUpload(request, person);
  if (part === 'add') return addFiles({ request, env, origin, code, person, recipient, accessCode, fromComputer, files });
  const form = await formOf(request);
  const access = await person.shareAccess(code, recipient);
  const said = (heading, body) => page({ origin, code, look: access.look, title: heading, sections: [{ emphasis: 'share-featured', heading, heading_level: 1, body, actions: [{ label: 'Back', href: sharePath(code), tone: 'primary' }] }], status: 400 });
  if (part === 'prove') {
    if (typeof form.access_code === 'string' && form.access_code) return back(origin, code, {}, form.access_code);
    if (typeof form.code === 'string' && form.code) {
      const checked = await checkShareCode(env, { shareCode: code, email: form.email, code: form.code });
      if (checked.error) return page({ origin, code, look: access.look, title: sharing.proof.code_heading, sections: [codeForm(code, String(form.email ?? ''), checked.error)], status: 400 });
      return back(origin, code, { 'set-cookie': checked.cookie });
    }
    const sent = await sendShareCode(env, { shareCode: code, email: form.email, sender: access.sender,
      mayAdmit: async email => {
        if (typeof person.mayAdmitShareEmail !== 'function') throw Object.assign(new Error('The shared email proof owner is unavailable.'), { status: 503, code: 'share_email_proof_unavailable' });
        return (await person.mayAdmitShareEmail(code, { email })) === true;
      } });
    if (sent.error) return page({ origin, code, look: access.look, title: fill(sharing.proof.heading, { sender: access.sender }), sections: [proofForm(code, { named: access.needs === 'email', sender: access.sender, email: String(form.email ?? ''), error: sent.error })], status: 400 });
    return page({ origin, code, look: access.look, title: sharing.proof.code_heading, sections: [codeForm(code, sent.email)] });
  }
  if (!access.admitted) return refusedPage({ origin, code, access });
  try {
    if (part === 'sign') {
      const signer = access.delivers_on_sign ? await buyerOf(recipient, buyerFor) : null;
      await person.signShare(code, signer ? { ...recipient, buyer_ref: signer } : recipient, { name: form.name });
      return back(origin, code);
    }
    const buyer = await buyerOf(recipient, buyerFor);
    if (!buyer) return back(origin, code);
    // Paying a seller is money out of the buyer: the checkout is made only within the room the buyer's paid ceiling
    // leaves (src/negotiated-offers.mjs accept reads what its request commits), and that commitment is kept before the
    // buyer is sent to pay it (src/payment.mjs paidGate counts it).
    const started = await person.startSharePayment(code, { ...recipient, buyer_ref: buyer, paid_room_cents: await paidRoom(env, buyer) });
    await reservePaid(env, buyer, { ref: started.offer_id, amountCents: started.commitment_cents });
    return new Response(null, { status: 303, headers: { location: started.checkout_url, ...noCache } });
  } catch (error) {
    return said(part === 'sign' ? sharing.signing.heading : sharing.paying.submit, String(error?.message ?? error));
  }
}

// Files someone adds through a folder link (add_files). A page sends them as a multipart form, at most
// record-sharing.json adding.most_bytes at once, and each is kept under the sharer's account through the same checked
// upload every file takes. A computer or an AI sends JSON { name, byte_length, media_type } instead and is answered with
// the addresses to send that file's bytes to (send_bytes_to, or send_straight to the store), so a file of any size goes
// without passing through a page. Every send is checked against the link as it is now, and nothing replaces a file
// already in the folder.
async function addFiles({ request, env, origin, code, person, recipient, accessCode, fromComputer, files: roads = null }) {
  const keep = roads?.keep ?? keepStream, start = roads?.start ?? startUploadFor;
  const nativeUpload=typeof person.startSharedUpload==='function';
  const plainLook = { kind: 'trillion', name: sharing.look.trillion.name };
  const refused = (message, status = 400) => fromComputer
    ? Response.json({ error: message }, { status, headers: noCache })
    : page({ origin, code, look: plainLook, title: sharing.adding.heading, status, sections: [{ emphasis: 'share-featured', heading: sharing.adding.heading, heading_level: 1, body: message, actions: [{ label: 'Back', href: withCode(sharePath(code), accessCode), tone: 'primary' }] }] });
  try {
    if (fromComputer) {
      const input = await request.json().catch(() => null);
      const size = Number(input?.byte_length);
      if (!input || typeof input.name !== 'string' || !input.name.trim() || !Number.isSafeInteger(size) || size < 1) return refused('Send { name, byte_length } for the file, and media_type if you know it.');
      const target = await person.shareFolderForAdding(code, recipient, [input.name]);
      if (target.refused) return refused(target.refused, 404);
      const { started, name } = nativeUpload ? await (async()=>{const answer=await person.startSharedUpload({...input,name:input.name,byte_length:size});return {name:answer.name,started:Response.json({...answer,...(answer.state==='present'?{}:{send_bytes_to:`${origin}${withCode(sharePath(code,'/add'),accessCode)}${accessCode?'&':'?'}upload=${encodeURIComponent(answer.upload)}&action=bytes`,send_with:'Send the original file bytes with PUT in parts of at most 1 MiB. Set offset to the first byte of each part. The final part completes the file.'})})};})() : await person.withSharedNamespace({ request, target, operation: 'add-files' }, async supplied => ({
        started: await start(supplied.env, supplied.target.owner, origin, { name: supplied.target.names[0], byte_length: size, media_type: typeof input.media_type === 'string' ? input.media_type : null, app: 'Share link' }),
        name: supplied.target.names[0],
      }));
      const answer = await started.json();
      if (!started.ok) return Response.json({ error: answer.error ?? 'The file could not be started.' }, { status: started.status, headers: noCache });
      if(!nativeUpload)await person.noteFilesAddedThroughShare(code, 1).catch(() => null);
      return Response.json({ name, state: answer.state, byte_length: size,
        ...(answer.state === 'present' ? {} : { upload:answer.upload,max_chunk_bytes:answer.max_chunk_bytes,send_bytes_to: answer.send_bytes_to, send_bytes_until: answer.send_bytes_until, send_straight: answer.send_straight, send_with: answer.send_with }) }, { headers: noCache });
    }
    const declared = Number(request.headers.get('content-length'));
    const most = sharing.adding.most_bytes;
    const mostWords = `${Math.round(most / 1e6)} MB`;
    if (Number.isFinite(declared) && declared > most + 64 * 1024) return refused(fill(sharing.adding.too_big, { most: mostWords }), 413);
    const form = await request.formData().catch(() => null);
    const files = (form?.getAll('files') ?? []).filter(file => typeof file === 'object' && file && typeof file.stream === 'function' && file.size > 0);
    if (!files.length) return refused(sharing.adding.nothing);
    if (files.reduce((sum, file) => sum + file.size, 0) > most) return refused(fill(sharing.adding.too_big, { most: mostWords }), 413);
    const target = await person.shareFolderForAdding(code, recipient, files.map(file => file.name));
    if (target.refused) return refused(target.refused, 404);
    for (const [index, file] of files.entries()) {
      if(nativeUpload){await person.keepSharedUpload({name:file.name,size:file.size,media_type:file.type||null,stream:file.stream()});continue;}
      await person.withSharedNamespace({ request, target, operation: 'add-files', file_index: index }, supplied => keep(supplied.env, supplied.target.owner, { name: supplied.target.names[index], size: file.size, open: async () => file.stream(), media_type: file.type || null, app: 'Share link' }));
    }
    if(!nativeUpload)await person.noteFilesAddedThroughShare(code, files.length).catch(() => null);
    const said = fill(sharing.adding.added, { count: String(files.length), files: files.length === 1 ? 'file' : 'files', sender: target.sender });
    return page({ origin, code, look: target.look ?? plainLook, title: sharing.adding.heading, sections: [addFilesForm(code, accessCode, target.sender, said)] });
  } catch (error) {
    if (error instanceof SharingError) return refused(error.message, 404);
    console.error('share add failed:', String(error?.message ?? error).slice(0, 200));
    return refused('These files could not be kept right now. Try again in a minute.', 503);
  }
}

// What a link shares, as data (GET /share/<code>.json): for a list, its fields, the rows shown right now (each media
// value an identity) and every file those rows name with the address that serves it through this same link; for
// anything else, its title and preview. Open to any site or AI (CORS); a public link may be kept a few minutes.
function sharedData({ origin, code, access, copy, accessCode }) {
  const headers = { 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff',
    'cache-control': !access.admitted || copy?.kind === 'collection' ? 'private, no-store'
      : access.public ? `public, max-age=${sharing.addresses.fresh_seconds}` : 'private, no-store' };
  if (!access.admitted) return Response.json({ error: access.closed ? 'This share link is not open right now.' : 'This share link is for someone else, or needs its access code.' }, { status: 404, headers });
  const rows = listRows(copy);
  if (copy.kind === 'collection') {
    const window = collectionWindow(copy);
    const itemPath = index => sharePath(code, `/items/${index}`);
    return Response.json({
      kind: 'collection', title: copy.title ?? null, total_items: window.count, offset: window.offset, has_more: window.hasMore,
      items: window.items.map((item, localIndex) => {
        const index = window.offset + localIndex;
        const base = { index, kind: item.kind, title: item.title ?? null, preview: item.preview ?? null };
        if (item.kind !== 'file') return base;
        const file = withCode(`${itemPath(index)}/file`, accessCode);
        return { ...base, file_url: `${origin}${file}`, download_url: `${origin}${file}${file.includes('?') ? '&' : '?'}download=1`,
          ...(mediaTypeFor(item.body?.media_type, item.body?.name ?? item.title).startsWith('image/')
            ? { cover_url: `${origin}${withCode(`${itemPath(index)}/cover`, accessCode)}` } : {}),
          ...(item.body?.preview_identity ? { preview_url: `${origin}${withCode(`${itemPath(index)}/preview`, accessCode)}` } : {}),
          ...(item.body?.poster_identity ? { poster_url: `${origin}${withCode(`${itemPath(index)}/poster`, accessCode)}` } : {}),
        };
      }),
      ...(window.hasMore && window.items.length ? { next: `${origin}${withCode(collectionPath(code, window.offset + window.items.length, true), accessCode)}` } : {}),
      ...(window.offset ? { previous: `${origin}${withCode(collectionPath(code, Math.max(0, window.offset - COLLECTION_PAGE_SIZE), true), accessCode)}` } : {}),
    }, { headers });
  }
  if (copy.kind === 'record:configuration' && copy.body?.settings) {
    // A shared configuration is a definition only. Its page and JSON both open
    // through the grant alias, never a private owner record or selected data.
    const definition = {...copy.body, id: `shared-configuration:${code}`,
      ...(typeof copy.body.open_path === 'string' ? {open_path: configurationOpenPath(copy.body.open_path, code, 'shared_configuration')} : {})};
    return Response.json({kind: copy.kind, title: copy.title ?? null, configuration: definition, can: access.can,
      read_url: `${origin}/share/${code}.json`}, {headers: {...headers, 'cache-control': 'private, no-store'}});
  }
  if (!rows) return Response.json({ kind: copy.kind, title: copy.title ?? null, preview: copy.preview ?? null }, { headers });
  return Response.json({
    kind: copy.kind, title: copy.title ?? null, about: copy.body?.about ?? null, changed: latestDay(copy),
    fields: copy.body.fields,
    rows: rows.map(row => ({ id: row.id, title: row.title, address: row.address, url: `${origin}${withCode(sharePath(code, `/${row.address}`), accessCode)}`, values: row.values })),
    files: (copy.body.files ?? []).map(file => ({ ...file, url: `${origin}${withCode(sharePath(code, `/files/${file.identity}`), accessCode)}` })),
  }, { headers });
}

// The recipient as the route knows them (invariant 1): `session` is { relay, verified_email, buyer_ref } for a signed-in
// account, { verified_email, buyer_ref? } for an email this browser proved, or null; `buyerFor(email)` answers the
// account a proved email pays as, made the first time someone with no account pays, so what they bought waits for
// them under that email.
export async function answerRecordShare(request, { env, kv, origin, session = null, ctx = null, buyerFor = null, files = null, shareOwnerFor = nativeShareOwnerFor({ env }), documentCache = globalThis.caches?.default ?? null } = {}) {
  const url = new URL(request.url);
  if (url.pathname === '/share/sitemap.xml' || url.pathname === '/share/llms.txt') return listedDocument(request, { kv, origin, url, shareOwnerFor, ctx, cache: documentCache });
  const match = url.pathname.replace(/%3A/gi, ':').match(/^\/share\/([A-Za-z0-9_-]+)(?:(\.json)|\/items\/(\d+)\/(file|preview|poster|cover|transcript)|\/(file|preview|poster|cover|transcript|_sender|look|prove|sign|pay|add|book|sealed)|\/files\/((?:1f|12):[0-9a-f]{64})(?:\/(file|preview|poster|cover|transcript))?|\/([a-z0-9-]+)|\/view\/(.+)|\/items\/(\d+)\/view\/(.+))?$/);
  if (!match) return null;
  const asData = match[2] === '.json';
  const viewPath = match[9] ?? match[11] ?? null;
  const itemIndex = match[3] ?? match[10];
  const fileIdentity = match[6] ?? null;
  const rowAddress = match[8] ?? null;
  const code = match[1];
  const part = fileIdentity ? match[7] ?? 'file' : match[4] ?? match[5] ?? null;
  const readableByteError = response => ['file', 'preview', 'poster', 'cover'].includes(part) ? withSharedFileCors(response) : response;
  const acting = ((part === 'book' || part === 'sealed') && request.method === 'POST') || part === 'prove' || part === 'sign' || part === 'pay' || part === 'add';
  if (request.method === 'OPTIONS' && ['file', 'preview', 'poster', 'cover'].includes(part)) return new Response(null, {
    status: 204, headers: { ...sharedFileCors, 'access-control-allow-methods': 'GET, HEAD',
      'access-control-allow-headers': 'range', 'access-control-max-age': '86400' },
  });
  const continuingUpload = part === 'add' && url.searchParams.has('upload');
  if (continuingUpload ? !['GET', 'POST', 'PUT'].includes(request.method)
    : acting ? request.method !== 'POST' : request.method !== 'GET' && request.method !== 'HEAD') return null;
  const durations = [];
  const measure = (name, since) => durations.push(`${name};dur=${Math.max(0, performance.now() - since).toFixed(1)}`);
  const measured = response => {
    response.headers.set('server-timing', durations.join(', '));
    return response;
  };
  let started = performance.now();
  let stage = 'link-index';
  try {
    const index = await watchedShareStage(stage, () => kv.get(`${RECORD_SHARE_LINK_INDEX}${code}`, 'json'));
    measure('index', started);
    if (!index?.person_ref) return asData ? sharedDataFailure(404, request.method) : readableByteError(gone());
    const accessCode = url.searchParams.get('access_code');
    stage = 'owner-access';
    const recipient = { ...(session ?? {}), ...(accessCode ? { access_code: accessCode } : {}), link_index: index };
    const person = await currentShareOwner(shareOwnerFor, { index, code, request, recipient });
    if(part==='book' && request.method==='GET')return availabilityShare({request,origin,code,person,recipient,accessCode});
    if (acting) return await act({ request, env, origin, code, part, person, recipient, buyerFor, accessCode, files });
    if (viewPath !== null) {
      const asking = { ...recipient, ...(itemIndex === undefined ? {} : { item_index: Number(itemIndex) }) };
      const access = await person.sharedRecordViewRequest(code, asking, viewPath);
      if (access?.denied) return measured(gone());
      const file = access?.file;
      const root = `${origin}/share/${code}/${itemIndex === undefined ? '' : `items/${itemIndex}/`}view/`;
      const response = sharedSiteViewResponse(request, file, root);
      return measured(request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response);
    }

    if (part === 'look') {
      stage = 'logo-access';
      const access = await watchedShareStage(stage, () => person.shareLookLogoFile(code));
      stage = 'logo-bytes';
      return measured(await watchedShareStage(stage, () => sharedBytes(request, env, access, 'file', measure, ctx, person)));
    }
    if (part === 'sealed') return measured(await sealedShare(request, person, code, recipient));
    started = performance.now();
    if (part === '_sender') {
      stage = 'sender-access';
      const sender = await watchedShareStage(stage, () => person.shareSenderForLink(code, recipient));
      measure('access', started);
      return measured(request.method === 'HEAD'
        ? new Response(null, { headers: { ...noCache, 'content-type': 'application/json' } })
        : Response.json({ sender }, { headers: noCache }));
    }
    if (part) {
      const shareRequest = { ...recipient, ...(itemIndex === undefined ? {} : { item_index: Number(itemIndex) }), ...(fileIdentity ? { file_identity: fileIdentity } : {}) };
      const rangeHeader = part === 'cover' ? null : part === 'preview' ? boundedPreviewRange(request.headers.get('range')) : request.headers.get('range');
      stage = 'file-access';
      const callerStartedAt = Date.now();
      const probeId = crypto.randomUUID();
      if (sampledStorageProbe(probeId)) console.info('checked read RPC requested', { probe_id: probeId, method: 'file-access' });
      const access = await watchedShareStage(stage, () => person.sharedFileForLink(code, shareRequest, part, rangeHeader,
        request.method === 'GET' && part !== 'transcript', callerStartedAt, probeId), probeId);
      if (sampledStorageProbe(probeId)) console.info('checked read RPC returned', {
        probe_id: probeId, method: 'file-access',
        ...(['scheduled', 'unsupported-sync', 'failed'].includes(access?._timing?.storage_probe_state)
          ? { storage_probe_state: access._timing.storage_probe_state } : {}),
      });
      if (access?.denied) return readableByteError(gone());
      const copy = access?.copy;
      const accessMs = Math.max(0, performance.now() - started);
      durations.push(`access;dur=${accessMs.toFixed(1)}`);
      if (access?._timing) {
        durations.push(...shareAdmissionDiagnostics(access._timing));
        const bounded = (value, available) => Number.isFinite(value) ? Math.min(available, Math.max(0, value)) : 0;
        let remaining = accessMs;
        for (const [phase, value] of [
          ['access_admission', access._timing.admission_ms],
          ['access_resolve', access._timing.resolve_ms],
          ['access_row', access._timing.row_ms],
        ]) {
          if (value === undefined) continue;
          const ms = bounded(value, remaining);
          durations.push(`${phase};dur=${ms.toFixed(1)}`);
          remaining -= ms;
        }
        durations.push(`access_wait;dur=${remaining.toFixed(1)}`);
        // First share read is not necessarily the call that constructed this
        // owner. Keep historical construction outside current phase arithmetic.
        if (Number.isFinite(access._timing.constructor_ms))
          durations.push(`owner_constructor;dur=${Math.max(0, access._timing.constructor_ms).toFixed(1)}`);
        if (Number.isFinite(access._timing.initial_admission_ms))
          durations.push(`owner_initial_admission;dur=${Math.max(0, access._timing.initial_admission_ms).toFixed(1)}`);
        if (typeof access._timing.owner_first_share_read === 'boolean') durations.push(`owner_first_share_read;desc="${access._timing.owner_first_share_read ? 'yes' : 'no'}"`);
        if (['idle', 'keep', 'report', 'prune', 'judge'].includes(access._timing.meter_flush_phase))
          durations.push(`meter_flush;desc="${access._timing.meter_flush_phase}"`);
        for (const [phase, value] of [['owner_arrival', access._timing.owner_arrival_ms], ['owner_method', access._timing.owner_method_ms]]) {
          if (Number.isFinite(value)) durations.push(`${phase};dur=${bounded(value, accessMs).toFixed(1)}`);
        }
      }
      const item = itemIndex === undefined && copy?.kind === 'collection' ? null : copy;
      if (!item) return readableByteError(gone('This file is not in this share.'));
      if (part === 'transcript') {
        stage = 'transcript-read';
        const answer = await watchedShareStage(stage, () => sharedTranscript(person, item, access?.row, shareRequest));
        return measured(request.method === 'HEAD' ? new Response(null, { status: answer.status, headers: answer.headers }) : answer);
      }
      stage = 'file-bytes';
      return measured(await watchedShareStage(stage, () => sharedBytes(request, env, access, part, measure, ctx, person, rangeHeader, shareRequest)));
    }
    // Back from checkout: the seller's own Stripe says whether it was paid. A failed check leaves things as they were.
    if (url.searchParams.has('paid') && recipient.buyer_ref) await person.settleSharePayment(code, recipient).catch(paidCheckFailed);
    const rawOffset = url.searchParams.get('offset');
    const rawFocus = asData ? null : url.searchParams.get('item');
    const focusIndex = rawFocus === null ? null : /^(0|[1-9]\d*)$/.test(rawFocus) ? Number(rawFocus) : NaN;
    const itemOffset = rawFocus !== null && Number.isSafeInteger(focusIndex) ? Math.floor(focusIndex / COLLECTION_VIEW_PAGE_SIZE) * COLLECTION_VIEW_PAGE_SIZE
      : rawOffset === null ? 0 : /^(0|[1-9]\d*)$/.test(rawOffset) ? Number(rawOffset) : NaN;
    if (!Number.isSafeInteger(itemOffset) || (focusIndex !== null && !Number.isSafeInteger(focusIndex))) return asData
      ? sharedDataFailure(400, request.method, 'The item page is invalid.')
      : shareErrorPage('The item page is invalid.', 400);
    stage = 'page-access';
    const callerStartedAt = Date.now();
    const probeId = crypto.randomUUID();
    const { access, copy, denied, _timing } = await watchedShareStage(stage, () => person.sharedPageForLink(code, recipient,
      { count_open: request.method !== 'HEAD' && !asData, caller_started_at: callerStartedAt, item_offset: itemOffset,
        item_limit: asData ? COLLECTION_PAGE_SIZE : COLLECTION_VIEW_PAGE_SIZE, row_address: rowAddress,
        probe_id: probeId }), probeId);
    if (denied) return asData ? sharedDataFailure(404, request.method) : gone();
    const accessMs = Math.max(0, performance.now() - started);
    durations.push(`access;dur=${accessMs.toFixed(1)}`);
    if (_timing) {
      durations.push(...shareAdmissionDiagnostics(_timing));
      let remaining = accessMs;
      for (const [phase, value] of [
        ['access_admission', _timing.admission_ms],
        ['access_grant', _timing.grant_ms],
        ['access_sender', _timing.sender_ms],
        ['access_copy', _timing.copy_ms],
      ]) {
        if (!Number.isFinite(value)) continue;
        const ms = Math.min(remaining, Math.max(0, value));
        durations.push(`${phase};dur=${ms.toFixed(1)}`);
        remaining -= ms;
      }
      durations.push(`access_wait;dur=${remaining.toFixed(1)}`);
      if (Number.isFinite(_timing.constructor_ms))
        durations.push(`owner_constructor;dur=${Math.max(0, _timing.constructor_ms).toFixed(1)}`);
      if (Number.isFinite(_timing.initial_admission_ms))
        durations.push(`owner_initial_admission;dur=${Math.max(0, _timing.initial_admission_ms).toFixed(1)}`);
      for (const [phase, value] of [['owner_arrival', _timing.owner_arrival_ms], ['owner_method', _timing.owner_method_ms]]) {
        if (Number.isFinite(value)) durations.push(`${phase};dur=${Math.min(accessMs, Math.max(0, value)).toFixed(1)}`);
      }
    }
    if (asData) {
      const answer = sharedData({ origin, code, access, copy, accessCode });
      return measured(request.method === 'HEAD' ? new Response(null, { status: answer.status, headers: answer.headers }) : answer);
    }
    if (!access.admitted) return measured(refusedPage({ origin, code, access, accessCode }));
    // Page rendering is a read of the current grant: a view event written inside the owner turn could make an
    // authorized share fail when that account's database is full. Only a link whose own condition counts its opens
    // writes on a page open (record-sharing.mjs count_open).
    stage = 'page-words';
    const focusedWindow = copy.kind === 'collection' && focusIndex !== null ? collectionWindow(copy, COLLECTION_VIEW_PAGE_SIZE) : null;
    const focusedItem = focusedWindow?.items[focusIndex - focusedWindow.offset] ?? (focusedWindow ? null : copy);
    const words = request.method !== 'HEAD' && focusedItem?.kind === 'file'
      ? await sharedWords({ request, env, ctx, person, code,
        recipient: focusedWindow ? { ...recipient, item_index: focusIndex } : recipient, copy: focusedItem }) : null;
    stage = 'page-render';
    const answer = await watchedShareStage(stage, () => recordPage({ origin, code, copy, access, person, recipient, accessCode, rowAddress, words, focusIndex }));
    return measured(request.method === 'HEAD' ? new Response(null, { status: answer.status, headers: answer.headers }) : answer);
  } catch (error) {
    if (error instanceof SharingError || error?.message === 'This share link has ended.'
      || error?.message === 'This share link is for someone else, or needs its access code.') {
      return asData ? sharedDataFailure(404, request.method)
        : readableByteError(gone(error?.message === 'This share link is for someone else, or needs its access code.' ? error.message : 'This share link has ended.'));
    }
    // Do not tell someone a valid grant was revoked when its owner or page renderer failed.
    // Log only the phase and error class: the link and any private record details stay out of logs.
    console.error('public-share temporarily unavailable', { stage, reason: shareOwnerFailureCategory(error) });
    return asData ? sharedDataFailure(503, request.method) : readableByteError(temporarilyUnavailable());
  }

}
