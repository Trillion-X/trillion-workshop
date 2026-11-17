// The sign-in pages' answers, read from pages/routes.json: which sections answer a GET of an address (first match wins) inside the
// one shared shell (pages/shell.html), the script assets under assets_path, and the headers every page answer carries (its
// content security policy).
import { readFileSync } from 'node:fs';
import { readSettings } from './settings.mjs';

const pages = new URL('./pages/', import.meta.url);
export const table = JSON.parse(readFileSync(new URL('routes.json', pages), 'utf8'));
const shell = readFileSync(new URL('shell.html', pages), 'utf8');
// What pages say that is not theirs to know comes from settings: {{minutes}} is how long a code works, and the brand block (settings.brand)
// says whose sign-in this is: {{name}}, {{cli}}, {{storage_prefix}}, the theme, {{brand_mark}} (the mark's picture, or nothing),
// {{brand_head}} (link-preview words, head links) and {{brand_look_css}} (the theme's tokens).
const { settings } = readSettings();
const { brand } = settings;
const escapedText = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attribute = values => Object.entries(values).filter(([, value]) => value != null).map(([key, value]) => ` ${key}="${escapedText(value)}"`).join('');
const meta = (key, value, kind = 'name') => `<meta ${kind}="${key}" content="${escapedText(value)}"/>`;
const headOf = () => [
  ...(brand.share ? [meta('og:type', 'website', 'property'), meta('og:site_name', brand.name, 'property'), meta('og:title', brand.share.title, 'property'),
    meta('og:description', brand.share.description, 'property'), meta('twitter:card', 'summary'), meta('twitter:title', brand.share.title), meta('twitter:description', brand.share.description)] : []),
  ...brand.links.map(link => `<link${attribute(link)}/>`),
].join('');
const markOf = () => (brand.mark_svg ? `<img class="page-mark" src="${table.assets_path}mark.svg" alt="${escapedText(brand.name)}" width="64" height="64" decoding="async"/>` : '');
const values = {
  minutes: String(settings.email_code.expires_in_seconds / 60),
  name: escapedText(brand.name), cli: escapedText(brand.cli), storage_prefix: escapedText(brand.storage_prefix),
  theme: escapedText(brand.theme.data_theme), scheme: escapedText(brand.theme.scheme), theme_color: escapedText(brand.theme.theme_color),
  brand_mark: markOf(), brand_head: headOf(), brand_look_css: brand.look_css,
};
const drawn = text => text.replace(/\{\{(\w+)\}\}/g, (gap, key) => values[key] ?? gap);
const escaped = escapedText;

/** The page for a GET of `url` as bytes, or null: the shell with the matching route's title, description and sections. */
export function pageOf(url) {
  const { pathname, searchParams } = new URL(url, 'http://page');
  const route = table.routes.find(({ path, query = {} }) => path === pathname
    && Object.entries(query).every(([key, value]) => searchParams.has(key) && (value === '*' || searchParams.get(key) === value)));
  if (!route || route.redirect) return null;
  const sections = route.sections.map(name => readFileSync(new URL(`sections/${name}.html`, pages), 'utf8')).join('');
  return Buffer.from(drawn(shell.replace('{{title}}', () => escaped(route.title)).replace('{{description}}', () => escaped(route.description)).replace('{{sections}}', () => sections)));
}

/** An asset under assets_path, by its plain file name only, or null. */
export function assetOf(url) {
  const { pathname } = new URL(url, 'http://page');
  if (!pathname.startsWith(table.assets_path)) return null;
  const name = pathname.slice(table.assets_path.length);
  if (!/^[a-z0-9-]+\.(js|svg|png)$/.test(name)) return null;
  // The brand's own pictures come from its block, never from this tool's files.
  if (name === 'mark.svg') return brand.mark_svg ? Buffer.from(brand.mark_svg) : null;
  if (name === 'wordmark.png') return brand.wordmark_png ? Buffer.from(brand.wordmark_png, 'base64') : null;
  try { return readFileSync(new URL(`${table.assets}/${name}`, pages)); } catch { return null; }
}

const assetType = path => (path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : 'text/javascript; charset=utf-8');

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
