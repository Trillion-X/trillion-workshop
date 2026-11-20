// Resolve one shipped JSON section: a published Marketplace item replaces the shipped value, a withdrawn item yields
// nothing, and a section never published uses the shipped value. This module holds only that decision. The caller
// reads the publication state and supplies the identity, value check and item name, so no store is reached from here.
import { marketplaceContentSourceId } from '#tools/publish-each-shipped-json-section-on-its-own-in-the-marketplace/src/marketplace-content-source-id.mjs';

const unavailable = message => Object.assign(new Error(message), { status: 503, code: 'marketplace_content_source_unavailable' });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * source: { file, pointer } of the shipped section.
 * ports: {
 *   shelf                 the publication shelf the section lives on,
 *   makers                the identities whose publications count (none means the shipped value only),
 *   read({ shelf, id, makers }) -> { item: { maker, row } | null, adopted: boolean } (adopted stays true after withdrawal),
 *   check(value)          -> the canonical value, or throws,
 *   identityOf(value)     -> the identity a published row carries for that value,
 *   itemIdOf(maker, id)   -> the row id a publication of this section by this maker has,
 * }
 * Returns { id, from: 'published', found: true, revision, value } | { id, from: 'bootstrap', found: true, value }
 *       | { id, from: 'withdrawn', found: false }.
 */
export async function resolvePublishedContentSource(source, { bootstrap, shelf, makers, read, check, identityOf, itemIdOf }) {
  const id = marketplaceContentSourceId(source);
  if (!makers.length) return { id, from: 'bootstrap', found: true, value: check(bootstrap) };
  const state = await read({ shelf, id, makers });
  if (!record(state) || typeof state.adopted !== 'boolean' || (state.item !== null && !record(state.item)))
    throw unavailable('The content item owner did not provide current publication and adoption evidence.');
  const item = state.item;
  if (item && makers.includes(item.maker)) {
    const row = item.row;
    if (!record(row) || row.id !== itemIdOf(item.maker, id) || (row.logical_id !== undefined && row.logical_id !== id)
      || row.format !== 'json' || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Object.hasOwn(row, 'value'))
      throw unavailable('The default content publication has no exact versioned JSON section.');
    if (row.source && marketplaceContentSourceId(row.source) !== id)
      throw unavailable('The content publication names another source coordinate.');
    const value = check(row.value);
    if (row.value_identity !== identityOf(value))
      throw unavailable('The default content value differs from its published identity.');
    return { id, from: 'published', found: true, revision: row.revision, value };
  }
  if (state.adopted) return { id, from: 'withdrawn', found: false };
  return { id, from: 'bootstrap', found: true, value: check(bootstrap) };
}
