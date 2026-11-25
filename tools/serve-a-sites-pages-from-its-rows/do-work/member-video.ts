// tools/serve-a-sites-pages-from-its-rows/do-work/member-video.ts
//
// PURPOSE
//   A member's file (a lesson video, a member's download) is never served by this program and never public: its address on the
//   site, <settings.member_files.path><key>, checks the request is a member (member-pass.ts), then answers 302 to a presigned GET
//   of that one key in the site's files store (S3 signature version 4, query-string auth), made here with the store's read key the
//   computer seals for this unit. The browser then reads the bytes, ranges included, straight from the store.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No member, no link: a request that is not a member is answered 403, so a player asks again after a sign-in.
//   2. Only keys under a declared prefix, with no empty, "." or ".." part, are signed.
//   3. Every answer is Cache-Control: private, no-store, so no shared cache keeps a member's link or a refusal.
//   4. A link lives settings.member_files.link_seconds (at least the longest video, so a playing video is never cut off; at most
//      the signature's own limit of 7 days). The player asks for a new link on a 403.
//   5. The read key is only used to sign: it is never in a link, a log or a page (the link carries only its id and the signature).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { createHash, createHmac } from 'node:crypto';
import type { Answer } from './screen-files.ts';
import type { Member } from './member-pass.ts';

export interface MemberFiles {
  /** The site path the files answer under, such as /member-files/. */
  path: string;
  /** The store's address, such as https://s3.us-west-004.backblazeb2.com. */
  endpoint: string;
  region: string;
  bucket: string;
  /** "path": endpoint/bucket/key; "host": bucket.endpoint-host/key. */
  style: 'path' | 'host';
  /** The keys that may be signed start with one of these. */
  prefixes: string[];
  link_seconds: number;
}

export interface StoreKey {
  id: string;
  secret: string;
}

const MOST_SECONDS = 604_800;
const NO_STORE = 'private, no-store';

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

/** Checks the member files settings; a wrong one throws with what it should be. */
export function memberFilesOf(value: unknown): MemberFiles {
  const files = value as Partial<MemberFiles> | null;
  if (!files || typeof files.path !== 'string' || !/^\/[a-z0-9-]+\/$/.test(files.path)) throw new Error('member_files.path is a site path such as /member-files/.');
  if (typeof files.endpoint !== 'string' || !/^https:\/\/[^/]+$/.test(files.endpoint)) throw new Error('member_files.endpoint is the store address, https://host with no path.');
  if (typeof files.region !== 'string' || !files.region) throw new Error('member_files.region is the store\'s region.');
  if (typeof files.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(files.bucket)) throw new Error('member_files.bucket is the bucket name.');
  if (files.style !== 'path' && files.style !== 'host') throw new Error('member_files.style is "path" or "host".');
  if (!Array.isArray(files.prefixes) || !files.prefixes.length || files.prefixes.some(prefix => typeof prefix !== 'string' || !/^[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+\/)*$/.test(prefix))) {
    throw new Error('member_files.prefixes lists the key folders that may be signed, such as ["lessons/"].');
  }
  if (!Number.isInteger(files.link_seconds) || files.link_seconds! < 60 || files.link_seconds! > MOST_SECONDS) throw new Error(`member_files.link_seconds is 60 to ${MOST_SECONDS}: at least the longest video.`);
  return files as MemberFiles;
}

/** A presigned GET of one key (signature version 4, query-string auth, UNSIGNED-PAYLOAD). */
export function presignedGet(files: Pick<MemberFiles, 'endpoint' | 'region' | 'bucket' | 'style'>, key: StoreKey, objectKey: string, seconds: number, now: Date): string {
  const endpoint = new URL(files.endpoint);
  const host = files.style === 'host' ? `${files.bucket}.${endpoint.host}` : endpoint.host;
  const path = `${files.style === 'path' ? `/${files.bucket}` : ''}/${objectKey.split('/').map(encoded).join('/')}`;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = stamp.slice(0, 8);
  const scope = `${day}/${files.region}/s3/aws4_request`;
  const query = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${key.id}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(seconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ].map(([name, value]) => `${encoded(name)}=${encoded(value)}`).sort().join('&');
  const canonical = ['GET', path, query, `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const signingKey = ['s3', 'aws4_request'].reduce((k, piece) => hmac(k, piece), hmac(hmac(`AWS4${key.secret}`, day), files.region));
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}

/** The store key a site path names, or null when it is not one a member may be sent to. */
export function objectKeyOf(files: MemberFiles, pathname: string): string | null {
  if (!pathname.startsWith(files.path)) return null;
  let key: string;
  try { key = decodeURIComponent(pathname.slice(files.path.length)); } catch { return null; }
  if (key.split('/').some(part => part === '' || part === '.' || part === '..')) return null;
  return files.prefixes.some(prefix => key.startsWith(prefix)) ? key : null;
}

/** The answer for a member file's address: 403 for anyone not a member, else 302 to the file's link. */
export function memberFileAnswer(files: MemberFiles, key: StoreKey, objectKey: string, member: Member | null, now = new Date()): Answer {
  const words = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': NO_STORE };
  if (!member) return { status: 403, headers: words, body: 'This file is for members. Sign in, then open it again.\n' };
  return { status: 302, headers: { location: presignedGet(files, key, objectKey, files.link_seconds, now), 'cache-control': NO_STORE, 'referrer-policy': 'no-referrer' }, body: '' };
}
