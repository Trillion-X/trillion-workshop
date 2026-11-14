// packages/account-session/read-data/choose-callback-origin.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Decide which origin an emailed sign-in link should send the person back to.
//
// The browser already knows where the person is, and that is almost always the
// right answer: sign in at app.example.com, come back to app.example.com. The
// one case where it is wrong is an app whose own origin is not an address
// another device can reach, which is what a desktop shell serving its UI from
// loopback has. A link mailed to that origin opens on a phone and resolves to
// nothing.
//
// So DATA supplies a public origin as the FALLBACK for that case, rather than
// as an override. Declared as an override, one host name is baked into the
// composition and every other host the same app is served from mails people to
// the wrong place. That is what happened here: the first-run journey named the
// marketing host, so the hosted app would have mailed customers a link that
// landed on the marketing site instead of their own workspace.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure. The caller passes the browser's origin; nothing is read from a
//    global here, so this is testable with plain strings.
// 2. No host names, product names, or environment names. The only question
//    asked is whether an address is reachable from another device, which is a
//    property of the address itself.
// 3. Reachability is judged by IANA address classes (loopback, link-local,
//    private ranges) and by protocol. Those sets are closed by the addressing
//    scheme, not by anyone's preference, so enumerating them is not an enum
//    over an extensible set.
// 4. An unusable answer is never returned in place of a usable one. When
//    neither origin is reachable the browser's own is returned, because a
//    same-device link still works and a blank is a broken form.
//
// =============================================================================

/** Hosts that resolve to the asking machine, so a link mailed there is useless. */
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]') return true;
  // 127.0.0.0/8 is loopback in its entirety, not only 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Addresses that exist only inside one network, so another device cannot reach them. */
function isPrivateHost(host: string): boolean {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // 172.16.0.0/12 is 172.16 through 172.31, which is why this is not `172\.1`.
  const twelve = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (twelve && Number(twelve[1]) >= 16 && Number(twelve[1]) <= 31) return true;
  // 169.254.0.0/16 is link-local: self-assigned when no address was handed out.
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/**
 * True when a link at this origin, opened on a different device, could reach
 * the app. False for anything that only resolves on the machine it came from,
 * and for anything a browser cannot follow out of an email.
 */
export function isReachableFromAnotherDevice(origin: string | undefined | null): boolean {
  if (typeof origin !== 'string' || !origin.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (isLoopbackHost(host)) return false;
  if (isPrivateHost(host)) return false;
  return true;
}

/**
 * Where the emailed link should land. The browser's own origin wins whenever a
 * link there would work, so the same composition DATA serves every host the app
 * is deployed to. The declared origin is used only when the browser is somewhere
 * an emailed link could not come back to.
 */
export function chooseCallbackOrigin(input: {
  browserOrigin?: string | null;
  declaredOrigin?: string | null;
}): string {
  const browser = typeof input.browserOrigin === 'string' ? input.browserOrigin.trim() : '';
  const declared = typeof input.declaredOrigin === 'string' ? input.declaredOrigin.trim() : '';

  if (isReachableFromAnotherDevice(browser)) return new URL(browser).origin;
  if (isReachableFromAnotherDevice(declared)) return new URL(declared).origin;
  // Neither is reachable elsewhere. The browser's own origin at least works on
  // this machine, which is the whole of what a desktop-only session needs.
  if (browser) return browser;
  if (declared) return declared;
  return '';
}
