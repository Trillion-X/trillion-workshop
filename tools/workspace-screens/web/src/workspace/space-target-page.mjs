// An addressed item is loaded by id even when it is outside the first page. Both reads use the ordinary Space
// item owner and its permissions. The page keeps its normal cursor; opening a target never walks older history.
import limits from './space-target-page.json' with { type: 'json' };

export const spacePageKey = kinds => JSON.stringify([...new Set(kinds ?? [])].sort());

// A list's declared kinds select its owner rows before pagination. Several kinds share one chronological
// cursor: merge their bounded pages, and continue strictly before the last returned owner row.
const encoder = new TextEncoder();
const cursorOf = row => `${row.provenance.added_at}${row.item_id}`;

// Protective page limits (space-target-page.json). A page over either limit is cut, not refused: the longest run of
// rows from the top that fits at most max_items rows and max_page_bytes of JSON. A single row over the byte cap is
// still returned alone, so the caller can page on past it.
function fitRows(page, rows) {
  let count = Math.min(rows.length, limits.max_items);
  while (count > 1 && encoder.encode(JSON.stringify({ ...page, items: rows.slice(0, count) })).byteLength > limits.max_page_bytes) count -= 1;
  return rows.slice(0, count);
}

function pageItems(page) {
  if (!Array.isArray(page?.items)) throw new Error('This list page has no items.');
  return page.items;
}

export async function readSpaceListPage(address, read, { kinds, before, limit = limits.default_limit } = {}) {
  const selected = JSON.parse(spacePageKey(kinds));
  if (selected.length > 16 || selected.some(kind => typeof kind !== 'string' || !kind)) throw new Error('This list has invalid kinds.');
  if (!Number.isInteger(limit) || limit < 1 || limit > limits.max_items) throw new Error('This list has an invalid page size.');
  const path = kind => {
    const query = new URLSearchParams();
    if (kind) query.set('kind', kind);
    if (before) query.set('before', before);
    if (selected.length) query.set('limit', String(limit));
    return `${address}/items${query.size ? `?${query}` : ''}`;
  };
  if (selected.length < 2) {
    const page = await read(path(selected[0]));
    const items = fitRows(page, pageItems(page));
    return items.length === page.items.length ? page : { ...page, items, next_before: cursorOf(items.at(-1)) };
  }
  const pages = await Promise.all(selected.map(kind => read(path(kind))));
  const kept = pages.map(page => {
    const items = fitRows(page, pageItems(page));
    return { items, cut: items.length < page.items.length };
  });
  // A kind page cut short leaves its older rows unread, so only rows at or above the highest such cut are safe to show.
  const floor = kept.filter(part => part.cut).map(part => cursorOf(part.items.at(-1)))
    .reduce((high, key) => high === null || key > high ? key : high, null);
  const rows = [...new Map(kept.flatMap(part => part.items).map(row => [row.item_id, row])).values()]
    .filter(row => floor === null || cursorOf(row) >= floor)
    .sort((a, b) => cursorOf(a) < cursorOf(b) ? 1 : cursorOf(a) > cursorOf(b) ? -1 : 0);
  const items = fitRows(pages[0], rows.slice(0, limit));
  const more = rows.length > items.length || floor !== null || pages.some(page => page.next_before);
  return { ...pages[0], items, next_before: items.length && more ? cursorOf(items.at(-1)) : null };
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
