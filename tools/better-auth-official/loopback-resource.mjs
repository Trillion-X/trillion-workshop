// A person's own engine names itself as the resource it is asked for: its loopback address and port, `/mcp` (one per computer, any port), in
// its protected-resource document. No list of those can be configured, so a resource is accepted when it is exactly one of the settings'
// hosts (settings.mcp.loopback_resources.hosts) over http at a port, with the settings' path and nothing else: no user name, no query, no
// other spelling of the address. The token's audience is that engine, which checks the token against this issuer's keys. A row for it is
// kept in the store (Better Auth looks resources up there) the first time it is asked for. Every other host is refused as before.
/** The canonical identifier when `identifier` is a loopback engine's resource under `rule` ({hosts, path}), else null. */
export function loopbackResource(identifier, rule) {
  if (typeof identifier !== 'string' || !rule?.hosts?.length) return null;
  let url;
  try { url = new URL(identifier); } catch { return null; }
  const port = Number(url.port);
  const canonical = `http://${url.hostname}:${url.port}${url.pathname}`;
  if (url.protocol !== 'http:' || !rule.hosts.includes(url.hostname) || !Number.isInteger(port) || port < 1 || port > 65535 || url.pathname !== rule.path) return null;
  return identifier === canonical ? canonical : null;
}

const sameScopes = (a, b) => Array.isArray(a) && a.length === b.length && a.every(scope => b.includes(scope));

/** Makes the store hold a row for each loopback resource named in `requested` (a text, an array of texts or nothing), whose allowed
 *  scopes are the settings' `scopes`: a row kept from before a scope was renamed or added is brought to them, so a renamed scope never
 *  refuses every request for that engine (a row made Nov 17 2026 still allowed only records and tools, and refused tools:*). */
export async function holdLoopbackResources(adapter, rule, scopes, requested) {
  for (const identifier of [requested ?? []].flat()) {
    const canonical = loopbackResource(identifier, rule);
    if (!canonical) continue;
    const where = [{ field: 'identifier', value: canonical }];
    const held = await adapter.findOne({ model: 'oauthResource', where });
    if (held && !sameScopes(held.allowedScopes, scopes)) {
      await adapter.update({ model: 'oauthResource', where, update: { allowedScopes: scopes, updatedAt: new Date() } });
    }
    if (held) continue;
    const now = new Date();
    try {
      await adapter.create({ model: 'oauthResource', data: { identifier: canonical, name: rule.name, allowedScopes: scopes, createdAt: now, updatedAt: now } });
    } catch (error) {
      // Another request made it first.
      if (!await adapter.findOne({ model: 'oauthResource', where }).catch(() => null)) throw error;
    }
  }
}
