// parts/http-client/do-work/same-origin.mjs
// The one test of whether an address is where a caller trusts it to be: the same origin, a host inside a domain, or a
// page under a base address. Every place that trusts an address by where it is asks here, so a look-alike host
// (https://app.example.com.evil.test, https://evilexample.com), a sign-in in the address (https://app.example.com@evil.test),
// a trailing dot or a lookalike letter never passes one check and fails another.
//
// Invariants:
// - Origins are compared exactly, as the URL parser makes them (scheme, punycode host, port). Never a string prefix.
// - A host is inside a domain only on a whole-label boundary: the domain itself or a name ending in "." + domain.
//   Case and one trailing dot are not part of a name (DNS reads "Example.com." as example.com), so both are dropped
//   before comparing; letters from other scripts stay their punycode form and so never equal a Latin name.
// - A path is under a base only on a whole-segment boundary: "/a/b" and "/a/b/c" are under "/a/b/", "/a/bc" is not.
// - An address carrying a user name or password is never trusted. Pure, with no imports, so a browser page, the
//   extension and a Worker all read the same rule.

const parsed = value => {
  if (value instanceof URL) return value;
  try { return new URL(String(value ?? '')); } catch { return null; }
};

/** The host a value names, lower case with no trailing dot: from a URL, an address, or a bare host name; else null. */
export function hostOf(value) {
  const text = value instanceof URL ? value.hostname : String(value ?? '').trim();
  if (!text) return null;
  let host = text;
  if (!(value instanceof URL)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) host = parsed(text)?.hostname ?? '';
    else if (/[/@\\?#]/.test(text)) return null;
    else {
      try { host = new URL(`https://${text}`).hostname; } catch { return null; }
    }
  }
  host = host.toLowerCase().replace(/\.$/, '');
  return host && !host.startsWith('.') ? host : null;
}

/** Whether `host` (a host name, address or URL) is `domain` itself or a name below it, on a whole-label boundary. */
export function hostWithin(host, domain) {
  const name = hostOf(host);
  const parent = hostOf(domain);
  return !!name && !!parent && (name === parent || name.endsWith(`.${parent}`));
}

/** Whether `address` is at exactly `origin`. An address with a user name or password is never at a trusted origin. */
export function sameOrigin(address, origin) {
  const url = parsed(address);
  const base = parsed(origin);
  return !!url && !!base && url.origin !== 'null' && !url.username && !url.password && url.origin === base.origin;
}

/** Whether `pathname` is `base` or below it, on a whole-segment boundary ("/a/b" and "/a/b/c" are under "/a/b/"). */
export function pathWithin(pathname, base) {
  if (typeof pathname !== 'string' || typeof base !== 'string' || !base.startsWith('/')) return false;
  const root = base.replace(/\/+$/, '');
  return !root || pathname === root || pathname.startsWith(`${root}/`);
}

/** Whether `address` is at the origin of `base` and at or below its path, on a whole-segment boundary. */
export function urlWithin(address, base) {
  const url = parsed(address);
  const root = parsed(base);
  return !!url && !!root && sameOrigin(url, root) && pathWithin(url.pathname, root.pathname);
}
