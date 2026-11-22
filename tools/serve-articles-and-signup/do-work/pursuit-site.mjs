// tools/serve-articles-and-signup/do-work/pursuit-site.mjs
//
// Articles and a double opt-in newsletter signup for one pursuit's site, drawn at request time from the pursuit's own
// Postgres rows: the `articles` table (one row is one article; its slug is its address) and the `subscribers` table
// (the newsletter kit's shape: text times, tags as JSON text, consent provenance). Any Node server runs it: the site's
// server hands each request whose path is one of these routes to `handleSiteRequest` and every other request to its own
// program. It holds no database login and no mail key: the caller passes `db` (a query function) and `mail` (a send
// function), so the login and the key stay with the program that holds them.
//
// Invariants:
//   - Only `published` articles whose published_at has come appear in the index, the feed or the article's address; a
//     `draft` answers 404 unless its address carries the preview token the owner's own AI makes (previewToken).
//   - Nobody is sent anything but the confirmation mail until they click its link (double opt-in). The confirmation
//     link carries a random token; only its keyed digest is stored.
//   - An unsubscribe link carries a keyed digest of the subscriber id, so one click ends that subscription and no other.
//   - Consent provenance is stored as given (the exact wording shown, the page, the time, a digest of the IP, never the IP).
//   - Article bodies are escaped; no raw HTML from a row is ever written into a page.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { withSearchHead } from '../../publish-content-for-discovery/do-work/site-search-head.mjs';

const EMAIL_SHAPE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const SIGNUPS_PER_NETWORK_PER_HOUR = 5;
const CONFIRM_HOURS = 72;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nowIso = () => new Date().toISOString();
const isHttpsAddress = (value) => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };
const json = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };

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

export function createSite({ db, mail, origin, brand, secret, layout, signupText, author = null, now = nowIso, draw = null }) {
  if (!secret || secret.length < 32) throw new Error('createSite needs a secret of at least 32 characters (the caller holds it).');
  const keyed = (purpose, value) => createHmac('sha256', secret).update(`${purpose}\n${value}`).digest('base64url');
  const absolute = (path) => new URL(path, origin).toString();

  const previewToken = (slug) => keyed('preview', slug);
  const unsubscribeLink = (id) => absolute(`/unsubscribe?s=${encodeURIComponent(id)}&t=${keyed('unsubscribe', id)}`);

  function page({ title, body, status = 200, description = '', head = null }) {
    const html = layout({ title: `${title} | ${brand}`, description, body });
    return new Response(head ? withSearchHead(html, head) : html, {
      status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
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
    const items = rows.map((row) => `<li><a href="/articles/${encodeURIComponent(row.slug)}"><strong>${esc(row.title)}</strong></a>
      <p>${esc(row.description)}</p></li>`).join('\n');
    return page({ title: 'Articles', description: 'Articles', body: `<h1>Articles</h1>\n<ul>\n${items}\n</ul>\n${signupBlock('/articles')}` });
  }

  async function articlePage(slug, url) {
    const [row] = await db(`SELECT slug, title, description, body_markdown, picture, keywords, status, canonical, published_at, updated_at, listed, category, image, course_slug, sources, related, short_version, sections
      FROM articles WHERE slug = $1`, [slug]);
    if (!row) return page({ title: 'Not found', body: '<h1>Not found</h1>', status: 404 });
    const preview = url.searchParams.get('preview');
    const shown = row.status === 'published' && (!row.published_at || new Date(row.published_at) <= new Date(now()));
    if (!shown && preview !== previewToken(slug)) return page({ title: 'Not found', body: '<h1>Not found</h1>', status: 404 });
    if (draw) return htmlPage(draw.article(row, { preview: !shown }));
    const body = `<article>\n<h1>${esc(row.title)}</h1>\n${bodyHtml(row.body_markdown)}\n</article>\n${signupBlock(`/articles/${slug}`)}`;
    return page({ title: row.title, description: row.description, body, head: articleHead(row, url.pathname) });
  }

  // The article's search head: its canonical is the row's own canonical (the home copy of a cross-posted article, per the rule row
  // canonical-of-a-cross-posted-article), else this page. Open Graph and the JSON-LD Article take the row's words and dates; the
  // author is the site's, given at createSite. A row with no description gets no search head (the head needs a description).
  function articleHead(row, pathname) {
    if (!row.description) return null;
    const self = absolute(pathname);
    const canonical = isHttpsAddress(row.canonical) ? row.canonical : self;
    const picture = row.picture ? absolute(row.picture) : null;
    const published = row.published_at ? new Date(row.published_at).toISOString() : null;
    const updated = row.updated_at ? new Date(row.updated_at).toISOString() : published;
    const jsonld = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: row.title,
      description: row.description,
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
      description: row.description,
      canonical,
      og: { type: 'article', title: row.title, description: row.description, site_name: brand, ...(picture ? { image: picture } : {}) },
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

  function signupBlock(source) {
    return `<form method="post" action="/subscribe" class="signup">
  <input type="hidden" name="source" value="${esc(source)}">
  <label>${esc(signupText.label)} <input type="email" name="email" required autocomplete="email"></label>
  <p>${esc(signupText.consent)}</p>
  <button type="submit">${esc(signupText.button)}</button>
</form>`;
  }

  async function subscribe(request) {
    const type = request.headers.get('content-type') ?? '';
    const form = type.includes('application/json') ? await request.json() : Object.fromEntries(await request.formData());
    const email = String(form.email ?? '').trim().toLowerCase();
    const source = String(form.source ?? '').startsWith('/') ? String(form.source).slice(0, 200) : '/';
    if (!EMAIL_SHAPE.test(email) || email.length > 254) return page({ title: 'Not sent', body: '<h1>That address does not look right</h1>', status: 400 });
    const network = keyed('network', request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown');
    const since = new Date(Date.now() - 3600_000).toISOString();
    const [{ n }] = await db(`SELECT count(*)::int AS n FROM subscribers WHERE network_digest = $1 AND confirm_sent_at > $2`, [network, since]);
    if (n >= SIGNUPS_PER_NETWORK_PER_HOUR) return page({ title: 'Not sent', body: '<h1>Too many sign-ups from here</h1>', status: 429 });
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
      return page({ title: 'Not sent', body: '<h1>We could not send the email. Try again later.</h1>', status: 502 });
    }
    return checkInbox(source);
  }

  function checkInbox(source) {
    return page({ title: 'Check your inbox', body: `<h1>Check your inbox</h1><p>We sent a link. Click it to confirm.</p><a href="${esc(source)}">Back</a>` });
  }

  async function confirm(url) {
    const id = url.searchParams.get('s') ?? '';
    const token = url.searchParams.get('t') ?? '';
    const [row] = await db('SELECT * FROM subscribers WHERE id = $1', [id]);
    if (row?.status === 'confirmed') return page({ title: 'Already confirmed', body: '<h1>You are already subscribed</h1>' });
    const fresh = row && Date.now() - Date.parse(row.confirm_sent_at) < CONFIRM_HOURS * 3600_000;
    if (!(row?.status === 'pending' && fresh && row.confirm_digest === keyed('confirm', `${id}:${token}`))) {
      return page({ title: 'Link expired', body: '<h1>This link is no longer valid</h1><p>Sign up again to get a new one.</p>', status: 400 });
    }
    await db(`UPDATE subscribers SET status = 'confirmed', confirmed_at = $1, confirm_digest = NULL WHERE id = $2`, [now(), id]);
    return page({ title: 'Subscribed', body: '<h1>You are subscribed</h1><p>Thank you.</p>' });
  }

  async function unsubscribe(request, url) {
    const id = url.searchParams.get('s') ?? '';
    const token = url.searchParams.get('t') ?? '';
    const [row] = await db('SELECT id, status FROM subscribers WHERE id = $1', [id]);
    if (!row || token !== keyed('unsubscribe', id)) return page({ title: 'Link not valid', body: '<h1>This link is not valid</h1>', status: 400 });
    if (row.status === 'confirmed' || row.status === 'pending') {
      await db(`UPDATE subscribers SET status = 'unsubscribed', ended_at = $1, ended_reason = $2 WHERE id = $3`,
        [now(), request.method === 'POST' ? 'one-click' : 'link', id]);
    }
    if (request.method === 'POST') return new Response(null, { status: 200 });
    return page({ title: 'Unsubscribed', body: '<h1>You are unsubscribed</h1>' });
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
