// parts/http-client/do-work/public-address.mjs
// The one test of whether this service may send a request to an address someone else gave it (an AI's tool, a
// delivery address, a tool server, a file to fetch, a source page), and the one way to send it.
//
// Invariants:
// - An address is public when it uses an allowed scheme (https unless the caller allows http too), carries no user
//   name or password, and names a host that is neither this computer, a private or shared network, a link-local or
//   cloud-metadata address, nor a name only a private network resolves (localhost, .local, .internal, .home.arpa...).
//   IP literals are judged by their numbers after the URL parser has made them canonical, so 2130706433, 0x7f.1 and
//   [::ffff:127.0.0.1] are all 127.0.0.1. The blocked ranges and names are DATA (do-work/public-address.json), never code.
// - A redirect is never followed blindly: every hop's address is judged again before it is asked for (fetchPublic),
//   a hop to another host drops the authorization and cookie headers, and a 303 (or a 301/302 after a POST) asks again
//   with GET and no body, as browsers do. At most `max_redirects` hops.
// - Refusing is the default: an address that cannot be parsed, or a host that cannot be read, is not public.

import rules from './public-address.json' with { type: 'json' };
import { hostWithin } from '../http-client/do-work/same-origin.mjs';

export class NotPublicAddress extends Error {}

const v4Number = text => text.split('.').reduce((total, part) => total * 256 + Number(part), 0);
const v4Ranges = rules.blocked_ipv4.map(({ range }) => {
  const [base, bits] = range.split('/');
  const size = 2 ** (32 - Number(bits));
  const start = v4Number(base);
  return { start, end: start + size - 1 };
});
const v4Blocked = address => {
  const value = v4Number(address);
  return v4Ranges.some(({ start, end }) => value >= start && value <= end);
};

// An IPv6 literal as its eight 16-bit groups ("::" expanded; a trailing dotted IPv4 read as two groups).
function v6Groups(text) {
  let body = text;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(body);
  if (dotted) {
    const value = v4Number(dotted[1]);
    body = `${body.slice(0, -dotted[1].length)}${(Math.floor(value / 65536)).toString(16)}:${(value % 65536).toString(16)}`;
  }
  const [head, tail] = body.includes('::') ? body.split('::') : [body, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.length === 8 ? groups.map(group => parseInt(group || '0', 16)) : null;
}
const v6Ranges = rules.blocked_ipv6.map(({ range }) => {
  const [base, bits] = range.split('/');
  return { groups: v6Groups(base), bits: Number(bits) };
});
function v6Blocked(text) {
  const groups = v6Groups(text);
  if (!groups || groups.some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) return true;
  // An IPv4 address carried inside IPv6 (::ffff:a.b.c.d, 64:ff9b::a.b.c.d) is judged as that IPv4 address.
  for (const { prefix } of rules.ipv4_inside_ipv6) {
    const known = v6Groups(prefix);
    if (known.slice(0, 6).every((group, at) => group === groups[at])) {
      if (v4Blocked(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`)) return true;
    }
  }
  return v6Ranges.some(({ groups: base, bits }) => {
    for (let bit = 0; bit < bits; bit += 1) {
      const at = Math.floor(bit / 16);
      const mask = 1 << (15 - (bit % 16));
      if ((base[at] & mask) !== (groups[at] & mask)) return false;
    }
    return true;
  });
}

/** Whether a host (as `URL.hostname` gives it) is one only this computer or a private network reaches. */
export function privateHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host.startsWith('[')) return v6Blocked(host.slice(1, -1));
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return v4Blocked(host);
  return rules.private_names.some(name => hostWithin(host, name));
}

/**
 * The address as a string when this service may send a request to it, else throws NotPublicAddress saying why.
 * `schemes` are the ones allowed (https only unless a caller that reads public files allows http too).
 */
export function publicAddress(value, { schemes = ['https:'] } = {}) {
  let url;
  try { url = new URL(String(value)); } catch { throw new NotPublicAddress('Give a full web address, like https://example.com/page.'); }
  if (!schemes.includes(url.protocol)) throw new NotPublicAddress(schemes.length === 1 ? 'The address must start with https://.' : 'The address must be a web address (https:// or http://).');
  if (url.username || url.password) throw new NotPublicAddress('The address must not carry a user name or password; connect the service instead.');
  if (privateHost(url.hostname)) throw new NotPublicAddress('The address must be a public site, not this computer or a private network.');
  return url.toString();
}

/** The address when it is public (see publicAddress), else null. */
export function publicAddressOrNull(value, options) {
  try { return publicAddress(value, options); } catch (error) { if (error instanceof NotPublicAddress) return null; throw error; }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PER_HOST_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

export class ResponseBytesExceeded extends Error {}

/** Read an unknown-size response while keeping at most maxBytes. Refusal cancels upstream before another read. */
export async function readResponseBytes(response, { maxBytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('maxBytes must be a nonnegative whole byte count.');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const pieces = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - length) throw new ResponseBytesExceeded(`The response exceeds ${maxBytes} bytes.`);
      pieces.push(value);
      length += value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
    return bytes;
  } catch (error) {
    reader.cancel(error).catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

/**
 * Sends a request to a public address, judging the first address and every redirect's address before asking it.
 * `init` is fetch's; its `redirect` is always handled here. Throws NotPublicAddress when any hop is not public.
 */
export async function fetchPublic(value, init = {}, { fetchImpl = fetch, schemes = ['https:'], maxRedirects = rules.max_redirects } = {}) {
  let address = publicAddress(value, { schemes });
  let request = { ...init, redirect: 'manual' };
  for (let hop = 0; ; hop += 1) {
    const response = await fetchImpl(address, request);
    if (!REDIRECTS.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (hop >= maxRedirects) {
      await response.body?.cancel?.();
      throw new NotPublicAddress(`The address redirected more than ${maxRedirects} times.`);
    }
    await response.body?.cancel?.();
    const next = publicAddress(new URL(location, address).toString(), { schemes });
    const method = String(request.method ?? 'GET').toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      const { body: _body, ...rest } = request;
      request = { ...rest, method: 'GET' };
    }
    if (new URL(next).host !== new URL(address).host && request.headers) {
      const headers = new Headers(request.headers);
      for (const name of PER_HOST_HEADERS) headers.delete(name);
      request = { ...request, headers };
    }
    address = next;
  }
}
