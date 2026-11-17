// The sign-in pages' answers, read from pages/routes.json: which sections answer a GET of an address (first match wins) inside the
// one shared shell (pages/shell.html), the script assets under assets_path, and the headers every page answer carries (its
// content security policy).
import { readFileSync } from 'node:fs';

const pages = new URL('./pages/', import.meta.url);
export const table = JSON.parse(readFileSync(new URL('routes.json', pages), 'utf8'));
const shell = readFileSync(new URL('shell.html', pages), 'utf8');
const escaped = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page for a GET of `url` as bytes, or null: the shell with the matching route's title, description and sections. */
export function pageOf(url) {
  const { pathname, searchParams } = new URL(url, 'http://page');
  const route = table.routes.find(({ path, query = {} }) => path === pathname
    && Object.entries(query).every(([key, value]) => searchParams.has(key) && (value === '*' || searchParams.get(key) === value)));
  if (!route) return null;
  const sections = route.sections.map(name => readFileSync(new URL(`sections/${name}.html`, pages), 'utf8')).join('');
  return Buffer.from(shell.replace('{{title}}', () => escaped(route.title)).replace('{{description}}', () => escaped(route.description)).replace('{{sections}}', () => sections));
}

/** An asset under assets_path, by its plain file name only, or null. */
export function assetOf(url) {
  const { pathname } = new URL(url, 'http://page');
  if (!pathname.startsWith(table.assets_path)) return null;
  const name = pathname.slice(table.assets_path.length);
  if (!/^[a-z0-9-]+\.js$/.test(name)) return null;
  try { return readFileSync(new URL(`${table.assets}/${name}`, pages)); } catch { return null; }
}

/** The answer for a GET or HEAD of `url` that is a page or an asset: { status, headers, body }, or null. */
export function pageAnswer(url) {
  const asset = assetOf(url);
  if (asset) return { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }, body: asset };
  const page = pageOf(url);
  if (page) return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...table.headers }, body: page };
  return null;
}
