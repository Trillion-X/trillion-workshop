// An addressed item is loaded by id even when it is outside the first page. Both reads use the ordinary Space
// item owner and its permissions. The page keeps its normal cursor; opening a target never walks older history.
export const spacePageKey = kinds => JSON.stringify([...new Set(kinds ?? [])].sort());

// A list's declared kinds select its owner rows before pagination. Several kinds share one chronological
// cursor: merge their bounded pages, and continue strictly before the last returned owner row.
export async function readSpaceListPage(address, read, { kinds, before, limit = 30 } = {}) {
  const selected = JSON.parse(spacePageKey(kinds));
  if (selected.length > 16 || selected.some(kind => typeof kind !== 'string' || !kind)) throw new Error('This list has invalid kinds.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('This list has an invalid page size.');
  const path = kind => {
    const query = new URLSearchParams();
    if (kind) query.set('kind', kind);
    if (before) query.set('before', before);
    if (selected.length) query.set('limit', String(limit));
    return `${address}/items${query.size ? `?${query}` : ''}`;
  };
  if (selected.length < 2) return read(path(selected[0]));
  const pages = await Promise.all(selected.map(kind => read(path(kind))));
  const cursorOf = row => `${row.provenance.added_at}${row.item_id}`;
  const rows = [...new Map(pages.flatMap(page => page.items).map(row => [row.item_id, row])).values()]
    .sort((a, b) => cursorOf(a) < cursorOf(b) ? 1 : cursorOf(a) > cursorOf(b) ? -1 : 0);
  const items = rows.slice(0, limit);
  return { ...pages[0], items, next_before: items.length && (rows.length > limit || pages.some(page => page.next_before)) ? cursorOf(items.at(-1)) : null };
}

export async function readSpaceTargetPage(address, itemId, read, options) {
  const [page, target] = await Promise.all([
    readSpaceListPage(address, read, options),
    itemId ? read(`${address}/items?item_id=${encodeURIComponent(itemId)}`) : null,
  ]);
  if (!itemId) return page;
  const item = target.items.find(row => row.item_id === itemId && !row.hidden);
  if (!item) throw new Error('This item is no longer available in this pursuit.');
  const onPage = page.items.some(row => row.item_id === itemId);
  return { ...page, items: onPage ? page.items.map(row => row.item_id === itemId ? item : row) : [...page.items, item] };
}

// The newest page wins on duplicate IDs. Older loaded pages supply the rest, so a refreshed record replaces its
// stale copy wherever it was loaded without changing the page/cursor boundaries used by Show older.
export function reconcileLoadedSpaceItems(page, olderPages) {
  const items = new Map(page.items.map(item => [item.item_id, item]));
  for (const { page: older } of olderPages) for (const item of older.items) if (!items.has(item.item_id)) items.set(item.item_id, item);
  return [...items.values()];
}
