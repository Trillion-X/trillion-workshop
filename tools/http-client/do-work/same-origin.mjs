// The one test of whether an address is where a caller trusts it to be: the same origin, a host inside a domain, or a
// page under a base address. Every place that trusts an address by where it is asks here, so a look-alike host
// (https://app.example.com.evil.test, https://evilexample.com), a sign-in in the address (https://user-62377ba2@example.com),
// a trailing dot or a lookalike letter never passes one check and fails another.
//
// Invariants:
// - Origins are compared exactly, as the URL parser makes them (scheme, punycode host, port). Never a string prefix.
// - A host is inside a domain only on a whole-label boundary: the domain itself or a name ending in "." + domain.
//   Case and one trailing dot are not part of a name (DNS reads "Example.com." as example.com), so both are dropped
//   before comparing; letters from other scripts stay their punycode form and so never equal a Latin name.
// - A path is under a base only on a whole-segment boundary: "/a/b" and "/a/b/c" are under "/a/b/", "/a/bc" is not.
// - An address carrying a user name or password is never trusted. Pure, with no I/O, so a browser page, the
//   extension and a Worker all read the same rule. Cookie-domain selection uses the maintained public suffix data
//   from tldts, including private hosting suffixes.

import { getDomain } from 'tldts';

const parsed = value => {
  if (value instanceof URL) return value;
  try { return new URL(String(value ?? '')); } catch { return null; }
};

/** The host a value names, lower case with no trailing dot: from a URL, an address, or a bare host name; else null. */
export function hostOf(value) {
  if (value instanceof URL && (value.username || value.password)) return null;
  const text = value instanceof URL ? value.hostname : String(value ?? '').trim();
  if (!text) return null;
  let host = text;
  if (!(value instanceof URL)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      const url = parsed(text);
      if (url?.username || url?.password) return null;
      host = url?.hostname ?? '';
    }
    else if (/[/@\\?#]/.test(text)) return null;
    else {
      // A bare IPv6 literal needs URL brackets. Let the same parser validate and
      // canonicalize that spelling; ordinary names, ports and bracketed hosts
      // retain their existing parse first.
      const url = parsed(`https://${text}`) ?? parsed(`https://[${text}]`);
      host = url?.hostname ?? '';
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

/** The parent domain an app may share a visitor cookie across, when its public origin is under that parent. */
export function sharedCookieDomain(origin, primary) {
  let address;
  try { address = new URL(primary); } catch { return null; }
  if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password) return null;
  const hostname = address.hostname.toLowerCase().replace(/\.$/, '');
  // One final dot is canonical DNS spelling; a second is malformed. IPs, localhost and public suffixes have no
  // registrable parent cookie domain; private suffixes are treated as boundaries so tenant cookies stay isolated.
  if (!hostname || hostname.endsWith('.') || hostname.includes(':') || hostname.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
  const parent = hostname.split('.').slice(1).join('.');
  if (!parent.includes('.') || !getDomain(parent, { allowPrivateDomains: true })) return null;
  return hostWithin(origin, parent) ? parent : null;
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
