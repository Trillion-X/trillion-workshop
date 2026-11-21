// The sign-in pages' answers, read from pages/routes.json: which sections answer a GET of an address (first match wins) inside the
// one shared shell (pages/shell.html), the script assets under assets_path, and the headers every page answer carries (its
// content security policy).
import { readFileSync } from 'node:fs';
import { readSettings } from './settings.mjs';

const pages = new URL('./pages/', import.meta.url);
export const table = JSON.parse(readFileSync(new URL('routes.json', pages), 'utf8'));
const shell = readFileSync(new URL('shell.html', pages), 'utf8');
// What pages say that is not theirs to know comes from settings: {{minutes}} is how long a code works, and the site block (settings.site)
// says whose sign-in this is: {{name}}, {{cli}}, {{storage_prefix}}, the theme, {{site_mark}} (the mark's picture, or nothing),
// {{site_head}} (link-preview words, head links) and {{site_look_css}} (the theme's tokens).
const { settings } = readSettings();
const { site } = settings;
const escapedText = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attribute = values => Object.entries(values).filter(([, value]) => value != null).map(([key, value]) => ` ${key}="${escapedText(value)}"`).join('');
const meta = (key, value, kind = 'name') => `<meta ${kind}="${key}" content="${escapedText(value)}"/>`;
const headOf = () => [
  ...(site.share ? [meta('og:type', 'website', 'property'), meta('og:site_name', site.name, 'property'), meta('og:title', site.share.title, 'property'),
    meta('og:description', site.share.description, 'property'), meta('twitter:card', 'summary'), meta('twitter:title', site.share.title), meta('twitter:description', site.share.description)] : []),
  ...site.links.map(link => `<link${attribute(link)}/>`),
].join('');
const markOf = () => (site.mark_svg ? `<img class="page-mark" src="${table.assets_path}mark.svg" alt="${escapedText(site.name)}" width="64" height="64" decoding="async"/>` : '');
const values = {
  minutes: String(settings.email_code.expires_in_seconds / 60),
  name: escapedText(site.name), cli: escapedText(site.cli), storage_prefix: escapedText(site.storage_prefix),
  theme: escapedText(site.theme.data_theme), scheme: escapedText(site.theme.scheme), theme_color: escapedText(site.theme.theme_color),
  site_mark: markOf(), site_head: headOf(), site_look_css: site.look_css,
};
const drawn = text => text.replace(/\{\{(\w+)\}\}/g, (gap, key) => values[key] ?? gap);
const escaped = escapedText;

// A policy page (routes.json `policy`) is the site's own words, settings.site.policy[name]: a title, a description and sections
// of heading and body. Each body is paragraphs split by a blank line. A site without those words gets no such page.
const policyOf = name => {
  const policy = site.policy?.[name];
  return policy && typeof policy.title === 'string' && typeof policy.description === 'string' && Array.isArray(policy.sections) ? policy : null;
};
const policySections = policy => `<section class="page-section"><h1 class="page-heading">${escaped(policy.title)}</h1>${policy.sections.map(({ heading, body }) => `<h2 class="page-item-heading">${escaped(heading)}</h2>${String(body).split(/\n\s*\n/).map(paragraph => `<p class="page-body">${escaped(paragraph.trim())}</p>`).join('')}`).join('')}</section>`
  + '<section class="page-section page-section--fine"><div class="page-actions"><a class="page-action page-action--link" href="/sign-in">Back to sign in</a></div></section>';

/** The page for a GET of `url` as bytes, or null: the shell with the matching route's title, description and sections. */
export function pageOf(url) {
  const { pathname, searchParams } = new URL(url, 'http://page');
  const route = table.routes.find(({ path, query = {} }) => path === pathname
    && Object.entries(query).every(([key, value]) => searchParams.has(key) && (value === '*' || searchParams.get(key) === value)));
  if (!route || route.redirect) return null;
  const policy = route.policy ? policyOf(route.policy) : null;
  if (route.policy && !policy) return null;
  const title = policy ? policy.title : route.title;
  const description = policy ? policy.description : route.description;
  const sections = policy ? policySections(policy) : route.sections.map(name => readFileSync(new URL(`sections/${name}.html`, pages), 'utf8')).join('');
  return Buffer.from(drawn(shell.replace('{{title}}', () => escaped(title)).replace('{{description}}', () => escaped(description)).replace('{{sections}}', () => sections)));
}

/** An asset under assets_path, by its plain file name only, or null. */
export function assetOf(url) {
  const { pathname } = new URL(url, 'http://page');
  if (!pathname.startsWith(table.assets_path)) return null;
  const name = pathname.slice(table.assets_path.length);
  if (!/^[a-z0-9-]+\.(js|svg|png|json)$/.test(name)) return null;
  // The site's own pictures come from its block, never from this tool's files.
  if (name === 'mark.svg') return site.mark_svg ? Buffer.from(site.mark_svg) : null;
  if (name === 'wordmark.png') return site.wordmark_png ? Buffer.from(site.wordmark_png, 'base64') : null;
  // What a native app shows of the site before anyone signs in: its name, link-preview words, theme and mark address, so
  // the app's words and mark change with this block, never with a copy built into the app.
  if (name === 'brand.json') return Buffer.from(JSON.stringify({ name: site.name, share: site.share ?? null, theme: site.theme,
    mark: site.mark_svg ? `${table.assets_path}mark.svg` : null }));
  try { return readFileSync(new URL(`${table.assets}/${name}`, pages)); } catch { return null; }
}

const assetType = path => (path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png'
  : path.endsWith('.json') ? 'application/json' : 'text/javascript; charset=utf-8');

/** The answer for a GET or HEAD of `url` that is a page or an asset: { status, headers, body }, or null. */
export function pageAnswer(url) {
  const sent = table.routes.find(({ path, redirect }) => redirect && path === new URL(url, 'http://page').pathname);
  if (sent) return { status: 301, headers: { location: sent.redirect, 'cache-control': 'no-store' }, body: '' };
  const asset = assetOf(url);
  if (asset) return { status: 200, headers: { 'content-type': assetType(url.split('?')[0]), 'cache-control': 'no-cache' }, body: asset };
  const page = pageOf(url);
  if (page) return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...table.headers }, body: page };
  return null;
}
