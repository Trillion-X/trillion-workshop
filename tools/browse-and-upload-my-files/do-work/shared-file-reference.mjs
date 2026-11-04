// Readable mounted names come from the existing member catalog. Exact space/item references remain
// metadata, never a contributor-private lookup. Stable short tags prevent renamed or duplicate labels
// from binding a cached path to a different grant. These tags use the Workshop's one BLAKE3 owner (tools/content-identity).
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const IDENTITY = /^1f:[a-f0-9]{64}$/;
const selectedTags = Symbol('selected shared file names');
export function sharedReference(value = {}) {
  if (!value || typeof value !== 'object') throw new Error('A shared file needs its exact space_id and item_id.');
  if (value.space_id === undefined && value.item_id === undefined) return null;
  if (![value.space_id, value.item_id].every(id => typeof id === 'string' && ID.test(id))) throw new Error('A shared file needs its exact space_id and item_id.');
  return { space_id: value.space_id, item_id: value.item_id };
}
const utf8ToBytes = text => new TextEncoder().encode(text);
const tagOf = value => makeHashCodeHexFromBytes(utf8ToBytes(value)).slice(3, 15);
const bounded = (value, bytes = 200) => {
  let out = '', length = 0;
  for (const character of value) { const next = utf8ToBytes(character).length; if (length + next > bytes) break; out += character; length += next; }
  return out;
};
const cleanLabel = (value, fallback, limit = 200) => {
  const label = String(value ?? '').normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
  return bounded(label && !['.', '..'].includes(label) ? label : fallback, limit);
};
const defaultFilename = mediaType => {
  const extension = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'image/png': 'png', 'image/jpeg': 'jpg',
    'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'application/pdf': 'pdf', 'text/plain': 'txt' }[mediaType];
  return `Shared file${extension ? `.${extension}` : ''}`;
};
const checkedRoot = root => {
  if (typeof root !== 'string' || !/^\/[^/\x00-\x1f\x7f]{1,100}$/.test(root) || ['/.', '/..'].includes(root)) throw new Error('The shared Namespace needs its configured root folder.');
  return root;
};
export function sharedSpaceName(root, { space_id, title } = {}) {
  if (typeof space_id !== 'string' || !ID.test(space_id)) throw new Error('The shared company needs its exact space_id.');
  return `${checkedRoot(root)}/${cleanLabel(title, 'Shared company')} (${tagOf(space_id)})`;
}
export function sharedNamespaceName(root, value, name, mediaType = null, spaceTitle = null) {
  const reference = sharedReference(value);
  if (!reference) throw new Error('Name the shared file by its space_id and item_id.');
  const leaf = String(name ?? defaultFilename(mediaType)).split(/[\\/]/).at(-1);
  const label = cleanLabel(leaf, defaultFilename(mediaType), Number.MAX_SAFE_INTEGER);
  const extension = /\.[A-Za-z0-9]{1,16}$/.exec(label)?.[0] ?? '';
  const stem = bounded(extension ? label.slice(0, -extension.length) : label, 180) || 'Shared file';
  return `${sharedSpaceName(root, { ...reference, title: spaceTitle })}/${stem} (${tagOf(`${reference.space_id}\0${reference.item_id}`)})${extension}`;
}
export function sharedNamespaceSelector(root, name) {
  checkedRoot(root);
  if (name === root) return { kind: 'root' };
  if (typeof name !== 'string' || !name.startsWith(`${root}/`)) return null;
  const parts = name.slice(root.length + 1).split('/');
  if (parts.length > 2 || parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f]/.test(part))) return null;
  return parts.length === 1 ? { kind: 'space', name } : { kind: 'file', name, space_name: `${root}/${parts[0]}` };
}
export function sharedFileEntry(root, reference, row, name, spaceTitle = null) {
  if (typeof row?.identity !== 'string' || !IDENTITY.test(row.identity) || !Number.isSafeInteger(row.byte_length) || row.byte_length < 0) throw new Error('The shared file owner did not confirm its identity and size.');
  return { ...sharedReference(reference), name: sharedNamespaceName(root, reference, name, row.media_type, spaceTitle), folder: false,
    identity: row.identity, byte_length: row.byte_length, media_type: row.media_type ?? null };
}
export function sharedByteAddress(origin, row) {
  if (typeof row?.identity !== 'string' || !IDENTITY.test(row.identity)) throw new Error('The shared file owner did not confirm its identity.');
  let address;
  try { address = new URL(row?.url); } catch { throw new Error('The shared file owner did not return a read address.'); }
  if (address.origin !== new URL(origin).origin || address.pathname !== `/namespace/bytes/${row.identity}`
    || !address.searchParams.get('lease') || address.username || address.password || address.hash
    || !Number.isFinite(Date.parse(row.url_expires_at)) || Date.parse(row.url_expires_at) <= Date.now()) throw new Error('The shared file read address does not match its owner or is expired.');
  return address.href;
}
const readWith = (control, signal) => async route => {
  const { status, body } = await control(route, signal ? { signal } : undefined);
  if (status !== 200 || body?.error) throw Object.assign(new Error(body?.error ?? `The shared files could not be read (${status}).`), { status: status === 200 ? 403 : status });
  return body;
};
// A single native admission pass may reuse catalog responses. This never memoizes /file permission or a lease,
// and the caller creates a fresh map for the mandatory recheck after native admission.
const catalogReadWith = (control, signal, catalog) => {
  const read = readWith(control, signal);
  return route => {
    if (!catalog || route !== '/spaces' && !/\/items\?/.test(route)) return read(route);
    if (!catalog.has(route)) catalog.set(route, read(route));
    return catalog.get(route);
  };
};
function uniqueTag(seen, token, reference) {
  if (seen.has(token) && seen.get(token) !== reference) throw new Error('Two shared names have the same identifier. Neither can be safely mounted.');
  seen.set(token, reference);
}
async function spacesAt(root, read) {
  const page = await read('/spaces');
  if (!Array.isArray(page.spaces)) throw new Error('The shared spaces did not return their catalog.');
  const spaces = new Map(), tags = new Map();
  for (const space of page.spaces) if (typeof space?.space_id === 'string' && ID.test(space.space_id)) {
    uniqueTag(tags, tagOf(space.space_id), space.space_id);
    const name = sharedSpaceName(root, space);
    spaces.set(name, { name, folder: true, space_id: space.space_id, display_name: space.title ?? 'Shared company',
      modified_at_ms: Number.isFinite(Date.parse(space.last_activity_at)) ? Date.parse(space.last_activity_at) : null });
  }
  return spaces;
}
const visibleFile = item => typeof item?.item_id === 'string' && ID.test(item.item_id) && item.kind === 'file'
  && !item.withdrawn && !item.hidden && item.body && IDENTITY.test(item.body.identity ?? '');
async function entryFor(root, space, item, read, authoritative = null) {
  const reference = { space_id: space.space_id, item_id: item.item_id };
  let row = authoritative ?? item.body;
  if (row.identity !== item.body.identity) throw new Error('The shared file changed while its mounted name was checked.');
  if (!Number.isSafeInteger(row.byte_length) || row.byte_length < 0) row = await read(`/spaces/${encodeURIComponent(space.space_id)}/items/${encodeURIComponent(item.item_id)}/file`);
  if (row.identity !== item.body.identity || Number.isSafeInteger(item.body.byte_length) && item.body.byte_length >= 0 && item.body.byte_length !== row.byte_length) throw new Error('The shared file changed while its mounted name was checked.');
  const entry = sharedFileEntry(root, reference, row, item.body.name ?? item.title, space.display_name);
  entry.named_at = item.provenance?.added_at ?? null;
  return entry;
}
async function filesAt(root, space, read) {
  const entries = new Map(), cursors = new Set(), tags = new Map();
  let before = '';
  do {
    const page = await read(`/spaces/${encodeURIComponent(space.space_id)}/items?kind=file&limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    if (page.space_id !== space.space_id || !Array.isArray(page.items)) throw new Error('The shared file catalog did not match this space.');
    for (const item of page.items) {
      if (!visibleFile(item)) continue;
      const reference = { space_id: space.space_id, item_id: item.item_id };
      uniqueTag(tags, tagOf(`${reference.space_id}\0${reference.item_id}`), reference.item_id);
      const entry = await entryFor(root, space, item, read);
      entries.set(entry.name, entry);
    }
    before = page.next_before;
    if (before && (typeof before !== 'string' || cursors.has(before))) throw new Error('The shared file catalog repeated its page cursor.');
    if (before) cursors.add(before);
  } while (before);
  return entries;
}
/** Browsing maps readable names through the existing catalog; no opaque-id folder or contributor-private road. */
export async function sharedNamespaceFolder(root, selector, control, { signal } = {}) {
  const read = readWith(control, signal), spaces = await spacesAt(root, read);
  if (selector.kind === 'root') return spaces;
  const space = selector.space_id ? [...spaces.values()].find(entry => entry.space_id === selector.space_id) : spaces.get(selector.space_name ?? selector.name);
  if (!space) return new Map();
  return filesAt(root, space, read);
}
/** Exact item reads use the existing member owner; a native opening never walks unrelated company uploads. */
export async function sharedNamespaceFile(root, value, control, { signal, row, catalog } = {}) {
  const reference = sharedReference(value);
  if (!reference) throw new Error('Name the shared file by its space_id and item_id.');
  const read = catalogReadWith(control, signal, catalog), spaces = await spacesAt(root, read);
  const space = [...spaces.values()].find(entry => entry.space_id === reference.space_id);
  if (!space) return null;
  const page = await read(`/spaces/${encodeURIComponent(reference.space_id)}/items?kind=file&limit=1&item_id=${encodeURIComponent(reference.item_id)}`);
  if (page.space_id !== reference.space_id || !Array.isArray(page.items) || page.items.length > 1 || page.next_before
    || page.items.some(item => item?.item_id !== reference.item_id)) throw new Error('The shared file catalog did not match this exact file.');
  const item = page.items[0];
  if (!visibleFile(item)) return null;
  // Finder's complete listing still refuses collisions across every file. Within an admission pass,
  // refuse colliding selections too; native location then checks this same readable catalog mapping.
  let tags = catalog?.get(selectedTags);
  if (!tags) { tags = new Map(); catalog?.set(selectedTags, tags); }
  uniqueTag(tags, `${reference.space_id}\0${tagOf(`${reference.space_id}\0${reference.item_id}`)}`, reference.item_id);
  return entryFor(root, space, item, read, row);
}
