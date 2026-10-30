// tools/browse-public-page/do-work/read_a_link.mjs
//
// PURPOSE
//   One public link read whole into a card: its title, picture, description, site name and icon, every picture and
//   video it declares, its structured data (schema.org JSON-LD) and the words a person reads on it. A link that is
//   itself a picture or a video is that picture or video. The container tool tool:read-a-link (tool-rows.json).
//
//   readLinkCard(url, { fetchPage?, waitMs? }) -> { url, final_url, host, site, title, description, image, images, videos,
//                                                   icon, data, text, unread }
//
// NON-NEGOTIABLE INVARIANTS
//   1. The page's bytes are read by the one page reader (./page-facts.mjs), the same one tool:read-public-web-page
//      runs, so a link reads the same everywhere.
//   2. Where the read may go is not decided here: the engine runs this tool as internet:true, so Node's own fetch
//      reaches only the engine's public-only proxy, which judges every address and every redirect hop. A hop it
//      refuses answers as a page that did not answer, naming no address.
//   3. Bounded: at most READ_BYTES bytes and waitMs milliseconds. A page that does not answer, is not a page, or says
//      nothing about itself gives the bare address with `unread` saying why in plain words, never a guess.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkedUrl, extractPage, fileFacts } from './page-facts.mjs';

const READ_BYTES = 2_000_000;
const WAIT_MS = 6000;
const PAGE_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

export class ReadLinkError extends Error {}

const hostOf = url => url.hostname.toLowerCase().replace(/^www\./, '');

/** The card for one public link. Throws ReadLinkError only when the address itself is not a web page address. */
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
    response = await beforeDeadline(fetchPage(address.href, {
      signal: controller.signal,
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'user-agent': 'facebookexternalhit/1.1' },
    }));
  } catch {
    stopDeadline();
    return bare(timedOut ? 'The page took too long to answer.' : 'The page did not answer.');
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
  } catch {
    unread = timedOut ? 'The page took too long to finish reading.' : 'The page stopped before it finished.';
    if (!body) { stopDeadline(); return bare(timedOut ? 'The page took too long to answer.' : 'The page stopped before it said anything.'); }
  } finally {
    stopDeadline();
    try { void reader?.cancel().catch(() => {}); } catch { /* the reader is already released */ }
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

// Run as the container tool: { url } on standard input, the card (or { error }) as one JSON line on standard output.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(await readLinkCard(input.url)) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 2;
  }
}
