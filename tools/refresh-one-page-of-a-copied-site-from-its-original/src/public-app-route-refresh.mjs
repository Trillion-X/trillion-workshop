import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { MAX_PUBLIC_APP_BYTES, MAX_PUBLIC_APP_FILES, MAX_PUBLIC_APP_FILE_BYTES, publicAppFilePath, publicAppMediaType } from '../../shared-code/src/public-app-files.mjs';
import { sourcePreviewPageMatches, sourcePreviewTarget } from './source-project-preview.mjs';

const ASSET_EXTENSION = /\.(?:css|js|mjs|svg|png|jpe?g|webp|gif|avif|ico|woff2?|ttf|otf|mp3|mp4|pdf|json|webmanifest)(?:$|\?)/i;
const HASH = value => bytesToHex(blake3(new TextEncoder().encode(value)));

function decoded(value) {
  return value.replaceAll('&amp;', '&').replaceAll('&#38;', '&');
}

function refsIn(text, kind) {
  const refs = [];
  const add = (start, end, value, required = false) => refs.push({ start, end, value: decoded(value.trim()), required });
  if (kind === 'html') {
    const attribute = /\b(?:src|href|poster)\s*=\s*(["'])(.*?)\1/gi;
    for (const match of text.matchAll(attribute)) {
      const tagStart = text.lastIndexOf('<', match.index);
      const tagEnd = text.indexOf('>', match.index);
      const tag = tagStart >= 0 && tagEnd >= 0 ? text.slice(tagStart, tagEnd + 1) : '';
      const name = match[0].trim().split(/\s*=\s*/, 1)[0].toLowerCase();
      const required = name === 'src' || name === 'poster' || name === 'href' && /^<link\b/i.test(tag) && /\brel\s*=\s*(["'])[^"']*stylesheet[^"']*\1/i.test(tag);
      add(match.index + match[0].indexOf(match[2]), match.index + match[0].indexOf(match[2]) + match[2].length, match[2], required);
    }
    const srcset = /\bsrcset\s*=\s*(["'])(.*?)\1/gi;
    for (const match of text.matchAll(srcset)) {
      const start = match.index + match[0].indexOf(match[2]);
      let offset = 0;
      for (const candidate of match[2].split(',')) {
        const value = candidate.trim().split(/\s+/, 1)[0];
        const at = candidate.indexOf(value);
        if (value && at >= 0) add(start + offset + at, start + offset + at + value.length, value, true);
        offset += candidate.length + 1;
      }
    }
  } else if (kind === 'css') {
    const url = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
    for (const match of text.matchAll(url)) add(match.index + match[0].indexOf(match[2]), match.index + match[0].indexOf(match[2]) + match[2].length, match[2], true);
    const imported = /@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?/gi;
    for (const match of text.matchAll(imported)) {
      // url() references are already collected above. Replacing the same URL
      // twice with offsets from the original string would corrupt the CSS.
      if (/^@import\s+url\(/i.test(match[0])) continue;
      add(match.index + match[0].indexOf(match[2]), match.index + match[0].indexOf(match[2]) + match[2].length, match[2], true);
    }
  } else if (kind === 'js') {
    const string = /(["'`])((?:\.{1,2}\/|\/)?[^"'`\s]+\.(?:css|js|mjs|svg|png|jpe?g|webp|gif|avif|ico|woff2?|ttf|otf|mp3|mp4|json|webmanifest)(?:\?[^"'`\s]*)?(?:#[^"'`\s]*)?)\1/g;
    for (const match of text.matchAll(string)) add(match.index + match[0].indexOf(match[2]), match.index + match[0].indexOf(match[2]) + match[2].length, match[2], true);
  }
  return refs;
}

function kindOf(path) {
  const pathname = path.split(/[?#]/, 1)[0].toLowerCase();
  if (pathname.endsWith('.css')) return 'css';
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) return 'js';
  if (pathname.endsWith('.html') || pathname.endsWith('/')) return 'html';
  return 'asset';
}

function assetUrl(baseUrl, fromUrl, raw) {
  if (!raw || /^(?:data:|blob:|mailto:|tel:|javascript:|#)/i.test(raw)) return null;
  let target;
  try { target = new URL(raw, fromUrl); } catch { return null; }
  if (!ASSET_EXTENSION.test(target.pathname + target.search) || !sourcePreviewPageMatches(baseUrl, target.href)) return null;
  target.hash = '';
  return target;
}

function requireLocalExecutableAssets(baseUrl, fromUrl, html) {
  const required = [
    /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi,
    /<link\b(?=[^>]*\brel\s*=\s*(["'])[^"']*(?:stylesheet|modulepreload)[^"']*\1)[^>]*\bhref\s*=\s*(["'])(.*?)\2/gi,
  ];
  for (const pattern of required) for (const match of html.matchAll(pattern)) {
    const raw = decoded(match[match.length - 1]);
    if (!raw || /^(?:data:|blob:)/i.test(raw)) continue;
    let target;
    try { target = new URL(raw, fromUrl); } catch { throw new Error('The source page has a script or stylesheet address that cannot be read.'); }
    if (!sourcePreviewPageMatches(baseUrl, target.href)) throw new Error('The source page needs an external script or stylesheet that cannot be copied with this route.');
  }
}

function outputPath(prefix, baseUrl, sourceTarget, target) {
  const root = sourcePreviewTarget(baseUrl, '/');
  if (!root || !target.pathname.startsWith(root.pathname)) throw new Error('The source asset leaves its connected site.');
  let path = decodeURIComponent(target.pathname.slice(root.pathname.length));
  if (!path) throw new Error('The source asset path is empty.');
  const sourcePath = decodeURIComponent(sourceTarget.pathname.slice(root.pathname.length));
  const sourceDirectory = sourceTarget.pathname.endsWith('/') ? sourcePath.replace(/\/$/, '')
    : sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
  if (sourceDirectory && path.startsWith(`${sourceDirectory}/`)) path = path.slice(sourceDirectory.length + 1);
  else if (sourceDirectory) path = `external/${path}`;
  if (!path || path.startsWith('external//')) throw new Error('The source asset path is empty.');
  if (target.search) {
    const dot = path.lastIndexOf('.');
    const suffix = `-${HASH(target.search).slice(0, 12)}`;
    path = dot > path.lastIndexOf('/') ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`;
  }
  return publicAppFilePath(`${prefix}/${path}`);
}

async function readBounded(response, path) {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_PUBLIC_APP_FILE_BYTES) throw new Error(`The source file ${path} is too large.`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PUBLIC_APP_FILE_BYTES) {
      await reader.cancel();
      throw new Error(`The source file ${path} is too large.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function publicAppRouteRefreshAssetPrefix(targetPath, scope) {
  const path = publicAppFilePath(targetPath);
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(scope)) throw new Error('Choose a source route scope.');
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return `${parent ? `${parent}/` : ''}route-refresh-${HASH(scope).slice(0, 16)}`;
}

async function fetchSameSite(fetcher, baseUrl, target) {
  let current = target;
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    if (!sourcePreviewPageMatches(baseUrl, current.href)) throw new Error('A source route or asset leaves its connected site.');
    const response = await fetcher(current.href, { redirect: 'manual', headers: { accept: '*/*' } });
    const location = response.headers.get('location');
    if (location && response.status >= 300 && response.status < 400) {
      const next = new URL(location, current);
      await response.body?.cancel();
      if (!sourcePreviewPageMatches(baseUrl, next.href)) throw new Error('A source route or asset redirects outside its connected site.');
      current = next;
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`The source route or asset answered ${response.status}.`);
    }
    return { response, url: current };
  }
  throw new Error('The source route or asset redirected too many times.');
}

/** Read one public source route and its static same-site dependencies into isolated install paths. */
export async function readPublicAppSourceRoute({ baseUrl, sourceRoute, targetRoute, scope, fetcher = fetch }) {
  if (typeof scope !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(scope)) throw new Error('Choose a source route scope.');
  const sourceTarget = sourcePreviewTarget(baseUrl, sourceRoute);
  if (!sourceTarget || sourceTarget.search || sourceTarget.hash) throw new Error('Choose a route within the connected public HTTPS site.');
  const targetPath = publicAppFilePath(targetRoute);
  if (!targetPath.endsWith('.html')) throw new Error('Choose a page route ending in .html or a folder route.');
  const prefix = publicAppRouteRefreshAssetPrefix(targetRoute, scope);
  const files = {};
  const seen = new Set();
  const pending = [{ url: sourceTarget, output: targetPath, page: true }];
  const scheduled = new Set([sourceTarget.href]);
  let total = 0;

  while (pending.length) {
    if (seen.size >= MAX_PUBLIC_APP_FILES) throw new Error(`The source route uses more than ${MAX_PUBLIC_APP_FILES} files.`);
    const current = pending.shift();
    const requestKey = current.url.href;
    if (seen.has(requestKey)) continue;
    seen.add(requestKey);
    scheduled.delete(requestKey);
    const { response, url } = await fetchSameSite(fetcher, baseUrl, current.url);
    const bytes = await readBounded(response, current.output);
    const kind = current.page ? 'html' : kindOf(url.pathname);
    const mediaType = publicAppMediaType(current.output);
    const isText = kind !== 'asset';
    if (isText && !/^(?:text\/|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)/i.test(response.headers.get('content-type') ?? '')) {
      throw new Error(`The source file ${current.output} is not readable text.`);
    }
    let content = isText ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes;
    if (current.page && !/text\/html/i.test(response.headers.get('content-type') ?? '')) throw new Error('The selected source route is not an HTML page.');
    if (current.page) requireLocalExecutableAssets(baseUrl, url.href, content);
    const refs = isText ? refsIn(content, kind) : [];
    const replacements = [];
    for (const ref of refs) {
      const target = assetUrl(baseUrl, url.href, ref.value);
      if (!target) {
        if (ref.required && !/^(?:data:|blob:|mailto:|tel:|javascript:|#)/i.test(ref.value)) {
          throw new Error(`The source file ${current.output} needs a static same-site asset that cannot be copied.`);
        }
        continue;
      }
      const path = outputPath(prefix, baseUrl, sourceTarget, target);
      const earlier = files[path];
      const assetKind = kindOf(target.pathname);
      if (assetKind === 'asset') {
        try { publicAppMediaType(path); } catch { continue; }
      }
      if (!earlier && !seen.has(target.href) && !scheduled.has(target.href)) {
        if (seen.size + scheduled.size >= MAX_PUBLIC_APP_FILES) throw new Error(`The source route uses more than ${MAX_PUBLIC_APP_FILES} files.`);
        scheduled.add(target.href);
        pending.push({ url: target, output: path, page: false });
      }
      const fragment = ref.value.split('#').slice(1).join('#');
      replacements.push({ start: ref.start, end: ref.end, value: `/${path}${fragment ? `#${fragment}` : ''}` });
    }
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      content = `${content.slice(0, replacement.start)}${replacement.value}${content.slice(replacement.end)}`;
    }
    const final = isText ? content : bytes;
    const size = typeof final === 'string' ? new TextEncoder().encode(final).length : final.length;
    total += size;
    if (total > MAX_PUBLIC_APP_BYTES) throw new Error(`The source route uses more than ${MAX_PUBLIC_APP_BYTES / 1_000_000} MB of files.`);
    if (size > MAX_PUBLIC_APP_FILE_BYTES) throw new Error(`The source file ${current.output} is too large.`);
    if (!isText && mediaType.startsWith('text/')) throw new Error(`The source asset ${current.output} has the wrong file type.`);
    if (Object.hasOwn(files, current.output) && files[current.output] !== final) throw new Error(`Two source assets map to ${current.output}.`);
    files[current.output] = final;
  }
  if (!Object.hasOwn(files, targetPath)) throw new Error('The selected source route did not produce a page.');
  return { target_path: targetPath, asset_prefix: prefix, files, file_count: Object.keys(files).length, byte_count: total };
}
