// tools/serve-a-sites-pages-from-its-rows/do-work/member-video.ts
//
// PURPOSE
//   Files are never served by this program: they live in the site's files store, and an address of the site answers 302 to a
//   presigned GET of one key there (S3 signature version 4, query-string auth), made here with the store's read key the computer
//   seals for this unit. The browser then reads the bytes, ranges included, straight from the store.
//     member files   <member_files.path><key>: for a member only (member-pass.ts); anyone else 403
//     public files   any path under public_files.paths (the site's pictures, videos, fonts and icon): for anyone
//   The store key of a path is key_prefix + the path without its leading slash, so a page row names a file by its site path and
//   no row changes when the files move into the store.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No member, no member link: a member file asked by anyone else answers 403, so a player asks again after a sign-in.
//   2. Only keys under a declared prefix or path, with no empty, "." or ".." part, are signed.
//   3. A member answer is Cache-Control: private, no-store, so no shared cache keeps a member's link or a refusal. A public
//      answer is cached for public_files.cache_seconds, always less than its link lives, so no cache keeps a dead link.
//   4. A member link lives member_files.link_seconds (at least the longest video, so a playing video is never cut off); every
//      link lives at most the signature's own limit of 7 days. The player asks for a new link on a 403.
//   5. The read key is only used to sign: it is never in a link, a log or a page (the link carries only its id and the signature).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { createHash, createHmac } from 'node:crypto';
import type { Answer } from './screen-files.ts';
import type { Member } from './member-pass.ts';

export interface FilesStore {
  /** The store's address, such as https://s3.us-east-005.backblazeb2.com. */
  endpoint: string;
  region: string;
  bucket: string;
  /** "path": endpoint/bucket/key; "host": bucket.endpoint-host/key. */
  style: 'path' | 'host';
}

export interface MemberFiles {
  /** The site path the files answer under, such as /member-files/. */
  path: string;
  /** Put in front of the key the address names. */
  key_prefix: string;
  /** The keys (after key_prefix) that may be signed start with one of these. */
  prefixes: string[];
  link_seconds: number;
}

export interface PublicFiles {
  /** Site paths answered from the store: a folder ending in "/" (every path under it) or one whole path. */
  paths: string[];
  /** Put in front of the path (without its leading slash) to make the key. */
  key_prefix: string;
  link_seconds: number;
  /** How long a browser and a shared cache keep the 302: less than link_seconds. */
  cache_seconds: number;
}

export interface StoreKey {
  id: string;
  secret: string;
}

const MOST_SECONDS = 604_800;
const NO_STORE = 'private, no-store';
const KEY_PREFIX = /^([A-Za-z0-9._-]+\/)*$/;

/** RFC 3986 encoding as signature version 4 asks for it: unreserved characters kept, everything else %XX. */
const encoded = (text: string): string => encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const hmac = (key: Buffer | string, text: string): Buffer => createHmac('sha256', key).update(text).digest();

/** The two lines of the sealed store key (AWS_ACCESS_KEY_ID=... and AWS_SECRET_ACCESS_KEY=...). */
export function storeKeyOf(text: string): StoreKey {
  const pairs = Object.fromEntries(text.split('\n').map(line => line.trim()).filter(line => line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (!pairs.AWS_ACCESS_KEY_ID || !pairs.AWS_SECRET_ACCESS_KEY) throw new Error('The files store key holds two lines, AWS_ACCESS_KEY_ID=... and AWS_SECRET_ACCESS_KEY=....');
  return { id: pairs.AWS_ACCESS_KEY_ID, secret: pairs.AWS_SECRET_ACCESS_KEY };
}

/** Checks the files store settings; a wrong one throws with what it should be. */
export function filesStoreOf(value: unknown): FilesStore {
  const store = value as Partial<FilesStore> | null;
  if (!store || typeof store.endpoint !== 'string' || !/^https:\/\/[^/]+$/.test(store.endpoint)) throw new Error('files_store.endpoint is the store address, https://host with no path.');
  if (typeof store.region !== 'string' || !store.region) throw new Error('files_store.region is the store\'s region.');
  if (typeof store.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(store.bucket)) throw new Error('files_store.bucket is the bucket name.');
  if (store.style !== 'path' && store.style !== 'host') throw new Error('files_store.style is "path" or "host".');
  return store as FilesStore;
}

const seconds = (value: unknown, least: number): boolean => Number.isInteger(value) && (value as number) >= least && (value as number) <= MOST_SECONDS;

/** Checks the member files settings; a wrong one throws with what it should be. */
export function memberFilesOf(value: unknown): MemberFiles {
  const given = value as Partial<MemberFiles> | null;
  const files = given ? { ...given, key_prefix: given.key_prefix ?? '' } : null;
  if (!files || typeof files.path !== 'string' || !/^\/[a-z0-9-]+\/$/.test(files.path)) throw new Error('member_files.path is a site path such as /member-files/.');
  if (typeof files.key_prefix !== 'string' || !KEY_PREFIX.test(files.key_prefix)) throw new Error('member_files.key_prefix is "" or key folders ending in "/".');
  if (!Array.isArray(files.prefixes) || !files.prefixes.length || files.prefixes.some(prefix => typeof prefix !== 'string' || !/^[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+\/)*$/.test(prefix))) {
    throw new Error('member_files.prefixes lists the key folders that may be signed, such as ["lessons/"].');
  }
  if (!seconds(files.link_seconds, 60)) throw new Error(`member_files.link_seconds is 60 to ${MOST_SECONDS}: at least the longest video.`);
  return files as MemberFiles;
}

/** Checks the public files settings; a wrong one throws with what it should be. */
export function publicFilesOf(value: unknown): PublicFiles {
  const given = value as Partial<PublicFiles> | null;
  const files = given ? { ...given, key_prefix: given.key_prefix ?? '' } : null;
  if (!files || !Array.isArray(files.paths) || !files.paths.length || files.paths.some(path => typeof path !== 'string' || !/^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?$/.test(path))) {
    throw new Error('public_files.paths lists site folders ending in "/" or whole paths, such as ["/assets/", "/favicon.png"].');
  }
  if (typeof files.key_prefix !== 'string' || !KEY_PREFIX.test(files.key_prefix)) throw new Error('public_files.key_prefix is "" or key folders ending in "/".');
  if (!seconds(files.link_seconds, 3600)) throw new Error(`public_files.link_seconds is 3600 to ${MOST_SECONDS}.`);
  if (!Number.isInteger(files.cache_seconds) || files.cache_seconds! < 0 || files.cache_seconds! * 2 > files.link_seconds!) {
    throw new Error('public_files.cache_seconds is 0 to half of link_seconds, so no cache keeps a dead link.');
  }
  return files as PublicFiles;
}

/** A presigned GET of one key (signature version 4, query-string auth, UNSIGNED-PAYLOAD). */
export function presignedGet(store: FilesStore, key: StoreKey, objectKey: string, seconds: number, now: Date): string {
  const endpoint = new URL(store.endpoint);
  const host = store.style === 'host' ? `${store.bucket}.${endpoint.host}` : endpoint.host;
  const path = `${store.style === 'path' ? `/${store.bucket}` : ''}/${objectKey.split('/').map(encoded).join('/')}`;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = stamp.slice(0, 8);
  const scope = `${day}/${store.region}/s3/aws4_request`;
  const query = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${key.id}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(seconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ].map(([name, value]) => `${encoded(name)}=${encoded(value)}`).sort().join('&');
  const canonical = ['GET', path, query, `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const signingKey = ['s3', 'aws4_request'].reduce((k, piece) => hmac(k, piece), hmac(hmac(`AWS4${key.secret}`, day), store.region));
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}

// The parts of a decoded key, or null when one is empty, "." or "..".
function cleanKey(encodedKey: string): string | null {
  let key: string;
  try { key = decodeURIComponent(encodedKey); } catch { return null; }
  return key.split('/').some(part => part === '' || part === '.' || part === '..') ? null : key;
}

/** The store key a member file's site path names, or null when it is not one a member may be sent to. */
export function objectKeyOf(files: MemberFiles, pathname: string): string | null {
  if (!pathname.startsWith(files.path)) return null;
  const key = cleanKey(pathname.slice(files.path.length));
  return key && files.prefixes.some(prefix => key.startsWith(prefix)) ? `${files.key_prefix}${key}` : null;
}

/** Whether a site path is a public file's. */
export function isPublicPath(files: PublicFiles, pathname: string): boolean {
  return files.paths.some(path => path.endsWith('/') ? pathname.startsWith(path) : pathname === path);
}

/** The store key of a public file's site path, or null when the path is not a clean public file path. */
export function publicKeyOf(files: PublicFiles, pathname: string): string | null {
  if (!isPublicPath(files, pathname)) return null;
  const key = cleanKey(pathname.slice(1));
  return key ? `${files.key_prefix}${key}` : null;
}

/** The answer for a member file's address: 403 for anyone not a member, else 302 to the file's link. */
export function memberFileAnswer(store: FilesStore, files: MemberFiles, key: StoreKey, objectKey: string, member: Member | null, now = new Date()): Answer {
  const words = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': NO_STORE };
  if (!member) return { status: 403, headers: words, body: 'This file is for members. Sign in, then open it again.\n' };
  return { status: 302, headers: { location: presignedGet(store, key, objectKey, files.link_seconds, now), 'cache-control': NO_STORE, 'referrer-policy': 'no-referrer' }, body: '' };
}

/** The answer for a public file's address: 302 to the file's link, kept cache_seconds. */
export function publicFileAnswer(store: FilesStore, files: PublicFiles, key: StoreKey, objectKey: string, now = new Date()): Answer {
  return { status: 302, headers: { location: presignedGet(store, key, objectKey, files.link_seconds, now), 'cache-control': `public, max-age=${files.cache_seconds}` }, body: '' };
}
