// A source quote is observed by this service, not accepted from an AI's or a page's claim.
// Only the short quote and where/when it was seen are kept; nothing is published.
import { identityOf } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';
import { publicAddress } from '../../refuse-requests-to-private-addresses/public-address.mjs';

const words = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const key = value => words(value).normalize('NFKC').toLocaleLowerCase('en');

// A source page is a public https page on a named site: any public address (parts/http-client/do-work/public-address.mjs) that is not an IP
// literal, since a quote is credited to a site by its name.
export function publicSourceUrl(value) {
  let address;
  try { address = publicAddress(value); } catch { throw new Error('The source must be a public HTTPS page.'); }
  const url = new URL(address);
  if (url.hostname.startsWith('[') || /^(?:\d+\.){3}\d+$/.test(url.hostname)) throw new Error('The source must be a public HTTPS page.');
  url.hash = '';
  return url.toString();
}

export async function readPublicAudiencePage(address, { fetchPage = fetch } = {}) {
  let url = publicSourceUrl(address);
  const sourceHost = new URL(url).hostname;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const response = await fetchPage(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('The source page redirected without an address.');
      const redirected = publicSourceUrl(new URL(location, url).toString());
      if (new URL(redirected).hostname !== sourceHost) throw new Error('The source page moved to a different site. Use its final public address.');
      url = redirected;
      continue;
    }
    if (!response.ok) throw new Error(`The source page answered ${response.status}.`);
    const mime = response.headers.get('content-type') ?? '';
    if (!/^(?:text\/html|text\/plain|application\/json)(?:;|$)/i.test(mime)) throw new Error('The source is not a text page or public JSON response.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The source page had no readable text.');
    const decoder = new TextDecoder();
    let body = '';
    while (body.length < 200000) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    body = body.slice(0, 200000);
    if (mime.toLowerCase().startsWith('text/plain')) return body;
    if (mime.toLowerCase().startsWith('application/json')) {
      let parsed;
      try { parsed = JSON.parse(body); } catch { throw new Error('The public JSON response could not be read.'); }
      const values = [];
      const pending = [parsed];
      while (pending.length) {
        const value = pending.pop();
        if (typeof value === 'string') values.push(value);
        else if (value && typeof value === 'object') pending.push(...Object.values(value));
      }
      return values.join(' ');
    }
    const pieces = [];
    let skipping = 0;
    await new HTMLRewriter()
      .on('script, style, noscript', { element(element) { skipping += 1; element.onEndTag(() => { skipping -= 1; }); } })
      .on('*', { text(chunk) { if (!skipping && chunk.text.trim()) pieces.push(chunk.text.trim()); } })
      .transform(new Response(body, { headers: { 'content-type': 'text/html' } })).arrayBuffer();
    return pieces.join(' ');
  }
  throw new Error('The source page redirected too many times.');
}

// One public page's exact words, observed (read and checked) and then kept: readAudienceSource reads, keepAudienceSource
// is its one synchronous write.
export async function observeAudienceSource(eeaf, input, { readPage, now = () => new Date() }) {
  return keepAudienceSource(eeaf, await readAudienceSource(input, { readPage, now }));
}
export function keepAudienceSource(eeaf, source) {
  eeaf.write([{ id: source.id, type: 'audience-source', value: source }], { actor: { by: 'audience-source-observation' } });
  return source;
}
export async function readAudienceSource(input, { readPage, now = () => new Date() }) {
  const role = input?.role;
  if (!['question', 'answer', 'rights'].includes(role)) throw new Error('Choose a question, answer, or rights source.');
  const venture_ref = words(input.venture_ref);
  const offer_ref = words(input.offer_ref);
  const quote = words(input.quote);
  if (!venture_ref || !quote || quote.length > 500 || (role === 'question' && !offer_ref)) {
    throw new Error('Name the venture, a short exact quote, and the offer for a question.');
  }
  const source_url = publicSourceUrl(input.source_url);
  const page = await readPage(source_url);
  if (!key(page).includes(key(quote))) throw new Error('Those words were not found on the public page.');
  const observed_at = now().toISOString();
  const id = `audience-source:${identityOf(JSON.stringify([role, venture_ref, source_url, quote, observed_at]))}`;
  return { id, role, venture_ref, ...(offer_ref ? { offer_ref } : {}), source_url, quote, observed_at };
}

export function currentAudienceSource(eeaf, id, { now = new Date(), days = 30 } = {}) {
  const source = eeaf.read(id);
  if (!source || source.id !== id || !eeaf.ids('audience-source').includes(id)) return null;
  const age = now.getTime() - Date.parse(source.observed_at);
  if (!Number.isFinite(age) || age < 0 || age > days * 86400000) return null;
  return source;
}
