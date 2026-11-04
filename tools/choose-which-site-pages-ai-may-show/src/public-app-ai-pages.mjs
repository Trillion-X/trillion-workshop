// Public AI page access is derived from the current site's files. The maker can edit or remove
// .well-known/trillion-ai.json through the same saved-source/draft/publish owner as any other file.
// This excludes pages from Trillion's AI tools and llms.txt; the web pages remain public.
import settings from './public-app-ai-app.json' with { type: 'json' };
import { publicAppFilePath } from '../../shared-code/src/public-app-files.mjs';
import { extractPage } from '../../browse-public-page/do-work/page-facts.mjs';

export async function pageStart(stream, max, { strict = false } = {}) {
  if (!stream) return '';
  const reader = stream.getReader();const chunks = [];let size = 0;
  try {
    while (size <= max) {
      const { done, value } = await reader.read();if (done) break;
      size += value.byteLength;
      if (strict && size > max) throw new Error(settings.words.policy_invalid);
      chunks.push(value.subarray(0, Math.max(0, max - (size - value.byteLength))));
      if (size >= max && !strict) break;
    }
  } finally { await reader.cancel().catch(() => {});reader.releaseLock(); }
  return new Blob(chunks).text();
}
const mediaOf = value => String(value ?? '').split(';')[0].trim().toLowerCase();
const addressOf = path => path === 'index.html' ? '/' : path.endsWith('/index.html') ? `/${path.slice(0, -10)}` : `/${path}`;
export function aiPageCatalog({ pages, origin }) {
  let policy;
  const excluded = () => policy ??= (async () => {
    const stream = await pages.open(settings.pages.policy_file);
    if (!stream) return new Set();
    let data;
    try { data = JSON.parse(await pageStart(stream, settings.pages.policy_bytes, { strict: true })); }
    catch { throw new Error(settings.words.policy_invalid); }
    if (!data || Array.isArray(data) || Object.keys(data).some(key => key !== 'exclude') || !Array.isArray(data.exclude) ||
        data.exclude.length > settings.pages.max_excluded || data.exclude.some(path => typeof path !== 'string' || publicAppFilePath(path) !== path)) {
      throw new Error(settings.words.policy_invalid);
    }
    return new Set(data.exclude);
  })();
  const allowed = async url => {
    if (url.origin !== origin) return false;
    let path;try { path = publicAppFilePath(url.pathname); } catch { return false; }
    return !(await excluded()).has(path);
  };
  const list = async ({ after = null, limit = settings.pages.max_pages } = {}) => {
    const hidden = await excluded();const found = [];let last = after;let more = false;
    scan: for (let reads = 0; reads < settings.pages.max_listing_reads; reads++) {
      const batch = await pages.list({ cursor: after, limit: 100 });
      for (const [index, row] of batch.rows.entries()) {
        last = row.path;
        if (!settings.pages.media_types.includes(mediaOf(row.media_type)) || hidden.has(row.path) ||
            settings.pages.not_pages.some(prefix => row.path.startsWith(prefix)) || row.path === settings.pages.llms_path.slice(1)) continue;
        const url = new URL(addressOf(row.path), `${origin}/`);
        const head = await pageStart(await pages.open(row.path), settings.pages.title_bytes);
        found.push({ address: url.href, title: (head ? extractPage(head, url.href).title : '') || url.pathname });
        if (found.length >= limit) { more = index < batch.rows.length - 1 || batch.cursor !== null;break scan; }
      }
      more = batch.cursor !== null;if (!more) break;after = batch.cursor;
    }
    return { pages: found, more_after: more ? last : null };
  };
  return { allowed, list };
}
export async function answerSiteLlms(request, { pages, origin, name }) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const after = new URL(request.url).searchParams.get('after');
  const result = await aiPageCatalog({ pages, origin }).list({ after });
  const clean = text => String(text).replace(/[\r\n\[\]]/g, ' ');
  const lines = [`# ${clean(name)}`, '', `> Public pages of ${origin}/`, '', '## Pages', '',
    ...result.pages.map(page => `- [${clean(page.title)}](${page.address})`)];
  if (result.more_after) lines.push('', `- [More pages](${origin}${settings.pages.llms_path}?after=${encodeURIComponent(result.more_after)})`);
  return new Response(request.method === 'HEAD' ? null : lines.join('\n')+'\n', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
