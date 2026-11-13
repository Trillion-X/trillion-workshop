// tools/read-objects-in-an-s3-store/do-work/read-objects.mjs
//
// The container tool `tool:read-objects-in-an-s3-store` (tool-rows.json): lists the objects of one bucket in any
// S3-compatible store, or reads one object, for the store the person connected (a service connection whose descriptor
// names an S3 endpoint, a bucket and an access key). It only reads; it writes and deletes nothing.
//
// The connection's own fields reach this one process on private pipes (the row's invoke.credential_mounts): descriptor
// 3 the access key ID, 4 the secret access key, 5 the endpoint, 6 the bucket. Every request goes to that endpoint only,
// signed with AWS Signature Version 4, so the secret never leaves for another host. The answer carries object names,
// sizes and bytes, never a key, a signature or the provider's raw reply.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REGION = 'auto';
const SERVICE = 's3';
const MAX_KEYS = 1000;
const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const MOUNT = { keyId: 3, secret: 4, endpoint: 5, bucket: 6 };
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const sha256Hex = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const encodeRfc3986 = text => encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = key => key.split('/').map(encodeRfc3986).join('/');

// The AWS Signature Version 4 signing key for one date, region and service.
export function signingKey(secret, date, region = REGION, service = SERVICE) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

// The headers that sign one request: { 'x-amz-date', 'x-amz-content-sha256', authorization }.
export function signRequest({ method, url, body = '', keyId, secret, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const target = new URL(url);
  const query = [...target.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join('&');
  const payloadHash = sha256Hex(body);
  const headers = { host: target.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map(name => `${name}:${headers[name]}\n`).join('');
  const canonicalRequest = [method, target.pathname, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(secret, date)).update(stringToSign).digest('hex');
  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const xmlText = (xml, tag) => {
  const found = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return found ? found[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') : undefined;
};

// The objects of one page: { objects: [{ key, size, last_modified }], truncated, next_token }.
export function parseListing(xml) {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, block]) => ({
    key: xmlText(block, 'Key') ?? '',
    size: Number(xmlText(block, 'Size') ?? 0),
    last_modified: xmlText(block, 'LastModified') ?? '',
  }));
  return { objects, truncated: xmlText(xml, 'IsTruncated') === 'true', next_token: xmlText(xml, 'NextContinuationToken') ?? null };
}

// An endpoint is an https root with no path, query or credentials: every request goes to exactly this host.
export function endpointOrigin(endpoint) {
  let target;
  try { target = new URL(endpoint); } catch { throw new Error('The store endpoint is not a web address. Connect the store again.'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || (target.pathname !== '/' && target.pathname !== '')) {
    throw new Error('The store endpoint must be an https address with no path. Connect the store again.');
  }
  return target.origin;
}

async function readBounded(response) {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_OBJECT_BYTES) throw new Error(`That object is ${declared} bytes; this tool reads objects up to ${MAX_OBJECT_BYTES} bytes.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_OBJECT_BYTES) throw new Error(`That object is larger than ${MAX_OBJECT_BYTES} bytes; this tool does not read it.`);
  return bytes;
}

// Lists one page of the bucket (action 'list') or reads one object (action 'get'). The input is the request; the
// connection's fields come in as `store` = { keyId, secret, endpoint, bucket }.
export async function readObjects(input, { store, fetchImpl = fetch, now = new Date() }) {
  const { keyId, secret, endpoint, bucket } = store;
  if (typeof keyId !== 'string' || keyId === '' || typeof secret !== 'string' || secret === '') {
    throw new Error('No store key was handed to this run. Connect the store first.');
  }
  if (!BUCKET_NAME.test(bucket ?? '')) throw new Error('The store has no valid bucket name. Connect the store again.');
  const origin = endpointOrigin(endpoint);
  const action = input.action ?? 'list';
  if (action === 'get' && !input.key) throw new Error('Name the object key to read.');
  const path = action === 'get' ? `/${encodeRfc3986(bucket)}/${encodePath(input.key)}` : `/${encodeRfc3986(bucket)}`;
  const url = new URL(path, origin);
  if (action === 'list') {
    url.searchParams.set('list-type', '2');
    url.searchParams.set('max-keys', String(Math.min(input.max_keys ?? 100, MAX_KEYS)));
    if (input.prefix) url.searchParams.set('prefix', input.prefix);
    if (input.continuation_token) url.searchParams.set('continuation-token', input.continuation_token);
  }
  const headers = signRequest({ method: 'GET', url: url.href, keyId, secret, now });
  const response = await fetchImpl(url.href, { method: 'GET', headers: { ...headers, Accept: '*/*' }, signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (response.status === 401 || response.status === 403) throw new Error(`The store refused the held key (${response.status}). Connect the store again with a current key.`);
  if (response.status === 404) throw new Error(action === 'get' ? 'No object has that key in the bucket.' : 'The bucket was not found at this store.');
  if (!response.ok) throw new Error(`The store answered ${response.status}. Try again later.`);
  if (action === 'list') return parseListing(await response.text());
  const bytes = await readBounded(response);
  return { key: input.key, size: bytes.length, content_type: response.headers.get('content-type') ?? 'application/octet-stream', base64: bytes.toString('base64') };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const read = descriptor => { try { return readFileSync(descriptor, 'utf8').trim(); } catch { return ''; } };
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const store = { keyId: read(MOUNT.keyId), secret: read(MOUNT.secret), endpoint: read(MOUNT.endpoint), bucket: read(MOUNT.bucket) };
    console.log(JSON.stringify(await readObjects(input, { store })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
