// Read one public page. What the page says (title, text, links and its own card) is read by the one page reader,
// ./page-facts.mjs. Where the request may go is not decided here: the engine runs this tool as internet:true, so
// Node's own fetch reaches only the engine's public-only proxy (NODE_USE_ENV_PROXY), which judges every address, every
// redirect and every address a name resolves to.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkedUrl, extractPage } from './page-facts.mjs';
import { walkArchive } from './walk-archive.mjs';

const MAX_BYTES = 2_000_000;
const WAIT_MS = 12_000;
const TOO_LARGE = 'The page is larger than the 2 MB limit.';
const PAGE_MEDIA = ['text/html', 'application/xhtml+xml', 'text/plain'];
// A walk also reads sitemaps.
const WALK_MEDIA = [...PAGE_MEDIA, 'application/xml', 'text/xml'];

// One answer, its redirect not followed (readPublicPage judges and follows it), at most MAX_BYTES of body.
async function fetchOnce(url) {
  let response;
  try {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(WAIT_MS),
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/xml;q=0.8,text/xml;q=0.8', 'user-agent': 'PublicPageReader/1.0' } });
  } catch { throw new Error('The public page could not be read.'); }
  const headers = Object.fromEntries(response.headers);
  if (Number(headers['content-length']) > MAX_BYTES) { await response.body?.cancel(); throw new Error(TOO_LARGE); }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new Error(TOO_LARGE);
      chunks.push(chunk);
    }
  } catch (error) { throw error.message === TOO_LARGE ? error : new Error('The public page could not be read.'); }
  return { status: response.status, headers, body: Buffer.concat(chunks) };
}

// One checked page's bytes, decoded: { url, final_url, status, media, body }. A refusal carries the page's HTTP status as `status`.
export async function readBody(input, fetchPage = fetchOnce, accepted = PAGE_MEDIA) {
  let current = checkedUrl(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchPage(current);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location) throw new Error('The page returned a redirect without a destination.');
      if (redirects === 5) throw new Error('The page redirected too many times.');
      const next = checkedUrl(new URL(response.headers.location, current).href);
      if (current.protocol === 'https:' && next.protocol === 'http:') throw new Error('HTTPS pages cannot redirect to an unencrypted HTTP page.');
      current = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`The page returned HTTP ${response.status}.`), { status: response.status });
    const contentType = response.headers['content-type'] ?? 'text/html';
    const media = contentType.split(';')[0].trim().toLowerCase();
    if (!accepted.includes(media)) throw new Error('The address did not return an HTML or plain-text page.');
    if (response.body.length > MAX_BYTES) throw new Error(TOO_LARGE);
    const charset = /charset\s*=\s*["']?([a-z0-9._-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
    let decoder;
    try { decoder = new TextDecoder(charset, { fatal: false }); } catch { decoder = new TextDecoder(); }
    return { url: input, final_url: current.href, status: response.status, media, body: decoder.decode(response.body) };
  }
  throw new Error('The page redirected too many times.');
}

const factsOf = page => ({ url: page.url, final_url: page.final_url, status: page.status, ...extractPage(page.body, new URL(page.final_url), page.media === 'text/plain') });

export async function readPublicPage(input, fetchPage = fetchOnce) {
  return factsOf(await readBody(input, fetchPage));
}

/** The same read of the start page, plus the walk of its archive (./walk-archive.mjs) when `walk` is asked for: the start page's facts with `walk` added. */
export async function readPublicPageOrArchive(input, fetchPage = fetchOnce, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))) {
  if (input.walk === undefined) return readPublicPage(input.url, fetchPage);
  const { first, walk } = await walkArchive(input.url, input.walk, { read: address => readBody(address, fetchPage, WALK_MEDIA), sleep });
  // A sitemap has no words of its own: its start-page facts are the empty read.
  const start = first.media.endsWith('xml') ? { ...first, body: '', media: 'text/plain' } : first;
  return { ...factsOf(start), walk };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(await readPublicPageOrArchive(input)) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 2;
  }
}
