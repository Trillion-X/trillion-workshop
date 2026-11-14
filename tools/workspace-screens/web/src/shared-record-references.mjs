// References describe a record's associated files or records; they grant no access.
// Field semantics are DATA so the shared viewer is not restricted to a record kind.
// Pages stay bounded and preserve source order. Private URLs are never extracted.
import definition from './shared-record-references.json' with { type: 'json' };
import { CONTENT_IDENTITY } from './namespace-preview.mjs';

const valueOf = value => typeof value === 'string' && value.trim() ? value.trim() : null;
// Preserve existing content identities and uploads; only current Namespace grants
// admit them. Reading an older identity never creates a new digest of that kind.
const identityOf = value => typeof value === 'string' && (CONTENT_IDENTITY.test(value) || /^up:[0-9a-f]{32}$/.test(value)) ? value : null;

export function sharedRecordReferencePage(body, { after = null, limit = definition.page_size } = {}) {
  const offset = after == null ? 0 : Number(after);
  if (!Number.isSafeInteger(offset) || offset < 0 || (after != null && String(offset) !== String(after))) throw new Error('Choose a valid file page.');
  const size = Number(limit);
  if (!Number.isSafeInteger(size) || size < 1 || size > definition.maximum_page_size) throw new Error(`Choose between 1 and ${definition.maximum_page_size} files per page.`);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { references: [], next_after: null };
  const references = [];
  const seen = new Set();
  let position = 0;
  for (const field of definition.fields) {
    const supplied = body[field.field];
    const values = field.many ? (Array.isArray(supplied) ? supplied : []) : [supplied];
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      const record = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
      const name = field.source === 'file' ? valueOf(record?.name ?? record?.file ?? record?.path ?? (typeof value === 'string' ? value : null)) : null;
      const identity = field.source === 'file' ? identityOf(record?.identity) : null;
      // An explicitly malformed identity cannot fall back to a same-named file.
      if (record?.identity != null && !identity) continue;
      const itemId = field.source === 'item' ? valueOf(record?.item_id ?? record?.record ?? value) : valueOf(record?.item_id);
      if (!name && !identity && !itemId) continue;
      const keys = [identity && `${field.role}:identity:${identity}`, name && `${field.role}:name:${name}`, itemId && `${field.role}:item:${itemId}`].filter(Boolean);
      if (keys.some(key => seen.has(key))) continue;
      keys.forEach(key => seen.add(key));
      if (position++ < offset) continue;
      if (references.length === size) return { references, next_after: String(position - 1) };
      references.push({ key: `${field.field}:${index}`, role: field.role, source: field.source, ...(name ? { name } : {}), ...(identity ? { identity } : {}), ...(itemId ? { item_id: itemId } : {}) });
    }
  }
  return { references, next_after: null };
}

export function sameSharedRecord(left, right) {
  return Boolean(left && right && !left.withdrawn && !right.withdrawn
    && left.item_id === right.item_id && left.kind === right.kind
    && left.title === right.title && JSON.stringify(left.body) === JSON.stringify(right.body)
    && JSON.stringify(left.hidden ?? null) === JSON.stringify(right.hidden ?? null));
}

/** Exact partial indexes are part of this read's contract: SQLite may otherwise prefer the broad kind-count index. */
export function sharedRecordFileLookup(spaceId, reference) {
  if (reference.item_id) return { query: "SELECT id FROM space_items WHERE id = ? AND space_id = ? AND kind = 'file' AND withdrawn_at IS NULL LIMIT 2", binds: [reference.item_id, spaceId] };
  if (!reference.identity && !reference.name) throw new Error('Choose an exact shared file reference.');
  const index = reference.identity ? 'space_items_file_identity' : 'space_items_file_name';
  return { query: `SELECT id FROM space_items INDEXED BY ${index} WHERE space_id = ? AND kind = 'file' AND withdrawn_at IS NULL${reference.identity ? " AND json_extract(body, '$.identity') = ?" : ''}${reference.name ? " AND json_extract(body, '$.name') = ?" : ''} LIMIT 2`,
    binds: [spaceId, ...(reference.identity ? [reference.identity] : []), ...(reference.name ? [reference.name] : [])] };
}
