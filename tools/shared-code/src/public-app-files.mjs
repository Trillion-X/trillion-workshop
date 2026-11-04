// Public app file admission and immutable byte references. File bytes live in
// HOSTED_STATE; published rows, drafts and installation routes keep only refs.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const MAX_PUBLIC_APP_FILES = 512;
export const MAX_PUBLIC_APP_BYTES = 128_000_000;
export const MAX_PUBLIC_APP_FILE_BYTES = 20_000_000;
const MIME = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json; charset=utf-8', svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', mp4: 'video/mp4', pdf: 'application/pdf',
};
const TEXT = new Set(['html', 'css', 'js', 'mjs', 'json', 'webmanifest', 'svg', 'txt']);
const REF = /^(maker:[a-f0-9]{64}):1f:([a-f0-9]{64})$/;
const MAKER = /^maker:[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function publicAppFilePath(value) {
  let path;
  try { path = decodeURIComponent(String(value ?? '')); } catch { throw new Error('This file path is invalid.'); }
  path = path.replace(/^\/+/, '') || 'index.html';
  if (path.endsWith('/')) path += 'index.html';
  const segments = path.split('/');
  if (segments.some((segment, index) => !segment || segment === '.' || segment === '..' ||
    (segment !== '.well-known' || index === segments.length - 1) && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment))) {
    throw new Error('This file path is invalid.');
  }
  return segments.join('/');
}

export function publicAppMediaType(path) {
  if (path.endsWith('/apple-app-site-association')) return 'application/json; charset=utf-8';
  const extension = path.split('.').at(-1)?.toLowerCase();
  const media = MIME[extension];
  if (!media) throw new Error(`The ${path} file type is not supported.`);
  return media;
}

export function publicAppBlobKey(ref) {
  const match = REF.exec(ref ?? '');
  if (!match) throw new Error('This app file reference is invalid.');
  return `public-app/blobs/${match[1].slice('maker:'.length)}/${match[2]}`;
}

export function publicAppBlobRef(maker, bytes) {
  if (!MAKER.test(maker ?? '')) throw new Error('This app file owner is invalid.');
  return `${maker}:1f:${bytesToHex(blake3(bytes))}`;
}

function binaryBytes(value, media, path) {
  const prefix = `data:${media};base64,`;
  if (!value.startsWith(prefix)) throw new Error(`The ${path} file needs its original bytes.`);
  const encoded = value.slice(prefix.length);
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(`The ${path} file bytes are invalid.`);
  let decoded;
  try { decoded = atob(encoded); } catch { throw new Error(`The ${path} file bytes are invalid.`); }
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

export function checkedPublicAppFile(path, content) {
    if (publicAppFilePath(path) !== path) throw new Error(`The ${path} file is invalid.`);
    const media_type = publicAppMediaType(path);
    const extension = path.split('.').at(-1)?.toLowerCase();
    let result;
    if (typeof content === 'string') {
      const bytes = content.startsWith(`data:${media_type};base64,`)
        ? binaryBytes(content, media_type, path)
        : TEXT.has(extension) || path.endsWith('/apple-app-site-association')
          ? new TextEncoder().encode(content) : binaryBytes(content, media_type, path);
      result = { media_type, size: bytes.length, bytes, source: content };
    } else if (object(content) && Object.keys(content).sort().join(',') === 'blob_ref,media_type,size' &&
      REF.test(content.blob_ref ?? '') && content.media_type === media_type && Number.isSafeInteger(content.size) && content.size >= 0) {
      result = { media_type, size: content.size, blob_ref: content.blob_ref, source: { blob_ref: content.blob_ref, media_type, size: content.size } };
    } else throw new Error(`The ${path} file is invalid.`);
    if (result.size > MAX_PUBLIC_APP_FILE_BYTES) throw new Error(`The ${path} file is too large.`);
    return result;
}

export function checkedPublicAppFiles(files) {
  if (!object(files)) throw new Error('Give the app files by path.');
  const entries = Object.entries(files);
  if (!entries.length || entries.length > MAX_PUBLIC_APP_FILES || !Object.hasOwn(files, 'index.html')) {
    throw new Error(`The app needs index.html and at most ${MAX_PUBLIC_APP_FILES} files.`);
  }
  let total = 0;
  return Object.fromEntries(entries.map(([path, content]) => {
    const result = checkedPublicAppFile(path, content);
    total += result.size;
    if (total > MAX_PUBLIC_APP_BYTES) throw new Error(`This app has more than ${MAX_PUBLIC_APP_BYTES / 1_000_000} MB of files.`);
    return [path, result];
  }));
}
