// tools/decide-with-a-method/read-data/public-address.mjs
//
// Whether an address a decision names (a method field of kind `url`) is a public https address: an allowed scheme,
// no user name or password, and a host that is neither this computer, a private or shared network, a link-local or
// cloud-metadata address, nor a name only a private network resolves. IP literals are judged by their numbers after
// the URL parser has made them canonical. The blocked ranges and names are DATA (read-data/public-address.json).
// Ported unchanged from the old app's parts/http-client/do-work/public-address.mjs (the judging part; nothing here
// sends a request) and same-origin.mjs (hostOf, hostWithin).
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('./public-address.json', import.meta.url), 'utf8'));

const parsed = value => {
  if (value instanceof URL) return value;
  try { return new URL(String(value ?? '')); } catch { return null; }
};
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

export function hostWithin(host, domain) {
  const name = hostOf(host);
  const parent = hostOf(domain);
  return !!name && !!parent && (name === parent || name.endsWith(`.${parent}`));
}

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
