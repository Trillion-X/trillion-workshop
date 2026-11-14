// The origins Better Auth trusts beyond settings.json: every domain an account has attached and verified (its signed
// origins row, an own domain believed by its TXT proof), read from the rows' own question at request time, so a newly
// attached domain signs people in with no settings edit. settings.json `attached_origins`:
//   ask_url      the front door's certificate ask: GET ?domain=<host> answers 200 only when one live account names the host
//   cache_ms     how long one answer is kept (the ask carries no revision to key a cache by)
//   related_url  the forwarder's GET /origins/related (loopback only): {origins: [{origin, revision}]}, every host exactly one
//                live account names, for the passkey related origins document; read per request, no list kept here
// Used as Better Auth's documented function form of trustedOrigins (Options, "Dynamic Origins"): the home origins when
// there is no request, and a request's own origin only when the rows name its host, never one copied without the lookup.

const DEFAULT_PORT = '';

/** An https origin with no port, path or credentials, as its host; null for anything else. */
function hostOf(origin) {
  let url;
  try { url = new URL(origin); } catch { return null; }
  if (url.protocol !== 'https:' || url.port !== DEFAULT_PORT || url.origin !== origin) return null;
  return url.hostname;
}

/** Better Auth's trustedOrigins function for these settings. */
export function trustedOriginsFor(settings, { fetchImpl = fetch, now = Date.now } = {}) {
  const home = settings.trusted_origins;
  const { ask_url: ask, cache_ms: keep } = settings.attached_origins ?? {};
  const answers = new Map();
  const verified = async host => {
    const kept = answers.get(host);
    if (kept && kept.until > now()) return kept.ok;
    const ok = await fetchImpl(`${ask}?domain=${encodeURIComponent(host)}`).then(answer => answer.status === 200, () => false);
    answers.set(host, { ok, until: now() + keep });
    return ok;
  };
  return async request => {
    const origin = request?.headers?.get('origin');
    if (!ask || !origin || home.includes(origin)) return home;
    const host = hostOf(origin);
    return host && await verified(host) ? [...home, origin] : home;
  };
}

/** The passkey related origins document (WebAuthn Level 3 §5.11, served at /.well-known/webauthn on the rpID's host). */
export async function relatedOrigins(settings, { fetchImpl = fetch } = {}) {
  const home = settings.trusted_origins;
  const url = settings.attached_origins?.related_url;
  if (!url) return { origins: home };
  try {
    const answer = await fetchImpl(url);
    const { origins = [] } = answer.ok ? await answer.json() : {};
    const named = origins.map(entry => entry?.origin).filter(origin => typeof origin === 'string' && hostOf(origin) && !home.includes(origin));
    return { origins: [...home, ...named] };
  } catch {
    return { origins: home };
  }
}
