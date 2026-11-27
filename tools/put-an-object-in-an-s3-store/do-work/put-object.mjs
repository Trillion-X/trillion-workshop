import { realpathSync } from 'node:fs';
// tools/put-an-object-in-an-s3-store/do-work/put-object.mjs
//
// The computer tool `tool:put-an-object-in-an-s3-store` (what-this-tool-does-and-how-to-run-it.json): puts one file from the folder the person granted
// this run into one key of an S3-compatible store the person holds in their vault (Backblaze B2, Cloudflare R2, any store
// that speaks S3 PutObject). A key that is already there is replaced, so a fixed key (a download's stable name, an update
// feed) always answers the newest bytes.
//
// The store is named by the run's input (`store`, such as `downloads-store`); the engine mounts the five vault values that
// name begins (`<store>-key-id`, `-secret`, `-endpoint`, `-bucket`, `-region`) on descriptors 3 to 7 of this one process
// and never in its input. Each value reaches only the hosts the vault keeps for it, so the request can go to the store's
// own endpoint and nowhere else. The file is read twice by stream, once for its SHA-256 (the signed payload hash the store
// checks the bytes against) and BLAKE3 (its content identity) together, and once to send, so memory holds one piece
// whatever the file's size. The answer is { store, key, bytes, blake3, sha256, etag }: never a key value, a signature, the
// store's raw reply or its address. The address is made of the endpoint and bucket the vault holds, and the engine withholds
// a whole output that holds a held value, so until Nov 25 2026 every put answered its caller null (150 puts in 7 days).
//
// Signing is the read tool's (tools/read-objects-in-an-s3-store/do-work/read-objects.mjs `signRequest`): one AWS
// Signature Version 4 owner for every S3 call the Workshop makes.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { endpointOrigin, signRequest } from '../../read-objects-in-an-s3-store/do-work/read-objects.mjs';

// One S3 PutObject takes at most 5 GiB.
const MAX_OBJECT_BYTES = 5 * 1024 ** 3;
const MOUNT = { keyId: 3, secret: 4, endpoint: 5, bucket: 6, region: 7 };
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_NAME = /^[a-z0-9-]{1,40}$/;
const encodeRfc3986 = text => encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = key => key.split('/').map(encodeRfc3986).join('/');

// The file's real path inside the granted folder: a name that leaves the folder, by dots or by a link, names nothing.
export function fileInFolder(folder, name) {
  if (typeof folder !== 'string' || folder === '') throw new Error('This run was given no folder. Grant the folder that holds the file.');
  if (typeof name !== 'string' || name === '' || isAbsolute(name) || name.split(/[\\/]/).includes('..')) {
    throw new Error(`${name || 'That name'} is not a file inside the granted folder.`);
  }
  const root = realpathSync(folder);
  let path;
  try { path = realpathSync(resolve(root, name)); } catch { throw new Error(`${name} is not in the granted folder.`); }
  const inside = relative(root, path);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`${name} is not a file inside the granted folder.`);
  if (!statSync(path).isFile()) throw new Error(`${name} is not a file.`);
  return path;
}

// An object key is 1 to 1024 bytes of text with no leading slash, no dot segment and no control character.
export function checkedKey(key) {
  if (typeof key !== 'string' || key === '' || Buffer.byteLength(key) > 1024 || key.startsWith('/')
    || key.split('/').some(part => part === '.' || part === '..') || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error('Name the object key as text of 1 to 1024 bytes, with no leading slash, dot segment or control character.');
  }
  return key;
}

async function hashesOfFile(path) {
  const sha256 = createHash('sha256');
  const identity = blake3.create();
  for await (const piece of createReadStream(path)) {
    sha256.update(piece);
    identity.update(piece);
  }
  return { sha256: sha256.digest('hex'), blake3: bytesToHex(identity.digest()) };
}

// Puts one file into one key. stdin = { input: { store, file, key, content_type, cache_control? }, folder } with the
// store's values handed in as `store` = { keyId, secret, endpoint, bucket, region }.
export async function putObject({ input = {}, folder } = {}, { store, fetchImpl = fetch, now = new Date() }) {
  const { keyId, secret, endpoint, bucket, region } = store;
  if (typeof keyId !== 'string' || keyId === '' || typeof secret !== 'string' || secret === '') {
    throw new Error(`No key for ${input.store ?? 'that store'} was handed to this run. Keep the store's key in the vault first.`);
  }
  if (!BUCKET_NAME.test(bucket ?? '')) throw new Error('The store has no valid bucket name in the vault.');
  if (!REGION_NAME.test(region ?? '')) throw new Error('The store has no valid region in the vault.');
  if (typeof input.content_type !== 'string' || !/^[\w.+-]+\/[\w.+-]+(;\s*[\w.+-]+=[\w.+-]+)*$/.test(input.content_type)) {
    throw new Error('Name the media type the object is served with, such as application/octet-stream.');
  }
  if (input.cache_control !== undefined && (typeof input.cache_control !== 'string' || !/^[\w=, -]{1,200}$/.test(input.cache_control))) {
    throw new Error('cache_control is the Cache-Control words the object is served with, such as max-age=60.');
  }
  const key = checkedKey(input.key);
  const path = fileInFolder(folder, input.file);
  const size = statSync(path).size;
  if (size > MAX_OBJECT_BYTES) throw new Error(`${input.file} is ${size} bytes; one put takes at most ${MAX_OBJECT_BYTES} bytes.`);
  const origin = endpointOrigin(endpoint);
  const url = new URL(`/${encodeRfc3986(bucket)}/${encodePath(key)}`, origin);
  const { sha256, blake3: identity } = await hashesOfFile(path);
  const signed = signRequest({ method: 'PUT', url: url.href, payloadHash: sha256, region, keyId, secret, now });
  const headers = { ...signed, 'content-type': input.content_type, 'content-length': String(size) };
  if (input.cache_control) headers['cache-control'] = input.cache_control;
  const response = await fetchImpl(url.href, {
    method: 'PUT', headers, body: Readable.toWeb(createReadStream(path)), duplex: 'half', redirect: 'error',
    signal: AbortSignal.timeout(Math.max(60000, Math.ceil(size / 256))),
  });
  if (response.status === 401 || response.status === 403) throw new Error(`The store refused the held key (${response.status}). Keep a current key for ${input.store ?? 'the store'} in the vault.`);
  if (response.status === 400) throw new Error('The store refused the bytes as sent (400): their SHA-256 or length did not match what was signed.');
  if (!response.ok) throw new Error(`The store answered ${response.status}. Try again later.`);
  return { store: input.store ?? null, key, bytes: size, blake3: identity, sha256, etag: (response.headers.get('etag') ?? '').replace(/"/g, '') || null };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const read = descriptor => { try { return readFileSync(descriptor, 'utf8').trim(); } catch { return ''; } };
  try {
    const given = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const store = { keyId: read(MOUNT.keyId), secret: read(MOUNT.secret), endpoint: read(MOUNT.endpoint), bucket: read(MOUNT.bucket), region: read(MOUNT.region) };
    console.log(JSON.stringify(await putObject(given, { store })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
