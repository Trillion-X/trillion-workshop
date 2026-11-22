// tools/serve-articles-and-signup/do-work/pursuit-site.mjs
//
// Articles and a double opt-in newsletter signup for one pursuit's site, drawn at request time from the pursuit's own Postgres
// rows: the `articles` table (one row is one article; its slug is its address) and the `subscribers` table (the newsletter kit's
// shape: text times, tags as JSON text, consent provenance). Any Node server runs it: the site's server hands each request whose
// path is one of these routes to `createSite(...).handle` and every other request to its own program. It holds no database login
// and no mail key: the caller passes `db` (a query function) and `mail` (a send function), so the login and the key stay with the
// program that holds them.
//
// Every page is drawn by the document-page part (tools/ui/show/document-page), which writes the body and its links. The search head
// (title, description, canonical, robots, Open Graph, Twitter card, JSON-LD) is written only by withSearchHead
// (tools/publish-content-for-discovery), over the page document-page drew. A site's own draw hooks (`draw`) replace both.
//
// Invariants:
//   - Only `published` articles whose published_at has come appear in the index, the feed or the article's address; a
//     `draft` answers 404 unless its address carries the preview token the owner's own AI makes (previewToken).
//   - Nobody is sent anything but the confirmation mail until they click its link (double opt-in). The confirmation
//     link carries a random token; only its keyed digest is stored.
//   - An unsubscribe link carries a keyed digest of the subscriber id, so one click ends that subscription and no other.
//   - Consent provenance is stored as given (the exact wording shown, the page, the time, a digest of the IP, never the IP).
//   - Article bodies are markdown drawn by document-page: raw HTML in a row is shown as text, and a link is written only to
//     an http(s) or same-site address.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { documentPageHtml } from '../../ui/show/document-page/document-page-html.mjs';
import { withSearchHead } from '../../publish-content-for-discovery/do-work/site-search-head.mjs';

const EMAIL_SHAPE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const SIGNUPS_PER_NETWORK_PER_HOUR = 5;
const CONFIRM_HOURS = 72;
const TOKEN_NAME = /^[a-z][a-z0-9-]*$/;
const DESCRIPTION_CHARS = 155;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nowIso = () => new Date().toISOString();
const isHttpsAddress = (value) => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };

// The description of a row that has none: the body's first sentence (its headings and markdown marks left out), at most DESCRIPTION_CHARS
// characters cut on a word boundary. The title only when the body is empty, since the body's opening describes the page.
export function descriptionOf(row) {
  if (row.description) return row.description;
  const text = String(row.body_markdown ?? '').replace(/^#.*$/gm, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~>]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return row.title;
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  if (sentence.length <= DESCRIPTION_CHARS) return sentence;
  const cut = sentence.slice(0, DESCRIPTION_CHARS + 1);
  const at = cut.lastIndexOf(' ');
  return at > 0 ? cut.slice(0, at).replace(/[\s,;:]+$/, '') : sentence.slice(0, DESCRIPTION_CHARS);
}

// The token aliases a site names its own way: { 'button-bg': 'button-primary-bg' } writes --button-bg as an alias of the site's
// --button-primary-bg, the role token document-page reads. Only token names are written here, never a colour value.
function tokenAliasesHtml(tokens) {
  const pairs = Object.entries(tokens);
  if (pairs.some(([role, own]) => !TOKEN_NAME.test(role) || !TOKEN_NAME.test(own))) {
    throw new TypeError('tokens maps document-page role tokens to the site\'s token names: lower-case words with dashes, such as { "button-bg": "button-primary-bg" }.');
  }
  return pairs.length ? `<style>:root{${pairs.map(([role, own]) => `--${role}:var(--${own});`).join('')}}</style>` : '';
}

/** An escaped paragraph's [words](https://address) links as anchors: only http and https, so a row never writes a script link. */
const links = (escaped) => escaped.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (all, words, href) => `<a href="${href}">${words}</a>`);

/** The HTML of a body: blank-line paragraphs with their links, `#`/`##` headings, everything else escaped. */
export function bodyHtml(markdown) {
  return String(markdown ?? '').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).map((block) => {
    if (block.startsWith('## ')) return `<h2>${esc(block.slice(3))}</h2>`;
    if (block.startsWith('# ')) return `<h1>${esc(block.slice(2))}</h1>`;
    return `<p>${links(esc(block)).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
}

export function createSite({ db, mail, origin, brand, secret, signupText, layout = null, stylesheets = [], themeAttributes = {}, tokens = {}, author = null, now = nowIso, draw = null }) {
  if (!secret || secret.length < 32) throw new Error('createSite needs a secret of at least 32 characters (the caller holds it).');
  const keyed = (purpose, value) => createHmac('sha256', secret).update(`${purpose}\n${value}`).digest('base64url');
  const absolute = (path) => new URL(path, origin).toString();
  const tokenStyle = tokenAliasesHtml(tokens);

  const previewToken = (slug) => keyed('preview', slug);
  const unsubscribeLink = (id) => absolute(`/unsubscribe?s=${encodeURIComponent(id)}&t=${keyed('unsubscribe', id)}`);

  // A page with its search head from withSearchHead, the one writer of that head. A site that passes `layout` gets its bare markup
  // (`bare()`) wrapped in its own layout, as it always was; a site that does not gets document-page, whose own head facts are left
  // empty here so withSearchHead's head is the only one the page carries.
  function drawn({ head, status = 200, article = null, blocks = [], bare = null }) {
    const html = layout
      ? layout({ title: head.title, description: head.description, body: bare() })
      : documentPageHtml({ lang: 'en', theme_attributes: themeAttributes, stylesheets, header: { brand: { name: brand, href: '/' } }, article, blocks }).replace('</head>', `${tokenStyle}</head>`);
    return new Response(withSearchHead(html, head), {
      status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  // A page of this site that is not an article: kept out of search, with its own address as canonical.
  function utility(path, { heading, text = '', description = text || heading, status = 200, bare = () => `<h1>${esc(heading)}</h1>${text ? `<p>${esc(text)}</p>` : ''}` }) {
    return drawn({
      status,
      head: { title: `${heading} | ${brand}`, description, canonical: absolute(path), robots: 'noindex, nofollow' },
      article: { title: heading, markdown: text },
      bare,
    });
  }

  function htmlPage(html, status = 200) {
    return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }

  async function listedRows() {
    return db(`SELECT slug, title, description, body_markdown, picture, keywords, status, canonical, published_at, updated_at, listed, category, image, course_slug, sources, related, short_version, sections
      FROM articles WHERE status = 'published' AND listed IS DISTINCT FROM false AND (published_at IS NULL OR published_at <= $1) ORDER BY published_at DESC NULLS LAST`, [now()]);
  }

  async function articleIndex() {
    const rows = await listedRows();
    if (draw) return htmlPage(draw.index(rows));
    return drawn({
      head: { title: `Articles | ${brand}`, description: 'Articles', canonical: absolute('/articles'), og: { type: 'website', title: 'Articles', description: 'Articles', site_name: brand }, twitter: { card: 'summary' } },
      article: { title: 'Articles', markdown: '' },
      blocks: [
        { id: 'articles', links: rows.map((row) => ({ title: row.title, href: `/articles/${encodeURIComponent(row.slug)}`, detail: row.description })) },
        signupBlock('/articles'),
      ],
      bare: () => {
        const items = rows.map((row) => `<li><a href="/articles/${encodeURIComponent(row.slug)}"><strong>${esc(row.title)}</strong></a>
      <p>${esc(row.description)}</p></li>`).join('\n');
        return `<h1>Articles</h1>\n<ul>\n${items}\n</ul>\n${signupForm('/articles')}`;
      },
    });
  }

  async function articlePage(slug, url) {
    const [row] = await db(`SELECT slug, title, description, body_markdown, picture, keywords, status, canonical, published_at, updated_at, listed, category, image, course_slug, sources, related, short_version, sections
      FROM articles WHERE slug = $1`, [slug]);
    const path = `/articles/${encodeURIComponent(slug)}`;
    if (!row) return utility(path, { heading: 'Not found', status: 404 });
    const preview = url.searchParams.get('preview');
    const shown = row.status === 'published' && (!row.published_at || new Date(row.published_at) <= new Date(now()));
    if (!shown && preview !== previewToken(slug)) return utility(path, { heading: 'Not found', status: 404 });
    if (draw) return htmlPage(draw.article(row, { preview: !shown }));
    return drawn({
      head: articleHead(row, url.pathname),
      article: { title: row.title, markdown: row.body_markdown ?? '' },
      blocks: [signupBlock(`/articles/${slug}`)],
      bare: () => `<article>\n<h1>${esc(row.title)}</h1>\n${bodyHtml(row.body_markdown)}\n</article>\n${signupForm(`/articles/${slug}`)}`,
    });
  }

  // The article's search head: its canonical is the row's own canonical (the home copy of a cross-posted article, per the rule row
  // canonical-of-a-cross-posted-article), else this page. Open Graph and the JSON-LD Article take the row's words and dates; the
  // author is the site's, given at createSite.
  function articleHead(row, pathname) {
    const self = absolute(pathname);
    const canonical = isHttpsAddress(row.canonical) ? row.canonical : self;
    const description = descriptionOf(row);
    const picture = row.picture ? absolute(row.picture) : null;
    const published = row.published_at ? new Date(row.published_at).toISOString() : null;
    const updated = row.updated_at ? new Date(row.updated_at).toISOString() : published;
    const jsonld = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: row.title,
      description,
      mainEntityOfPage: self,
      url: self,
      publisher: { '@type': 'Organization', name: brand },
      ...(author ? { author: { '@type': 'Person', name: author } } : {}),
      ...(published ? { datePublished: published } : {}),
      ...(updated ? { dateModified: updated } : {}),
      ...(picture ? { image: picture } : {}),
      ...(row.keywords ? { keywords: row.keywords } : {}),
    };
    return {
      title: `${row.title} | ${brand}`,
      description,
      canonical,
      og: { type: 'article', title: row.title, description, site_name: brand, ...(picture ? { image: picture } : {}) },
      twitter: { card: picture ? 'summary_large_image' : 'summary' },
      jsonld: [jsonld],
    };
  }

  async function feed() {
    const rows = await listedRows();
    const items = rows.map((row) => `<item><title>${esc(row.title)}</title><link>${esc(absolute(`/articles/${row.slug}`))}</link>
      <guid>${esc(absolute(`/articles/${row.slug}`))}</guid><description>${esc(row.description)}</description>
      <pubDate>${new Date(row.published_at ?? row.updated_at).toUTCString()}</pubDate></item>`).join('\n');
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${esc(brand)}</title>\n<link>${esc(origin)}</link>\n${items}\n</channel></rss>\n`,
      { headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=300' } });
  }

  // The signup as bare markup, for a site's own layout.
  function signupForm(source) {
    return `<form method="post" action="/subscribe" class="signup">
  <input type="hidden" name="source" value="${esc(source)}">
  <label>${esc(signupText.label)} <input type="email" name="email" required autocomplete="email"></label>
  <p>${esc(signupText.consent)}</p>
  <button type="submit">${esc(signupText.button)}</button>
</form>`;
  }

  // The signup is a form block: document-page writes the field labels, the consent wording and the button.
  function signupBlock(source) {
    return {
      id: 'signup',
      form: {
        action: '/subscribe',
        submit_label: signupText.button,
        note: signupText.consent,
        fields: [
          { name: 'source', kind: 'hidden', value: source },
          { name: 'email', kind: 'email', label: signupText.label, required: true, autocomplete: 'email' },
        ],
      },
    };
  }

  async function subscribe(request) {
    const type = request.headers.get('content-type') ?? '';
    const form = type.includes('application/json') ? await request.json() : Object.fromEntries(await request.formData());
    const email = String(form.email ?? '').trim().toLowerCase();
    const source = String(form.source ?? '').startsWith('/') ? String(form.source).slice(0, 200) : '/';
    if (!EMAIL_SHAPE.test(email) || email.length > 254) return utility('/subscribe', { heading: 'That address does not look right', status: 400 });
    const network = keyed('network', request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown');
    const since = new Date(Date.now() - 3600_000).toISOString();
    const [{ n }] = await db(`SELECT count(*)::int AS n FROM subscribers WHERE network_digest = $1 AND confirm_sent_at > $2`, [network, since]);
    if (n >= SIGNUPS_PER_NETWORK_PER_HOUR) return utility('/subscribe', { heading: 'Too many sign-ups from here', status: 429 });
    const [existing] = await db('SELECT * FROM subscribers WHERE email = $1', [email]);
    if (existing?.status === 'confirmed' || existing?.status === 'suppressed') return checkInbox(source);
    const id = existing?.id ?? randomUUID();
    const token = randomBytes(24).toString('base64url');
    const at = now();
    const consent = { text: signupText.consent, at, page: source, ip: keyed('ip', request.headers.get('cf-connecting-ip') ?? 'unknown') };
    if (existing) {
      await db(`UPDATE subscribers SET status = 'pending', confirm_digest = $1, confirm_sent_at = $2, source_path = $3, network_digest = $4,
        confirmed_at = NULL, ended_at = NULL, ended_reason = NULL, consent_text = $5, consent_at = $6, consent_page = $7, consent_ip_digest = $8 WHERE id = $9`,
      [keyed('confirm', `${id}:${token}`), at, source, network, consent.text, consent.at, consent.page, consent.ip, id]);
    } else {
      await db(`INSERT INTO subscribers (id, email, status, confirm_digest, confirm_sent_at, source_path, network_digest, created_at, tags,
        consent_text, consent_at, consent_page, consent_ip_digest) VALUES ($1, $2, 'pending', $3, $4, $5, $6, $4, '[]', $7, $8, $9, $10)`,
      [id, email, keyed('confirm', `${id}:${token}`), at, source, network, consent.text, consent.at, consent.page, consent.ip]);
    }
    const link = absolute(`/subscribe/confirm?s=${encodeURIComponent(id)}&t=${token}`);
    try {
      await mail({ to: email, subject: signupText.confirm.subject, text: `${signupText.confirm.body}\n\n${link}`,
        html: `<p>${esc(signupText.confirm.body)}</p><p><a href="${esc(link)}">${esc(signupText.confirm.button)}</a></p>` });
    } catch (error) {
      await db('UPDATE subscribers SET confirm_sent_at = NULL WHERE id = $1', [id]);
      console.error('confirmation send failed', error?.code ?? '', error?.message ?? '');
      return utility('/subscribe', { heading: 'We could not send the email. Try again later.', status: 502 });
    }
    return checkInbox(source);
  }

  function checkInbox(source) {
    return utility('/subscribe', {
      heading: 'Check your inbox',
      text: `We sent a link. Click it to confirm.\n\n[Back](${source})`,
      description: 'We sent a link. Click it to confirm.',
      bare: () => `<h1>Check your inbox</h1><p>We sent a link. Click it to confirm.</p><a href="${esc(source)}">Back</a>`,
    });
  }

  async function confirm(url) {
    const id = url.searchParams.get('s') ?? '';
    const token = url.searchParams.get('t') ?? '';
    const [row] = await db('SELECT * FROM subscribers WHERE id = $1', [id]);
    if (row?.status === 'confirmed') return utility('/subscribe/confirm', { heading: 'You are already subscribed' });
    const fresh = row && Date.now() - Date.parse(row.confirm_sent_at) < CONFIRM_HOURS * 3600_000;
    if (!(row?.status === 'pending' && fresh && row.confirm_digest === keyed('confirm', `${id}:${token}`))) {
      return utility('/subscribe/confirm', { heading: 'This link is no longer valid', text: 'Sign up again to get a new one.', status: 400 });
    }
    await db(`UPDATE subscribers SET status = 'confirmed', confirmed_at = $1, confirm_digest = NULL WHERE id = $2`, [now(), id]);
    return utility('/subscribe/confirm', { heading: 'You are subscribed', text: 'Thank you.' });
  }

  async function unsubscribe(request, url) {
    const id = url.searchParams.get('s') ?? '';
    const token = url.searchParams.get('t') ?? '';
    const [row] = await db('SELECT id, status FROM subscribers WHERE id = $1', [id]);
    if (!row || token !== keyed('unsubscribe', id)) return utility('/unsubscribe', { heading: 'This link is not valid', status: 400 });
    if (row.status === 'confirmed' || row.status === 'pending') {
      await db(`UPDATE subscribers SET status = 'unsubscribed', ended_at = $1, ended_reason = $2 WHERE id = $3`,
        [now(), request.method === 'POST' ? 'one-click' : 'link', id]);
    }
    if (request.method === 'POST') return new Response(null, { status: 200 });
    return utility('/unsubscribe', { heading: 'You are unsubscribed' });
  }

  // The routes that only read: the index, the feed and one article. null for any other path.
  function readRoute(path, url) {
    if (path === '/articles' || path === '/articles/') return articleIndex();
    if (path === '/articles/rss.xml') return feed();
    if (path.startsWith('/articles/') && path.split('/').length === 3) return articlePage(decodeURIComponent(path.slice('/articles/'.length)), url);
    return null;
  }

  return {
    previewToken,
    unsubscribeLink,
    /** Answers a request for one of this site's routes, or null for a path it does not serve. */
    async handle(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (request.method === 'GET' || request.method === 'HEAD') {
        const answer = readRoute(path, url);
        // HEAD is answered as GET is, with the same status and headers and no body.
        if (answer) return request.method === 'GET' ? answer : answer.then((full) => new Response(null, { status: full.status, headers: full.headers }));
      }
      if (request.method === 'POST' && path === '/subscribe') return subscribe(request);
      if (request.method === 'GET' && path === '/subscribe/confirm') return confirm(url);
      if ((request.method === 'GET' || request.method === 'POST') && path === '/unsubscribe') return unsubscribe(request, url);
      return null;
    },
  };
}
