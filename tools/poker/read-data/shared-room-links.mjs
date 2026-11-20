// tools/poker/read-data/shared-room-links.mjs
//
// Browser join links for the Connect devices card. Pure functions: a route, a base address or a page location goes in, a
// link comes out. Nothing here reads a screen, a network or a stored file (the page location is read only when the caller
// gives none and a window exists).
//
// Ported from bitfield-packages d926b7adb8, packages/shared-room-connection/read-data/shared-room-connection.ts:
// makeSharedRoomOpenLinks (12-26), browserUrlForBase (28-31), browserUrlForRoute (33-40), isLoopbackUrl (66-76),
// normalizeRoutePath (87-91). Not ported: the bitfield:// app link and its screen scene (42-64), retired by the owner
// ruling of Sept 27 2026 (the old runtime is dead).

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function normalizeRoutePath(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeOrigin(value) {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : '';
}

export function currentLocation() {
  return typeof window === 'undefined' ? null : window.location;
}

// The route is joined under the base address, so a base with its own path keeps that path (the old code's leading slash
// made the URL resolve from the origin and dropped it: https://x.test/app + /room became https://x.test/room).
export function browserUrlForBase(routePath, baseUrl) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const route = normalizeRoutePath(routePath ?? '/').replace(/^\/+/, '');
  return new URL(route, base).toString();
}

export function browserUrlForRoute(routePath, location = currentLocation()) {
  const route = normalizeRoutePath(routePath ?? location?.pathname ?? '/');
  const origin = normalizeOrigin(location?.origin ?? '');
  return origin ? `${origin}${route}` : route;
}

// True for 127.0.0.1, localhost, ::1 and [::1]: a link to this machine that another device cannot open, so it is not offered.
export function isLoopbackUrl(value) {
  try {
    const url = new URL(value, 'http://placeholder.invalid');
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

// { routePath, location, browserBaseUrl } in; { browserUrl, browserHostIsLoopback } out. A base address wins over the page location.
export function makeSharedRoomOpenLinks({ routePath, location, browserBaseUrl } = {}) {
  const browserUrl = browserBaseUrl
    ? browserUrlForBase(routePath, browserBaseUrl)
    : browserUrlForRoute(routePath, location);
  return { browserUrl, browserHostIsLoopback: isLoopbackUrl(browserUrl) };
}
