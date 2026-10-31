// Lets an agent ask a page for its words as Markdown (Accept: text/markdown) and get them with the size it saved.
// Only an explicit text/markdown range counts (`*/*` never does); against an explicit text/html range the higher q
// wins and, at equal q, the range named first. The conversion reads the page's landmark (else its body) and is made
// for pages this service draws itself: headings, paragraphs, lists, quotes and links survive, scripts and pictures do
// not. The element names it drops or breaks on are the rows of ../read-data/markdown-conversion.json.
import conversion from '../read-data/markdown-conversion.json' with { type: 'json' };
import { parseHtml } from './audit-served-html.mjs';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…' };
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
  if (name[0] === '#') { const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10); return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '; }
  return ENTITIES[name.toLowerCase()] ?? whole;
});

// Markup patterns are built from these two characters and the names in the DATA, so no element is named in code.
const OPEN = '\\u003c';
const CLOSE = '\\u003e';
const pattern = (source, flags = 'gi') => new RegExp(source.replaceAll('{<}', OPEN).replaceAll('{>}', CLOSE), flags);
const DROPPED = pattern(`{<}(${conversion.drop.join('|')})[\\s{>}][\\s\\S]*?{<}/\\1\\s*{>}`);
const HEADING = pattern('{<}h([1-6])\\b[^{>}]*{>}([\\s\\S]*?){<}/h\\1\\s*{>}');
const LINK = pattern('{<}a\\b[^{>}]*\\bhref=(?:"([^"]*)"|\'([^\']*)\')[^{>}]*{>}([\\s\\S]*?){<}/a\\s*{>}');
const PICTURE = pattern('{<}img\\b[^{>}]*\\balt="([^"]*)"[^{>}]*{>}');
const LIST_ITEM = pattern('{<}li\\b[^{>}]*{>}');
const QUOTE = pattern('{<}blockquote\\b[^{>}]*{>}');
const BREAK = pattern(`{<}/?(${conversion.paragraph_breaks.join('|')})\\b[^{>}]*{>}`);
const ANY_TAG = pattern('{<}[^{>}]*{>}');

/** True when the Accept header explicitly prefers text/markdown to text/html. */
export function prefersMarkdown(accept) {
  if (typeof accept !== 'string') return false;
  const ranges = accept.split(',').map((part, index) => {
    const [type, ...params] = part.trim().split(';');
    const q = params.map(param => param.trim()).find(param => /^q=/i.test(param));
    return { type: type.trim().toLowerCase(), q: q === undefined ? 1 : Number(q.slice(2)), index };
  });
  const markdown = ranges.find(range => range.type === 'text/markdown');
  if (!markdown || !(markdown.q > 0)) return false;
  const page = ranges.find(range => range.type === 'text/html');
  return !page || !(page.q > 0) || markdown.q > page.q || (markdown.q === page.q && markdown.index < page.index);
}

const plain = source => decode(source.replace(ANY_TAG, ' ')).replace(/\s+/g, ' ').trim();

/** The page's words as Markdown. `origin` makes links absolute. */
export function htmlToMarkdown(source, origin) {
  const page = parseHtml(source);
  const main = page.elements.find(element => element.tag === conversion.landmark) ?? page.elements.find(element => element.tag === 'body');
  const absolute = href => { try { return new URL(href, origin).href; } catch { return href; } };
  const body = (main ? page.source.slice(main.contentStart, main.contentEnd) : page.source)
    .replace(DROPPED, ' ')
    .replace(HEADING, (whole, level, inner) => `\n\n${'#'.repeat(Number(level))} ${plain(inner)}\n\n`)
    .replace(LINK, (whole, double, single, inner) => {
      const label = plain(inner);
      const href = decode(double ?? single ?? '');
      return label && href && !href.startsWith('#') ? `[${label}](${absolute(href)})` : label;
    })
    .replace(PICTURE, (whole, alt) => (alt ? ` ${alt} ` : ' '))
    .replace(LIST_ITEM, '\n- ')
    .replace(QUOTE, '\n\n> ')
    .replace(BREAK, '\n\n')
    .replace(ANY_TAG, ' ');
  return `${decode(body).split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/^-\s*\n+(?:#{1,6} )?/gm, '- ').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * The response an agent asked for: Markdown for an HTML page when `prefersMarkdown`, with `x-markdown-tokens` and
 * `x-original-tokens`, `Vary: Accept` added to every HTML page, and the headers that described the HTML bytes dropped.
 * `tokensPerCharacter` and `mostHtmlCharacters` come from the caller's DATA.
 */
export async function negotiateMarkdown(request, response, { origin, tokensPerCharacter, mostHtmlCharacters }) {
  const type = response.headers.get('content-type') ?? '';
  if ((request.method !== 'GET' && request.method !== 'HEAD') || response.status !== 200 || !/^text\/html/i.test(type)) return response;
  const headers = new Headers(response.headers);
  const vary = (headers.get('vary') ?? '').split(',').map(part => part.trim()).filter(Boolean);
  if (!vary.some(part => part === '*' || part.toLowerCase() === 'accept')) vary.push('Accept');
  headers.set('vary', vary.join(', '));
  if (!prefersMarkdown(request.headers.get('accept'))) return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  const source = await response.text();
  if (source.length > mostHtmlCharacters) return new Response(source, { status: response.status, headers });
  const markdown = htmlToMarkdown(source, origin);
  for (const name of ['content-length', 'content-encoding', 'content-range', 'etag', 'last-modified']) headers.delete(name);
  headers.set('content-type', 'text/markdown; charset=utf-8');
  headers.set('x-markdown-tokens', String(Math.ceil(markdown.length * tokensPerCharacter)));
  headers.set('x-original-tokens', String(Math.ceil(source.length * tokensPerCharacter)));
  return new Response(request.method === 'HEAD' ? null : markdown, { status: 200, headers });
}
