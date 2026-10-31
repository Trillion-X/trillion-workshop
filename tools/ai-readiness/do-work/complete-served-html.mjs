// Adds, to a whole published page that leaves them out, the facts an answer engine reads from the served bytes: the
// page's language, its own address and the dates it was published and last changed. Anything the page already says is
// left exactly as written, and a page fragment (no head) is served as it is.
import completion from '../read-data/served-page-completion.json' with { type: 'json' };
import { parseHtml } from './audit-served-html.mjs';

const escape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** `facts`: `{ published_at?, updated_at?, canonical_url? }`, ISO dates and an https address. */
export function completeServedHtml(html, facts = {}) {
  if (!/<\/head>/i.test(html)) return html;
  const page = parseHtml(html);
  const has = (tag, test) => page.elements.some(element => element.tag === tag && test(element.attrs));
  let out = html;
  if (!has('html', attrs => 'lang' in attrs)) out = out.replace(/<html(?=[\s>])/i, `<html lang="${completion.language}"`);
  const additions = [];
  if (facts.canonical_url && /^https:\/\/[^\s"<>]+$/.test(facts.canonical_url) && !has('link', attrs => /\bcanonical\b/i.test(attrs.rel ?? ''))) additions.push(`<link rel="canonical" href="${escape(facts.canonical_url)}">`);
  for (const [property, value] of [[completion.published_property, facts.published_at], [completion.modified_property, facts.updated_at]]) {
    if (validDate(value) && !has('meta', attrs => attrs.property === property || attrs.name === property)) additions.push(`<meta property="${property}" content="${escape(new Date(value).toISOString())}">`);
  }
  return additions.length ? out.replace(/<\/head>/i, `${additions.join('')}</head>`) : out;
}
