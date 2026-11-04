// Static recipient view: source bytes come from the existing installed-site/sharing owners.
// Read-only rendering cannot use account cookies, scripts, backend actions or external destinations.
import { publicAppFilePath } from './public-app-files.mjs';

export function sharedSiteAssetAddress(value, path, root, accessCode = null) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.startsWith('#')) return value;
  if (/^data:image\//i.test(value)) return value;
  const base = new URL(path, 'https://selected-site.invalid/');
  let url;
  try { url = new URL(value, base); } catch { return null; }
  if (url.origin !== base.origin || url.username || url.password) return null;
  let selected;
  try { selected = publicAppFilePath(url.pathname); } catch { return null; }
  const address = new URL(root + selected.split('/').map(encodeURIComponent).join('/'));
  address.search = url.search;
  if (accessCode) address.searchParams.set('access_code', accessCode);
  address.hash = url.hash;
  return address.href;
}
export function sharedSiteViewPolicy(root) {
  return `sandbox; default-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline' ${root}; img-src data: ${root}; font-src ${root}; media-src ${root}; frame-ancestors 'self'`;
}
export function sharedSiteCss(text, path, root, accessCode = null) {
  return text.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi, (_, quote, value) => {
    const address = sharedSiteAssetAddress(value.trim(), path, root, accessCode);
    return address ? `url("${address}")` : 'url("")';
  }).replace(/@import\s+(["'])([^"']+)\1/gi, (_, quote, value) => {
    const address = sharedSiteAssetAddress(value, path, root, accessCode);
    return address ? `@import "${address}"` : '@import ""';
  });
}
export function sharedSiteViewResponse(request, file, root, Rewriter = globalThis.HTMLRewriter) {
  const url = new URL(request.url);
  const source = url.searchParams.get('format') === 'source';
  const accessCode = url.searchParams.get('access_code');
  const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow',
    'content-security-policy': sharedSiteViewPolicy(root) };
  const media = String(file.media_type ?? '').split(';')[0];
  const bytes = file.bytes;
  if (!(bytes instanceof Uint8Array)) throw new Error('This shared site file has no complete bytes.');
  if (source) return new Response(bytes, { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
  headers['content-type'] = file.media_type;
  if (media === 'text/css') return new Response(sharedSiteCss(new TextDecoder().decode(bytes), file.path, root, accessCode), { headers });
  if (media !== 'text/html') return new Response(bytes, { headers });
  if (typeof Rewriter !== 'function') throw new Error('The static site view renderer is unavailable.');
  let styleWords = '';
  const rewrite = new Rewriter()
    .on('script,iframe,object,embed,base,form,meta[http-equiv]', { element: element => element.remove() })
    .on('*', { element(element) {
      for (const [name] of element.attributes) if (/^on/i.test(name) || ['target', 'ping', 'formaction', 'srcset'].includes(name)) element.removeAttribute(name);
      if (element.tagName === 'link' && element.getAttribute('rel') !== 'stylesheet') { element.remove(); return; }
      for (const attribute of ['src', 'href', 'poster']) {
        const value = element.getAttribute(attribute);
        if (value === null) continue;
        const address = sharedSiteAssetAddress(value, file.path, root, accessCode);
        if (address) element.setAttribute(attribute, address); else element.removeAttribute(attribute);
      }
      const style = element.getAttribute('style');
      if (style !== null) element.setAttribute('style', sharedSiteCss(style, file.path, root, accessCode));
    } })
    .on('style', { text(chunk) {
      styleWords += chunk.text;
      if (chunk.lastInTextNode) { chunk.replace(sharedSiteCss(styleWords, file.path, root, accessCode)); styleWords = ''; }
      else chunk.remove();
    } });
  return rewrite.transform(new Response(bytes, { headers }));
}
