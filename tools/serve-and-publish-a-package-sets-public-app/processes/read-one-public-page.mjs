// packages/hosted-public-app/processes/read-one-public-page.mjs
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Read one public page and print what it says. Nothing is sent but the
// request, nothing is stored, and the address comes from the caller.
//
// This exists because a provider's own documentation is the only honest answer
// to "what does this provider do", and a guess in its place decides real money
// on a real card. The browsing providers in this app all refuse: one is not
// admitted, one does not do this, and one is denied network by its runtime
// binding. The `node` runtime alias IS declared with network allowed, which
// makes this the road that is actually open.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Reads only. No method but GET, no body, no credential, no cookie. This
//    cannot change anything anywhere.
// 2. Public addresses only: https, and a host that is not loopback and not a
//    private range, so this can never be pointed at something inside the
//    network that the caller could not otherwise reach.
// 3. Redirects are followed only to hosts that pass the same check, and are
//    bounded, so a redirect loop ends rather than running forever.
// 4. Nothing is written. The page goes to standard output and the caller
//    decides what to keep.
//
// =============================================================================

const MAXIMUM_REDIRECTS = 5;
const TIMEOUT_MS = 20_000;

/** True when this address is a public web address another machine could reach. */
export function isPublicWebAddress(address) {
  let parsed;
  try {
    parsed = new URL(address);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '::1' || host === '[::1]') return false;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  const twelve = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (twelve && Number(twelve[1]) >= 16 && Number(twelve[1]) <= 31) return false;
  return true;
}

/** The page at this address, as text. */
export async function readOnePublicPage(address, fetchImplementation = fetch) {
  let current = address;
  for (let hop = 0; hop <= MAXIMUM_REDIRECTS; hop += 1) {
    if (!isPublicWebAddress(current)) {
      throw new Error(`${current} is not a public web address this may read.`);
    }
    const reply = await fetchImplementation(current, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'text/html,text/plain' },
    });
    if (reply.status >= 300 && reply.status < 400) {
      const next = reply.headers.get('location');
      if (!next) throw new Error(`${current} redirected without saying where.`);
      current = new URL(next, current).toString();
      continue;
    }
    if (!reply.ok) throw new Error(`${current} answered ${reply.status}.`);
    return await reply.text();
  }
  throw new Error(`${address} kept redirecting past ${MAXIMUM_REDIRECTS} hops.`);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const address = process.argv[2];
  if (!address) {
    console.error('usage: read-one-public-page.mjs <https address>');
    process.exit(2);
  }
  readOnePublicPage(address)
    .then((text) => { process.stdout.write(text); })
    .catch((error) => { console.error(String(error?.message ?? error)); process.exit(1); });
}
