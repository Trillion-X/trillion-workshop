// src/files-by-identity.mjs
//
// Files anyone may read by their BLAKE3 identity (`1f:` + hex): a tool's code, the files a run keeps, a shared-library
// picture. Each is an ordinary file of the account that kept it, stored in that account's namespace through the same
// checked upload every file passes (src/namespace.mjs keepStream), with no name, so it sits outside the person's
// folders. The shared pool records which accounts keep each identity (src/pool.mjs file_owners), so a reader who does
// not know who made it still reads it: from the first owner that still holds it, checked against its identity.
// Two accounts that keep the same bytes each own their copy; one deleting theirs never takes the other's away.
// The deploy publishes shared container and screen bundles into the deployment's namespace object bucket under
// published/files/<identity>, apart from every person's keys. Earlier service bundles still read from the operator
// account's namespace. Service POSTs here require proof that the sender runs this Worker
// (src/namespace.mjs serviceOwnerAsks). A tool's screen code is such a bundle too: the page imports its files from
// /workshop/modules/<bundle identity>/<file>.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
// This host seam names the original privileged owners; absence refuses instead
// of opening an account's private Files merely because a content hash is known.
const host = env => {
  const value = env?.identityFileHost;
  if (!value) throw Object.assign(new Error('The admitted public identity-file host is unavailable.'), { code: 'identity_file_host_unavailable', status: 503 });
  return value;
};
const keepStream = (env, owner, file) => host(env).keepStream(owner, file);
const openFile = (env, owner, identity) => host(env).openFile(owner, identity);
const serviceOwnerAsks = (env, request) => host(env).serviceOwnerAsks(request);
import { untarGz } from '../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';
import { publishedFileKey } from '../../keep-files-the-service-publishes-under-their-content/src/published-file-keys.mjs';

export const KEPT_FILE_PREFIX = '/workshop/files/';
export const SCREEN_MODULE_PREFIX = '/workshop/modules/';
const IDENTITY = /^1f:[0-9a-f]{64}$/;
const identityOf = makeHashCodeHexFromBytes;
const pool = env => host(env).fileOwners;
const publishedBucket = env => env.PUBLISHED_FILE_BINDING && env[env.PUBLISHED_FILE_BINDING];
export const keptFileAddress = ref => `${typeof SERVICE_ORIGINS === 'undefined' ? '' : SERVICE_ORIGINS[0]}${KEPT_FILE_PREFIX}${ref}`;

export async function readPublishedFile(env, identity) {
  const bucket = publishedBucket(env);
  if (!bucket) return null;
  const object = await bucket.get(publishedFileKey(identity));
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (identityOf(bytes) !== identity) throw new Error(`The published file ${identity} does not match its identity.`);
  return bytes;
}

export async function keepPublishedFile(env, identity, bytes) {
  if (!IDENTITY.test(identity) || identityOf(bytes) !== identity) throw new Error(`These bytes are ${identityOf(bytes)}, not ${identity}.`);
  const bucket = publishedBucket(env);
  if (!bucket) throw new Error('The service has no published file store.');
  await bucket.put(publishedFileKey(identity), bytes);
  if (!await readPublishedFile(env, identity)) throw new Error(`The published file ${identity} could not be read back.`);
}

/** Keep `bytes` as a file of `owner`, readable by `identity` from then on. */
export async function keepByIdentity(env, owner, identity, bytes) {
  if (!IDENTITY.test(identity) || identityOf(bytes) !== identity) throw new Error(`These bytes are ${identityOf(bytes)}, not ${identity}.`);
  try {
    await keepStream(env, owner, { size: bytes.byteLength, open: async () => [bytes], identity, media_type: 'application/octet-stream' });
  } catch (error) {
    throw new Error(`File storage failed: ${error.message}`, { cause: error });
  }
  try {
    await pool(env).keepFileOwner(identity, owner);
  } catch (error) {
    throw new Error(`File owner index failed: ${error.message}`, { cause: error });
  }
}

/** The bytes of `identity` from the first account that still keeps them, or null when none does. */
export async function readByIdentity(env, identity) {
  if (!IDENTITY.test(identity)) return null;
  const published = await readPublishedFile(env, identity);
  if (published) return published;
  for (const owner of await pool(env).fileOwners(identity)) {
    let file;
    try { file = await openFile(env, owner, identity); }
    catch { continue; }
    const bytes = new Uint8Array(await new Response(file.stream()).arrayBuffer());
    if (identityOf(bytes) !== identity) throw new Error(`The stored files for ${identity} do not match their identity.`);
    return bytes;
  }
  return null;
}

// A published tool's code must outlive the maker's account availability. Copy the
// checked immutable bundle before making its descriptor visible to other accounts.
export async function publishByIdentity(env, identity) {
  const bytes = await readByIdentity(env, identity);
  if (!bytes) throw new Error(`The tool's files ${identity} could not be found for publication.`);
  await keepPublishedFile(env, identity, bytes);
}

/** The Workshop's view: `put` keeps as `owner()`'s file, `get` reads anyone's by identity. */
export const filesByIdentity = (env, owner) => ({
  put: (identity, bytes) => keepByIdentity(env, owner(), identity, bytes),
  get: identity => readByIdentity(env, identity),
});

// GET /workshop/files/<identity>: the bytes, or 404.
// POST /workshop/files/<identity> (the service only): the body published in the deployment's object bucket.
// POST /workshop/files/kept (the service only): { identities } answered with published or legacy service files.
// Any other path is not this route's.
export async function handleKeptFile(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(KEPT_FILE_PREFIX)) return null;
  const ref = decodeURIComponent(url.pathname.slice(KEPT_FILE_PREFIX.length));
  if (request.method === 'GET') {
    const bytes = await readByIdentity(env, ref);
    if (!bytes) return new Response('Not found', { status: 404 });
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-identity': ref } });
  }
  if (request.method !== 'POST') return null;
  if (!env.OPERATOR_ACCOUNT_ID || !await serviceOwnerAsks(env, request)) return Response.json({ error: 'Only whoever runs this service can keep its files.' }, { status: 403 });
  if (ref === 'kept') {
    const { identities } = await request.json();
    const kept = [];
    for (const identity of Array.isArray(identities) ? identities.filter(item => IDENTITY.test(item)) : []) {
      if (await readPublishedFile(env, identity)
        || (await pool(env).fileOwners(identity)).includes(env.OPERATOR_ACCOUNT_ID)) kept.push(identity);
    }
    return Response.json({ kept });
  }
  if (!IDENTITY.test(ref)) return Response.json({ error: 'Name the file by its BLAKE3 identity, 1f: then 64 hex.' }, { status: 400 });
  try { await keepPublishedFile(env, ref, new Uint8Array(await request.arrayBuffer())); }
  catch (error) { return Response.json({ error: error.message }, { status: 422 }); }
  return Response.json({ identity: ref, kept_by: 'the service' });
}

// The screen bundles this Worker instance has unpacked lately, by identity: each is read and unpacked once, since the
// page asks for its files one after another. The oldest is let go when more are held.
// Only a bundle that was found is held: a miss (a page asking before the deploy kept its bundle) is asked again next
// time, never remembered as missing, since a remembered miss answered 404 for that bundle until the instance went away.
const UNPACKED_HELD = 16;
const unpacked = new Map();
function unpackedBundle(env, identity) {
  if (!unpacked.has(identity)) {
    unpacked.set(identity, readByIdentity(env, identity).then(bytes => {
      if (!bytes) { unpacked.delete(identity); return null; }
      return new Map(untarGz(bytes).filter(file => file.text !== null).map(file => [file.name, file.text]));
    }).catch(error => { unpacked.delete(identity); throw error; }));
    if (unpacked.size > UNPACKED_HELD) unpacked.delete(unpacked.keys().next().value);
  }
  return unpacked.get(identity);
}

// GET /workshop/modules/<bundle identity>/<file>: one script of a tool's screen bundle, kept for a year by the browser
// (a changed screen is a new bundle, so a new address), or 404. Any other path is not this route's. Any page may read
// it (the same program for everyone, holding no one's data), so the screen view an AI app draws in its own frame
// (src/screen-view.mjs) imports a tool's screen as the service's page does.
export async function handleScreenModule(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(SCREEN_MODULE_PREFIX) || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
  const [identity, ...rest] = url.pathname.slice(SCREEN_MODULE_PREFIX.length).split('/').map(decodeURIComponent);
  const name = rest.join('/');
  if (!IDENTITY.test(identity ?? '') || !name) return new Response('Not found', { status: 404 });
  const text = (await unpackedBundle(env, identity))?.get(name);
  if (text === undefined) return new Response('Not found', { status: 404 });
  return new Response(request.method === 'HEAD' ? null : text, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-identity': identity, 'access-control-allow-origin': '*' } });
}
