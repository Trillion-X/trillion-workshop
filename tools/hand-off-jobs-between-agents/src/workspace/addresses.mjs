// src/workspace/addresses.mjs
//
// PURPOSE
//   Which workspace screen an address opens, read from the screens' own DATA (surfaces.json): a screen's `route_paths`
//   are its exact addresses, an address one step under its `route_prefix` opens it with the rest as its `route_input`,
//   an address one step further opens it on one item inside it, kept under the row's `route_item_input` (a tool's
//   screen opened at one post: `/use/<tool>/<item>`), `home_path` opens the workspace on its starting screens, an
//   address under a `route_prefix` whose input is exactly
//   another row's own input for the same entry opens that row (so `/use/tool:<name>` opens the tool's own screen row,
//   titled with its own name), an address under one of `moved_from` is an old address whose new one is the same
//   address without that prefix, and an address at or one step under a `from` of
//   `signed_in_moved` is, for someone signed in, the same address under its `to`. The Worker (src/worker.mjs) and the page (main.tsx) both
//   answer from here, so the address a person sees and the screen that opens can never disagree. A row's `route_query`
//   names query fields that open it too, on any path (screensOfQuery).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No screen is named here: every answer comes from the rows passed in.
//   2. Resolution is one lookup over the rows a viewer is offered. Offering a person or a segment different rows (a
//      screen's `audience`, or later a different screen for the same address) changes what an address opens without
//      touching this module or the Worker.
//   3. A moved address answers only when its new address opens a screen, so an old path that still names an action
//      (/work/api/..., /work/live, /work/connect/...) is never redirected.
import { withViewTransition } from './view-transition.mjs';

/**
 * The screen `pathname` opens among `rows` (the screens offered to this viewer), or null.
 * @returns {{ row: object, input: Record<string, string> | null } | null}
 */
export function screenAt(rows, pathname, search = '') {
  const queryStart = pathname.indexOf('?');
  const path = queryStart < 0 ? pathname : pathname.slice(0, queryStart);
  const query = new URLSearchParams(search || (queryStart < 0 ? '' : pathname.slice(queryStart)));
  // Query-qualified addresses are DATA aliases for an offered screen. The most
  // specific matching alias wins; an unoffered screen never becomes reachable.
  const qualified = rows.flatMap(row => (row.route_paths ?? []).flatMap(address => {
    const split = address.indexOf('?');
    if (split < 0 || address.slice(0, split) !== path) return [];
    const required = [...new URLSearchParams(address.slice(split))];
    return required.length && required.every(([field, value]) => query.get(field) === value)
      ? [{ row, specificity: required.length }] : [];
  })).sort((a, b) => b.specificity - a.specificity)[0];
  if (qualified) return { row: qualified.row, input: null };
  // An exact address wins over any prefix it also falls under (a tool's own /use/<name> over the generic /use/).
  const exact = rows.find(row => row.route_paths?.includes(path));
  if (exact) return { row: exact, input: null };
  for (const row of rows) {
    const prefix = row.route_prefix;
    if (!prefix || !row.route_input || !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    // One more step names an item inside it (`/use/<tool>/<item>`) for a row that says which input carries it.
    const [first, item, ...more] = rest.split('/');
    if (!first || more.length || (item !== undefined && !(row.route_item_input && item))) continue;
    const input = { [row.route_input]: decodeURIComponent(first) };
    const itemInput = item === undefined ? null : { [row.route_item_input]: decodeURIComponent(item) };
    // The same screen with the same input may be a row of its own (a tool's screen row under the generic /use/): that
    // row opens, so its tab carries its own name and it is the same tab the sidebar opens, with the item it was asked for.
    const own = rows.find(other => other !== row && (other.route_paths?.includes(`${prefix}${first}`)
      || (other.package_entry?.entry_name === row.package_entry?.entry_name && Object.entries(input).every(([name, value]) => other.surface_input?.[name] === value))));
    return own ? { row: own, input: itemInput } : { row, input: { ...input, ...itemInput } };
  }
  return null;
}

/**
 * The screens an address's query asks for besides its path's (`?meeting=<code>` opens Record joined to that meeting,
 * on any path): each row's `route_query` maps a query field to the input it opens the screen with, so any screen can
 * be opened from any address by naming one more field in its row.
 * @returns {{ row: object, input: Record<string, string> }[]}
 */
export function screensOfQuery(rows, search) {
  const query = new URLSearchParams(search);
  return rows.flatMap(row => {
    const input = Object.fromEntries(Object.entries(row.route_query ?? {}).flatMap(([field, name]) => (query.get(field) ? [[name, query.get(field)]] : [])));
    return Object.keys(input).length ? [{ row, input }] : [];
  });
}

/** The path and its query ask for one copy of each screen. A query about the path's own screen selects that screen.
 *  The path's screen keeps the address's query as its input (`/connections?show_row=facebook-messenger` opens
 *  Connections narrowed to that row), except what its own row fixes (`screen`), whichever address opens it. */
export function screensAtAddress(rows, pathname, search) {
  const routed = screenAt(rows, pathname, search);
  const queried = screensOfQuery(rows, search);
  if (!routed) return queried;
  const query = new URLSearchParams(search);
  const fixed = routed.row.surface_input ?? {};
  // A field some screen's `route_query` (or this path's `route_query_on_path`) names is read under its own input name, so it is not carried raw.
  const mapped = new Set([...rows.flatMap(row => Object.keys(row.route_query ?? {})), ...Object.keys(routed.row.route_query_on_path ?? {})]);
  const given = Object.fromEntries([...query].filter(([name]) => !(name in fixed) && !mapped.has(name)));
  const onOwnPath = Object.fromEntries(Object.entries(routed.row.route_query_on_path ?? {}).flatMap(([field, name]) => (query.get(field) ? [[name, query.get(field)]] : [])));
  const own = queried.find(asked => asked.row.id === routed.row.id);
  return [
    { row: routed.row, input: { ...given, ...(routed.input ?? {}), ...onOwnPath, ...(own?.input ?? {}) } },
    ...queried.filter(asked => asked.row.id !== routed.row.id),
  ];
}

/** The screen the path of an address opens with all that address asks of it (screensAtAddress), or null when the path
 *  opens none; the one answer a link or a request to open an address in place reads. */
export const screenOfAddress = (rows, pathname, search = '') => (screenAt(rows, pathname, search) ? screensAtAddress(rows, pathname, search)[0] : null);

/**
 * The one screen an address inside the workspace opens, with everything it opens on: the row's own input, what the
 * path routes to and the address's query (`/connections?show_row=facebook-messenger`), or null when the address is
 * another origin's or opens no screen. The hold, the waiting screen (a thing's `does_in` drawn in place) and the store
 * (whether a filed thing names a real place) all resolve an address here, so they can never disagree.
 * @returns {{ row: object, input: Record<string, unknown> } | null}
 */
export function placeOfAddress(rows, address, origin) {
  let url;
  try { url = new URL(address, origin); } catch { return null; }
  if (url.origin !== new URL(origin).origin || !screenAt(rows, url.pathname, url.search)) return null;
  const [routed] = screensAtAddress(rows, url.pathname, url.search);
  if (!routed) return null;
  return { row: routed.row, input: { ...routed.row.surface_input, ...(routed.input ?? {}) } };
}

/** Whether an address resolves to one of the offered surfaces named by a caller's policy. */
export function addressOpensOneOfSurfaces(rows, address, origin, surfaceIds) {
  if (!Array.isArray(surfaceIds) || !surfaceIds.length) return false;
  const place = placeOfAddress(rows, address, origin);
  return Boolean(place && surfaceIds.includes(place.row.id));
}

/** Workspace address writes notify open gates when an in-page navigation changes the browser URL. */
export const WORKSPACE_ADDRESS_CHANGED = 'trillion:workspace-address-changed';

export function pushWorkspaceAddress(state, address) {
  // An in-page move to another screen crossfades at the look's pace (view-transition.mjs); the move itself is the same.
  withViewTransition(() => {
    history.pushState(state, '', address);
    window.dispatchEvent(new Event(WORKSPACE_ADDRESS_CHANGED));
  });
}

export function replaceWorkspaceAddress(state, address) {
  history.replaceState(state, '', address);
  window.dispatchEvent(new Event(WORKSPACE_ADDRESS_CHANGED));
}

export function watchWorkspaceAddress(listener, target = window) {
  target.addEventListener('popstate', listener);
  target.addEventListener(WORKSPACE_ADDRESS_CHANGED, listener);
  return () => {
    target.removeEventListener('popstate', listener);
    target.removeEventListener(WORKSPACE_ADDRESS_CHANGED, listener);
  };
}

/**
 * Whether `address` opens a screen the address's query can narrow (`narrowing.entry`: the guide screens, cut down by
 * src/account-routes.mjs narrowedTo) while naming nothing to narrow it to (none of `narrowing.fields`), so it would
 * open the whole screen. Filing refuses such a place for a single thing to do (src/waiting-filing.mjs).
 */
export function opensWholeNarrowable(rows, narrowing, address, origin) {
  const place = placeOfAddress(rows, address, origin);
  if (!place || !narrowing || place.row.package_entry?.entry_name !== narrowing.entry) return false;
  return !narrowing.fields.some(field => String(place.input[field] ?? '').replace(/["\s]/g, ''));
}

/** Whether `pathname` is the workspace's own home address, or one of its screens' addresses. */
export const opensWorkspace = (data, pathname) => pathname === data.home_path || screenAt(data.surfaces, pathname) !== null;

/** The new address of an old one (`/work/files` -> `/files`, `/work` -> `/`), or null when it is not an old address. */
export function movedAddress(data, pathname) {
  for (const from of data.moved_from ?? []) {
    if (pathname === from) return data.home_path;
    if (!pathname.startsWith(`${from}/`)) continue;
    const moved = pathname.slice(from.length);
    if (screenAt(data.surfaces, moved) || signedInMovedAddress(data, moved)) return moved;
  }
  return null;
}

/**
 * For someone signed in, the address an old one now opens (`/community` -> `/spaces`, `/community/c1` -> `/spaces/c1`),
 * from `signed_in_moved`, or null. Only an address whose new one opens a screen moves, so what else answers under the
 * old prefix (`/community/events/e1/calendar`) keeps its address.
 */
export function signedInMovedAddress(data, pathname) {
  for (const { from, to } of data.signed_in_moved ?? []) {
    if (pathname === from) return to;
    // Only one step under it: a deeper old address (`/community/c1/join`) is its own route, even where the new prefix
    // opens one item inside the screen (`/spaces/c1/<item>`).
    if (!pathname.startsWith(`${from}/`) || pathname.slice(from.length + 1).includes('/')) continue;
    const moved = `${to}${pathname.slice(from.length)}`;
    if (screenAt(data.surfaces, moved)) return moved;
  }
  return null;
}

/** A screen's own address (the first of its `route_paths`), found by its surface id; the home address when it has none. */
export const addressOf = (data, surfaceId) => data.surfaces.find(row => row.id === surfaceId)?.route_paths?.[0] ?? data.home_path;

/** The address of one item under a screen's `route_prefix` (a decision's, a space's). */
export const itemAddressOf = (data, surfaceId, id) => `${data.surfaces.find(row => row.id === surfaceId).route_prefix}${encodeURIComponent(id)}`;

/**
 * The address of one thing, the one shape every surface that points at a thing uses (a notice and its buttons, a widget
 * or Live Activity row, an email, a mention chip): the screen whose `opens_kinds` names the thing's kind, on that thing
 * when the screen opens one thing at a time (its `route_prefix`), and on one `item` inside it (a list's row, a space's
 * message) when the screen opens items (`route_item_input`), else the screen's own address. Null when no screen opens
 * the kind or no id is given, so a caller can say where else to go.
 * @returns {string | null}
 */
export function thingAddress(data, kind, id, item = null) {
  if (typeof kind !== 'string' || id === undefined || id === null || String(id) === '') return null;
  const screen = thingScreen(data, kind);
  if (!screen) return null;
  if (!screen.route_prefix) return screen.route_paths?.[0] ?? null;
  const inside = screen.route_item_input && item !== undefined && item !== null && String(item) !== '' ? `/${encodeURIComponent(String(item))}` : '';
  return `${screen.route_prefix}${encodeURIComponent(String(id))}${inside}`;
}

/** The screen that opens things of `kind` (its `opens_kinds`), or null. */
export const thingScreen = (data, kind) => data.surfaces.find(row => row.opens_kinds?.includes(kind)) ?? null;

/**
 * Where to send someone after signing in, from the `next` they came with: one of the workspace's addresses (an old one
 * given as its new address), with its query kept, or null when `next` is anything else.
 */
export function signedInReturn(data, next) {
  if (typeof next !== 'string' || !/^\/(?![/\\])[^\\]*$/.test(next)) return null;
  const at = next.search(/[?#]/);
  const path = at < 0 ? next : next.slice(0, at);
  const query = at < 0 ? '' : next.slice(at);
  if (opensWorkspace(data, path)) return next;
  const moved = movedAddress(data, path) ?? signedInMovedAddress(data, path);
  return moved ? `${moved}${query}` : null;
}

/**
 * The sign-in page's address, carrying where to go after signing in as a readable `next` (`/account?next=/activity`):
 * encoded like any query value, with its slashes left as they are. Signing in returns there when `signedInReturn` takes it.
 */
export const signInAddress = next => (next ? `/account?${new URLSearchParams({ next }).toString()}` : '/account');
