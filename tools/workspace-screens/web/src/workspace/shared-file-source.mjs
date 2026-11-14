// A browser tool's reference-capable picker reads shared metadata through the existing company owner.
// It never copies bytes, changes private listings, or treats a shared identity as a private file.
import { sharedFileSelection } from './file-input-bindings.mjs';

const ROOT = '@tool-file-references';
const PERSONAL = '@my-file-references';
const SHARED = '@shared-file-references';
const identityOf = value => typeof value === 'string' && /^1f:[a-f0-9]{64}$/.test(value);

export function sharedFileEntry(spaceId, item) {
  if (!item || item.kind !== 'file' || item.withdrawn || item.hidden || typeof item.item_id !== 'string' || !item.item_id.trim()) return null;
  let body = item.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return null; } }
  if (!body || typeof body !== 'object' || !identityOf(body.identity) || body.stored === false) return null;
  const path = typeof body.name === 'string' && body.name ? body.name : String(item.title ?? '');
  if (!path) return null;
  const name = path.split('/').filter(Boolean).at(-1) ?? path;
  return { id: sharedFileSelection({ identity: body.identity, space_id: spaceId, item_id: item.item_id, name: path, byte_length: body.byte_length }),
    name, folder: false, media_type: body.media_type ?? null, path };
}

/** One folder page per request. A chooser owns this cursor state; it is never shared across accounts or mounts. */
export function filePages(readPage, entriesOf, cursorOf) {
  const folders = new Map();
  return async (folder, index) => {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('This folder page could not be read.');
    let state = folders.get(folder);
    if (!state) { state = { generation: 0, cursors: new Map([[0, '']]), pending: new Map() }; folders.set(folder, state); }
    if (state.pending.has(index)) return state.pending.get(index);
    if (index === 0) { state.generation++; state.cursors = new Map([[0, '']]); state.pending = new Map(); }
    if (!state.cursors.has(index)) throw new Error('Open this folder again to read its files.');
    const generation = state.generation;
    const cursor = state.cursors.get(index);
    const request = Promise.resolve().then(async () => {
      const page = await readPage(folder, cursor);
      if (state.generation !== generation) throw new Error('This folder changed. Open it again.');
      const entries = entriesOf(page, index);
      const next = cursorOf(page);
      if (next !== null && next !== undefined && (typeof next !== 'string' || !next
          || [...state.cursors].some(([at, known]) => at !== index + 1 && known === next))) {
        throw new Error('This folder could not finish reading its files.');
      }
      for (const at of state.cursors.keys()) if (at > index) state.cursors.delete(at);
      if (next) state.cursors.set(index + 1, next);
      return { entries, more: Boolean(next) };
    });
    state.pending.set(index, request);
    try { return await request; }
    finally { if (state.pending.get(index) === request) state.pending.delete(index); }
  };
}

/** read and share are adapters to membership-checked owners. Each open chooser receives independent pagination. */
export function sharedFileSource({ spaceId, personal, read, share }) {
  if (spaceId === undefined || spaceId === null) return personal;
  if (typeof spaceId !== 'string' || !spaceId.trim() || spaceId.includes('/')) throw new Error('This pursuit could not open its files.');
  const space = spaceId.trim();
  const at = '/work/api/spaces/' + encodeURIComponent(space) + '/items?kind=file&limit=100';
  const roots = () => [
    { id: PERSONAL, name: 'Your files', folder: true },
    { id: SHARED, name: 'Shared files', folder: true },
  ];
  const pages = () => {
    const own = personal.pages?.();
    const shared = filePages((_folder, before) => read(at + (before ? '&before=' + encodeURIComponent(before) : '')), page => {
      if (page?.space_id !== space || !Array.isArray(page.items)) throw new Error('This pursuit could not read its files.');
      return [...new Map(page.items.map(item => sharedFileEntry(space, item)).filter(Boolean).map(entry => [entry.id, entry])).values()];
    }, page => page.next_before);
    return { list: async (folder, index) => {
      if (folder === ROOT) return { entries: index === 0 ? roots() : [], more: false };
      if (folder === SHARED) return shared(folder, index);
      const name = folder === PERSONAL ? personal.root : folder;
      if (own) return own.list(name, index);
      if (index !== 0) throw new Error('This folder page could not be read.');
      return { entries: await personal.list(name), more: false };
    } };
  };
  return {
    root: ROOT,
    pages,
    list: async folder => (await pages().list(folder, 0)).entries,
    upload: async (file, onProgress, signal) => {
      if (signal?.aborted) throw new Error('Adding this file was cancelled.');
      const kept = await personal.upload(file, onProgress, signal);
      if (signal?.aborted) throw new Error('Adding this file was cancelled.');
      const [itemId] = await share(space, [{ identity: kept.id, name: kept.name }]);
      if (!itemId) throw new Error('This file could not be shared here.');
      return { ...kept, id: sharedFileSelection({ identity: kept.id, space_id: space, item_id: itemId, name: kept.path ?? kept.name, byte_length: file.size }) };
    },
  };
}
