// PURPOSE
//   Every tool target opens in the whole workspace with the same addressed screen and exact input.
//   Addresses use the workspace's shared resolver; an explicit screen carries its input without a URL round-trip.
// INVARIANTS
//   Only offered rows resolve. Query inputs are preserved. No screen, tool, person or host is enumerated here.
import { screensAtAddress } from './addresses.mjs';

export function screensFromAddress(rows, address, origin) {
  let url;
  try { url = new URL(address, origin); } catch { return []; }
  if (url.origin !== new URL(origin).origin) return [];
  return screensAtAddress(rows, url.pathname, url.search);
}

/** A tool's exact target, including input that has no URL representation. */
export function workspaceInputFor(screen) {
  return screen && typeof screen.id === 'string'
    ? { open_screen: { id: screen.id, input: { ...(screen.input ?? {}) }, ...(screen.address ? { address: screen.address } : {}) } }
    : {};
}

/** The same target outside the chat, including an item and declared query inputs such as a saved view. */
export function addressForScreen(rows, screen, origin) {
  if (screen?.address) return new URL(screen.address, origin).href;
  const row = rows.find(item => item.id === screen?.id);
  const input = { ...(row?.surface_input ?? {}), ...(screen?.input ?? {}) };
  const routed = row?.route_input && typeof input[row.route_input] === 'string';
  const path = row?.route_prefix && routed
    ? `${row.route_prefix}${encodeURIComponent(input[row.route_input])}${row.route_item_input && typeof input[row.route_item_input] === 'string' ? `/${encodeURIComponent(input[row.route_item_input])}` : ''}`
    : row?.route_paths?.[0] ?? '/';
  const url = new URL(path, origin);
  for (const [field, name] of Object.entries({ ...row?.route_query, ...row?.route_query_on_path })) {
    if (typeof input[name] === 'string' && input[name]) url.searchParams.set(field, input[name]);
  }
  return url.href;
}

/** An optional workspace opening can name an address, an offered id/label, or an exact prior screen. */
export function screensForWorkspace(rows, input = {}, origin) {
  const exact = input.open_screen;
  if (exact && typeof exact.id === 'string') {
    const row = rows.find(item => item.id === exact.id);
    if (!row) return [];
    const routed = exact.address ? screensFromAddress(rows, exact.address, origin).find(item => item.row.id === row.id) : null;
    return [{ row, input: { ...(routed?.input ?? {}), ...(exact.input ?? {}) } }];
  }
  const open = typeof input.open === 'string' ? input.open.trim() : '';
  if (!open) return [];
  if (open.startsWith('/')) return screensFromAddress(rows, open, origin);
  const row = rows.find(item => item.id === open || String(item.label ?? '').toLowerCase() === open.toLowerCase());
  return row ? [{ row, input: {} }] : [];
}
