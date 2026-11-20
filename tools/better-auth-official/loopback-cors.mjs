// A page a person's own computer serves at a loopback address (http://127.0.0.1:<port>, the address its engine answers at) signs in as
// a public client with PKCE, as the OAuth browser-based apps practice describes: the authorize step is a top-level visit, and the code is
// exchanged at the token endpoint by the page's own fetch. A browser lets that fetch read the answer only when the endpoint names the
// page's origin, so the token endpoint names exactly the origin that asked when it is a loopback origin under the same rule as a loopback
// resource (settings.mcp.loopback_resources.hosts, http, a port, nothing else). No cookie is allowed with it (no
// Access-Control-Allow-Credentials): the exchange stands on the code and its verifier, never on a session. Every other origin and path
// gets no such header, as before.

/** The origin itself when `origin` is exactly http://<loopback host>:<port> under `rule` ({hosts}), else null. */
export function loopbackOrigin(origin, rule) {
  if (typeof origin !== 'string' || !rule?.hosts?.length) return null;
  let url;
  try { url = new URL(origin); } catch { return null; }
  const port = Number(url.port);
  if (url.protocol !== 'http:' || !rule.hosts.includes(url.hostname) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return origin === `http://${url.hostname}:${url.port}` ? origin : null;
}

/** The CORS headers the token endpoint answers `request` with, or null: only for `${base_path}/oauth2/token` from a loopback origin. */
export function loopbackCorsHeaders(request, settings) {
  const path = (request.url ?? '').split('?')[0];
  if (path !== `${settings.base_path}/oauth2/token`) return null;
  const origin = loopbackOrigin(request.headers?.origin, settings.mcp?.loopback_resources);
  if (!origin) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}
