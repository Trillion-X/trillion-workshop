// tools/remove-objects-from-an-s3-store/do-work/remove-objects.ts
//
// PURPOSE
//   The container tool `tool:remove-objects-from-an-s3-store` (tool-rows.json): removes named objects from an S3-compatible store
//   the person keeps in their vault (Backblaze B2, Cloudflare R2, any store that speaks S3), and lists one page of a prefix so
//   a removal is read before and after. It is the delete half of tools/put-an-object-in-an-s3-store, opened the same way: the
//   input's `store` names the five vault values that name begins (`<store>-key-id`, `-secret`, `-endpoint`, `-bucket`,
//   `-region`), which the engine mounts on descriptors 3 to 7 of this one process and never in its input.
//
// NON-NEGOTIABLE INVARIANTS
//   1. `remove` takes an exact list of keys and nothing else: no prefix (a key that ends in "/"), no wildcard ("*" or "?"), no
//      key twice, at most MOST_KEYS. A list holding one such key removes nothing, so a mistyped pattern never empties a folder.
//   2. Each key is read (HEAD) before it is removed (DELETE), so its answer says what was there: { key, result: removed, bytes },
//      { key, result: absent } when nothing was, or { key, result: failed, why } with the store's status. One failed key does
//      not stop the others; the answer says every key's result.
//   3. `list` only reads: one page of { key, size, last_modified } under a prefix.
//   4. Every request is signed with AWS Signature Version 4 by the read tool's `signRequest` (one signer for every S3 call the
//      Workshop makes) and goes to the store's own endpoint only. No answer, error or log holds a key value, a signature, the
//      endpoint or the bucket: the engine withholds a whole output that holds a held value.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { endpointOrigin, parseListing, signRequest } from '../../read-objects-in-an-s3-store/do-work/read-objects.mjs';
import { checkedKey } from '../../put-an-object-in-an-s3-store/do-work/put-object.mjs';

export const MOST_KEYS = 1000;
const MOUNT = { keyId: 3, secret: 4, endpoint: 5, bucket: 6, region: 7 };
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_NAME = /^[a-z0-9-]{1,40}$/;
const encodeRfc3986 = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (key: string) => key.split('/').map(encodeRfc3986).join('/');

export type HeldStore = { keyId: string; secret: string; endpoint: string; bucket: string; region: string };
export type Input = { store?: string; action?: 'remove' | 'list'; keys?: unknown; prefix?: string; continuation_token?: string; max_keys?: number };
export type KeyResult = { key: string; result: 'removed'; bytes: number } | { key: string; result: 'absent' } | { key: string; result: 'failed'; why: string };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// The exact keys a removal names: every one a plain key, none a prefix or a pattern, none twice. One bad key refuses the list.
export function exactKeys(keys: unknown): string[] {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MOST_KEYS) throw new Error(`Name the keys to remove as a list of 1 to ${MOST_KEYS} exact keys.`);
  const seen = new Set<string>();
  for (const key of keys) {
    checkedKey(key);
    if (key.endsWith('/')) throw new Error(`${key} ends in "/", so it names a prefix; this tool removes only exact keys.`);
    if (/[*?]/.test(key)) throw new Error(`${key} holds "*" or "?", which this tool does not take; name each key exactly.`);
    if (seen.has(key)) throw new Error(`${key} is named twice.`);
    seen.add(key);
  }
  return keys as string[];
}

function checkedStore(store: HeldStore, name: string | undefined) {
  if (typeof store?.keyId !== 'string' || store.keyId === '' || typeof store.secret !== 'string' || store.secret === '') {
    throw new Error(`No key for ${name ?? 'that store'} was handed to this run. Keep the store's key in the vault first.`);
  }
  if (!BUCKET_NAME.test(store.bucket ?? '')) throw new Error('The store has no valid bucket name in the vault.');
  if (!REGION_NAME.test(store.region ?? '')) throw new Error('The store has no valid region in the vault.');
  return endpointOrigin(store.endpoint);
}

// One signed request to the store: path-style, no redirect, a bounded wait.
async function send(fetchImpl: Fetch, store: HeldStore, origin: string, method: string, path: string, query: Record<string, string> = {}, now = new Date()) {
  const url = new URL(path, origin);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const headers = signRequest({ method, url: url.href, region: store.region, keyId: store.keyId, secret: store.secret, now });
  return fetchImpl(url.href, { method, headers: { ...headers, accept: '*/*' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
}

const refusedKey = (status: number, name: string | undefined) => (status === 401 || status === 403
  ? `The store refused the held key (${status}). Keep a current key for ${name ?? 'the store'} in the vault.` : null);

export async function removeObjects(input: Input, { store, fetchImpl = fetch as Fetch, now = new Date() }: { store: HeldStore; fetchImpl?: Fetch; now?: Date }) {
  const origin = checkedStore(store, input.store);
  const action = input.action ?? 'remove';
  const bucketPath = `/${encodeRfc3986(store.bucket)}`;
  if (action === 'list') {
    if (typeof input.prefix !== 'string' || input.prefix === '') throw new Error('Name the prefix to list, such as site/.');
    const most = Math.min(Math.max(1, Number(input.max_keys) || MOST_KEYS), MOST_KEYS);
    const query: Record<string, string> = { 'list-type': '2', 'max-keys': String(most), prefix: input.prefix };
    if (input.continuation_token) query['continuation-token'] = input.continuation_token;
    const answer = await send(fetchImpl, store, origin, 'GET', bucketPath, query, now);
    const refused = refusedKey(answer.status, input.store);
    if (refused) throw new Error(refused);
    if (!answer.ok) throw new Error(`The store answered ${answer.status} to the listing. Try again later.`);
    return { store: input.store ?? null, prefix: input.prefix, ...parseListing(await answer.text()) };
  }
  if (action !== 'remove') throw new Error('action is remove (the default) or list.');
  const keys = exactKeys(input.keys);
  const results: KeyResult[] = [];
  for (const key of keys) {
    const path = `${bucketPath}/${encodePath(key)}`;
    const head = await send(fetchImpl, store, origin, 'HEAD', path, {}, now);
    const refusedHead = refusedKey(head.status, input.store);
    if (refusedHead) throw new Error(refusedHead);
    if (head.status === 404) { results.push({ key, result: 'absent' }); continue; }
    if (!head.ok) { results.push({ key, result: 'failed', why: `the store answered ${head.status} when it was read` }); continue; }
    const bytes = Number(head.headers.get('content-length') ?? 0);
    const removed = await send(fetchImpl, store, origin, 'DELETE', path, {}, now);
    const refusedDelete = refusedKey(removed.status, input.store);
    if (refusedDelete) throw new Error(refusedDelete);
    results.push(removed.ok ? { key, result: 'removed', bytes } : { key, result: 'failed', why: `the store answered ${removed.status} to the removal` });
  }
  const count = (result: KeyResult['result']) => results.filter(item => item.result === result).length;
  return { store: input.store ?? null, results, removed: count('removed'), absent: count('absent'), failed: count('failed') };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const read = (descriptor: number) => { try { return readFileSync(descriptor, 'utf8').trim(); } catch { return ''; } };
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const store = { keyId: read(MOUNT.keyId), secret: read(MOUNT.secret), endpoint: read(MOUNT.endpoint), bucket: read(MOUNT.bucket), region: read(MOUNT.region) };
    console.log(JSON.stringify(await removeObjects(input, { store })));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
