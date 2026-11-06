// parts/http-client/do-work/resolved-address.mjs
//
// PURPOSE
//   The check public-address.mjs cannot make: what a NAME resolves to. `resolvePublic` and `checkedLookup` judge every
//   address a name resolves to, so a name that answers with 127.0.0.1 or 169.254.169.254 at connect time is refused even
//   though the name itself looked public (DNS rebinding). `inRanges` matches an address against CIDR ranges (a row of DATA each),
//   not an exact-address map.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The resolver is handed in (`resolve(host) -> [{ address, family }]`), so this file imports nothing from the host and
//      runs in a Worker, a browser and Node alike.
//   2. Every resolved address is judged, not only the first; one blocked address refuses the name.
//   3. A refusal looks exactly like a name that does not exist (code and text in resolved-address.json), never a message
//      naming the range or the reason.
//   4. The ranges are DATA (public-address.json, plus the caller's `deny`); nothing here lists a range.
//
import settings from './resolved-address.json' with { type: 'json' };
import { privateHost } from '../../refuse-requests-to-private-addresses/public-address.mjs';

/** The error a refused or unknown name answers. */
export class NameNotFound extends Error {
  constructor(host) {
    super(settings.refusal.text.replace('{host}', host));
    this.code = settings.refusal.code;
    this.hostname = host;
  }
}

const groupsOf = (address, family) => {
  if (family === 4) return address.split('.').reduce((total, part) => (total << 8n) + BigInt(part), 0n);
  const [head, tail] = address.includes('::') ? address.split('::') : [address, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const all = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return all.reduce((total, group) => (total << 16n) + BigInt(parseInt(group || '0', 16)), 0n);
};
const familyOf = address => (address.includes(':') ? 6 : 4);

/** Whether `address` is inside any of the CIDR `ranges` (strings like "10.0.0.0/8" or "fc00::/7"). */
export function inRanges(address, ranges = []) {
  const family = familyOf(address);
  const width = family === 4 ? 32n : 128n;
  const value = groupsOf(address, family);
  return ranges.some(range => {
    const [base, bits] = String(range).split('/');
    if (familyOf(base) !== family) return false;
    const size = BigInt(bits ?? width);
    const shift = width - size;
    return (groupsOf(base, family) >> shift) === (value >> shift);
  });
}

const blocked = (address, deny) => privateHost(familyOf(address) === 6 ? `[${address}]` : address) || inRanges(address, deny);

/**
 * The addresses `host` resolves to when every one of them is public, else throws NameNotFound.
 * `deny` adds ranges to refuse beyond the shared blocked ranges (an opt-in restriction).
 */
export async function resolvePublic(host, resolve, { deny = [] } = {}) {
  if (privateHost(host)) throw new NameNotFound(host);
  let answers;
  try { answers = await resolve(host); } catch { throw new NameNotFound(host); }
  if (!Array.isArray(answers) || !answers.length) throw new NameNotFound(host);
  if (answers.some(answer => typeof answer?.address !== 'string' || blocked(answer.address, deny))) throw new NameNotFound(host);
  return answers;
}

/**
 * A function with the shape of dns.lookup for http.request({ lookup }), so the check runs at connect time on the
 * addresses the socket will use. `all` is honoured, as newer Node asks for every address.
 */
export function checkedLookup(resolve, { deny = [] } = {}) {
  return (host, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const wantAll = typeof options === 'object' && options?.all === true;
    resolvePublic(host, resolve, { deny }).then(
      answers => (wantAll ? done(null, answers) : done(null, answers[0].address, answers[0].family)),
      error => done(error),
    );
  };
}
