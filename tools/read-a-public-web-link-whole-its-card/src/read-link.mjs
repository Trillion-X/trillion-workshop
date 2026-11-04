// src/read-link.mjs
//
// PURPOSE
//   One public link read whole: its card (title, picture, description, site name and icon), every picture and video it
//   declares, its structured data (schema.org JSON-LD), and the words a person reads on it. A link that is itself a
//   picture or a video is that picture or video. The one road for it: the workspace asks when a person pastes a link (GET /work/api/read-link?url=,
//   src/workspace/read-link.ts), the Android share page draws a shared link with it (src/phone-share.mjs), saved
//   examples fill themselves from it (src/saved-examples.mjs), and any AI runs it as the Workshop tool
//   tool:read-a-link (records/workshop-browse-tool-records.json, the account action `read-link`).
//
//   readLinkCard(url, { fetchPage?, waitMs? }) -> { url, final_url, host, site, title, description, image, images, videos,
//                                                   icon, data, text, unread }
//   A share delivered with a bare link has its card filled in here afterwards (src/share-destinations.mjs).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The page's bytes are read by the one page reader (trillion-workshop: tools/browse-public-page/do-work/page-facts.mjs), the same
//      one the container tool runs, so a link reads the same everywhere.
//   2. Public pages only: the address is checked before it is fetched, every redirect hop is judged again before it is
//      asked for (parts/http-client/do-work/public-address.mjs fetchPublic, the one outbound-read road), and the
//      Worker's fetch reaches only the public internet (wrangler.jsonc global_fetch_strictly_public). A hop to a
//      private address answers as a page that did not answer, naming no address.
//   3. Bounded: at most READ_BYTES bytes and waitMs milliseconds. A page that does not answer, is not a page, or says
//      nothing about itself gives the bare address with `unread` saying why in plain words, never a guess.

import { fetchPublic, NotPublicAddress } from '../../refuse-requests-to-private-addresses/public-address.mjs';
import { checkedUrl, extractPage, fileFacts } from '../../browse-public-page/do-work/page-facts.mjs';

const READ_BYTES = 2_000_000;
const WAIT_MS = 6000;
const PAGE_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

export class ReadLinkError extends Error {}

const hostOf = url => url.hostname.toLowerCase().replace(/^www\./, '');

/** The card for one public link. Throws ReadLinkError only when the address itself is not a public web address. */
export async function readLinkCard(input, { fetchPage = fetch, waitMs = WAIT_MS } = {}) {
  let address;
  try { address = checkedUrl(typeof input === 'string' ? input.trim() : input); } catch (error) { throw new ReadLinkError(error.message); }
  const bare = unread => ({ url: address.href, final_url: address.href, host: hostOf(address), site: null, title: null, description: null, image: null, images: [], videos: [], icon: null, data: [], text: '', unread });
  let response;
  const controller = new AbortController();
  let timedOut = false;
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(Object.assign(new Error('Read time limit reached.'), { readLinkTimeout: true }));
    }, Math.max(0, Number(waitMs) || 0));
  });
  const beforeDeadline = promise => Promise.race([promise, deadline]);
  const stopDeadline = () => clearTimeout(timeout);
  try {
    response = await beforeDeadline(fetchPublic(address.href, {
      signal: controller.signal,
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'user-agent': 'facebookexternalhit/1.1 (+https://gettrillion.ai) Trillion' },
    }, { fetchImpl: fetchPage, schemes: ['https:', 'http:'] }));
  } catch (error) {
    stopDeadline();
    return bare(timedOut ? 'The page took too long to answer.' : error instanceof NotPublicAddress ? 'The link leads somewhere that is not a public page.' : 'The page did not answer.');
  }
  if (!response.ok || !response.body) { stopDeadline(); return bare(`The page answered ${response.status}.`); }
  const contentType = response.headers.get('content-type') ?? 'text/html';
  const media = contentType.split(';')[0].trim().toLowerCase();
  if (!PAGE_TYPES.includes(media)) {
    stopDeadline();
    response.body.cancel().catch(() => {});
    // A link that is itself a picture or a video is that picture or video; any other file has no card.
    const file = fileFacts(response.url || address.href, media);
    if (!file.images.length && !file.videos.length) return bare('This link is a file, not a page.');
    return { ...bare(null), image: file.images[0] ?? null, ...file };
  }
  const charset = /charset\s*=\s*["']?([a-z0-9._-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  let decoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder(); }
  let reader;
  let body = '';
  let bytes = 0;
  let unread = null;
  try {
    reader = response.body.getReader();
    while (true) {
      const { value, done } = await beforeDeadline(reader.read());
      if (done) break;
      const remaining = READ_BYTES - bytes;
      if (remaining <= 0) { unread = 'The page reached the read limit before it ended.'; break; }
      const chunk = value.subarray(0, remaining);
      bytes += chunk.byteLength;
      body += decoder.decode(chunk, { stream: true });
      if (value.byteLength > remaining) { unread = 'The page reached the read limit before it ended.'; break; }
    }
    if (!unread) body += decoder.decode();
  } catch (error) {
    unread = timedOut ? 'The page took too long to finish reading.' : 'The page stopped before it finished.';
    if (!body) { stopDeadline(); return bare(timedOut ? 'The page took too long to answer.' : 'The page stopped before it said anything.'); }
  } finally {
    stopDeadline();
    try { void reader?.cancel().catch(() => {}); } catch {}
  }
  const final = (() => { try { return checkedUrl(response.url || address.href); } catch { return address; } })();
  const page = extractPage(body, final, media === 'text/plain');
  return {
    url: address.href,
    final_url: final.href,
    host: hostOf(final),
    site: page.site,
    title: page.title || null,
    description: page.description,
    image: page.image,
    images: page.images,
    videos: page.videos,
    icon: page.icon,
    data: page.data,
    text: page.text,
    unread: unread ?? (page.title || page.text ? null : 'The page says nothing about itself.'),
  };
}

/** The address a request asks about: `?url=` on a read, `{ url }` in a POST body. */
async function askedUrl(request) {
  if (request.method === 'GET') return new URL(request.url).searchParams.get('url');
  const body = await request.json().catch(() => null);
  return body && typeof body.url === 'string' ? body.url : null;
}

export const isReadLinkPath = path => path === '/read-link';

/** GET /read-link?url= or POST /read-link { url }: the card, or 400 with why the address is not one. */
export async function handleReadLinkRequest(request, options) {
  if (!['GET', 'POST'].includes(request.method)) return Response.json({ error: 'Not found' }, { status: 404 });
  const url = await askedUrl(request);
  if (!url) return Response.json({ error: 'Give the link to read as url.' }, { status: 400 });
  try {
    return Response.json(await readLinkCard(url, options));
  } catch (error) {
    return Response.json({ error: error.message }, { status: error instanceof ReadLinkError ? 400 : 500 });
  }
}
