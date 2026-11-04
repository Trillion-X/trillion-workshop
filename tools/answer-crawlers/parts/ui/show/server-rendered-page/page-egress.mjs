// parts/ui/show/server-rendered-page/page-egress.mjs
//
// Purpose: A BROWSER NEVER SEES A FAILURE AS BARE TEXT, JSON OR AN EMPTY BODY.
//
// A service answers many callers from one set of routes: programs that read JSON, AI apps, webhook senders, and
// people typing an address into a browser. Each route decided for itself what a failure looks like, so a person who
// followed an old link got `{"error":"Not found"}`, a line of monospace text, or a white page, depending on which
// route happened to answer. Fixing those routes one by one leaves the next new route free to do the same.
//
// So the decision is made once, where every answer leaves the service: `pageForBrowser(request, response, pageFor)`.
// When the request is a person's browser opening an address and the answer is a failure that is not already a page,
// the answer becomes a page with the same status, the words the route said, and a way on. Everything else leaves
// exactly as it was.
//
// Non-negotiable invariants:
//   1. Only a browser navigation is changed: `Sec-Fetch-Mode: navigate`, or, from a browser too old to send it, an
//      Accept header that prefers text/html to JSON. A script's fetch, an AI app and a webhook sender get the route's
//      own answer untouched (the same Response object).
//   2. Only a failure (status 400 and up) is changed. A redirect, a successful file (a manifest, llms.txt, a JSON read
//      someone opened on purpose), a WebSocket upgrade and a download (Content-Disposition: attachment) pass through.
//   3. Only words and HTML are changed: text/plain, JSON, unmarked HTML, or an empty body. Pictures, video, audio,
//      fonts, scripts, stylesheets, PDFs and every other byte kind pass through, so a broken image stays an image.
//   4. A page the shared shell drew carries SHELL_PAGE_HEADER and is never touched, so wrapping twice is wrapping
//      once, and a route's own designed error page always wins.
//   5. The status is kept. The route's words are shown only when they are plain words: a JSON `error_description`,
//      `message` or `error` field, or a text body, trimmed and shortened; a stack trace is never shown.
//   6. This file names no route, page or product. What the page says is the caller's `pageFor`, fed from its DATA.
//
// Key concepts: `isBrowserNavigation`, `SHELL_PAGE_HEADER` / `markShellPage`, `shouldBecomePage`, `routeWords`.
// Security: the route's words go to `pageFor` as data and the shell escapes them. Nothing here writes a tag.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** The header every page drawn by the shared shell carries. Its presence means "this is already a designed page". */
export const SHELL_PAGE_HEADER = 'x-page-shell';

/** The same headers, marked as a shell page. Accepts anything `new Headers()` accepts. */
export function markShellPage(headers = {}) {
  const marked = new Headers(headers);
  marked.set(SHELL_PAGE_HEADER, '1');
  return marked;
}

export const isShellPage = response => response.headers.get(SHELL_PAGE_HEADER) === '1';

// The weight a browser's Accept header gives a media type (q=1 when not stated; 0 when absent).
function acceptWeight(accept, type) {
  let best = 0;
  for (const part of accept.split(',')) {
    const [range, ...params] = part.trim().toLowerCase().split(';').map(piece => piece.trim());
    if (range !== type) continue;
    const q = params.find(param => param.startsWith('q='));
    best = Math.max(best, q ? Number(q.slice(2)) || 0 : 1);
  }
  return best;
}

/** Whether a person's browser is opening this address as a page. */
export function isBrowserNavigation(request) {
  if ((request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') return false;
  const mode = request.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  const accept = request.headers.get('accept') ?? '';
  const html = acceptWeight(accept, 'text/html');
  return html > 0 && html > acceptWeight(accept, 'application/json');
}

const typeOf = response => (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
// Answers made of words a person could read: text, JSON, HTML, or nothing at all.
const WORD_TYPES = /^(text\/plain|text\/html|application\/json|application\/[a-z0-9.+-]*\+json)$/;

/** Whether this answer to this request must be replaced by a page. */
export function shouldBecomePage(request, response) {
  if (response.status < 400 || isShellPage(response)) return false;
  if (!isBrowserNavigation(request)) return false;
  if (/^\s*attachment/i.test(response.headers.get('content-disposition') ?? '')) return false;
  const type = typeOf(response);
  return type === '' || WORD_TYPES.test(type);
}

const LONGEST_WORDS = 300;
const looksLikeAStack = text => /\n\s+at\s/.test(text);

/** The plain words a route answered with, or null. HTML is never read for words; a stack trace is never shown. */
export async function routeWords(response) {
  const type = typeOf(response);
  if (type === 'text/html') return null;
  let text;
  try { text = await response.clone().text(); } catch { return null; }
  if (type.includes('json')) {
    try {
      const value = JSON.parse(text);
      text = [value?.error_description, value?.message, value?.error].find(item => typeof item === 'string' && item.trim()) ?? '';
    } catch { return null; }
  }
  if (looksLikeAStack(text)) return null;
  const words = text.trim().replace(/\s+/g, ' ');
  if (!words) return null;
  return words.length > LONGEST_WORDS ? `${words.slice(0, LONGEST_WORDS - 1).trimEnd()}…` : words;
}

/**
 * The answer that leaves the service. `pageFor({ status, words, request })` returns the page for this failure (a
 * Response drawn by the caller's shell); the answer keeps the route's own status and is marked as a shell page.
 */
export async function pageForBrowser(request, response, pageFor) {
  if (!shouldBecomePage(request, response)) return response;
  const page = await pageFor({ status: response.status, words: await routeWords(response), request });
  const headers = markShellPage(page.headers);
  // What the route said about how to retry or sign in still holds for the page that replaces it.
  for (const name of ['retry-after', 'www-authenticate', 'allow']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(request.method === 'HEAD' ? null : page.body, { status: response.status, headers });
}
