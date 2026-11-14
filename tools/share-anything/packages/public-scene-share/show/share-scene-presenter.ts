// packages/public-scene-share/show/share-scene-presenter.ts
//
// The ui/ translation boundary the `create-capsule` target deliberately deferred
// (L098): the target returns a HUMAN-FREE machine reply `{ ok, capsuleHash,
// contentPath }`; this module turns the live share lifecycle into the HUMAN view-
// model a Share affordance renders ("Share this view" / "Creating link…" / "Copy
// link" / "Try again" + the actual shareable URL). No engine I/O, no scene format
// knowledge — pure state→view, so every surface (studio chrome, package show/,
// browser proof harness) renders identical, tested copy.
//
// The shareable URL is the SAME shape the shipped viewer reads (`/c/<hash>`, see
// viewer/capsule-view-entry.ts): `${publicShareOrigin}/c/<capsuleHash>`. Origin is
// DATA (config), never hardcoded into the presenter — local/preview proofs pass a
// local origin; production passes `https://share.bitfield.so`.

/** The machine reply shape returned by the `public-scene-share.create-capsule` target. */
export interface CapsuleReply {
  readonly ok: boolean;
  readonly capsuleHash?: string;
  readonly contentPath?: string;
  readonly reason?: string;
}

/** DATA config — the public origin the shareable link points at (no trailing slash). */
export interface ShareConfig {
  readonly publicShareOrigin: string;
  /** Whether `publicShareOrigin` is actually reachable by someone outside this
   *  machine/network (i.e. a connected deploy-target's reported public URL).
   *  Omitted/true = trusted as given — explicit DATA always wins, so proof
   *  harnesses and production wiring that supply a known-good origin (including a
   *  local one they control and are asserting is reachable for their own proof)
   *  are not re-litigated here. Only an explicit `false` — computed by the caller
   *  with `isPubliclyReachableOrigin` when it had to fall back to the ambient page
   *  origin with no deploy target connected — triggers the honest "not reachable"
   *  state. Never present a private/loopback link as a working public share link
   *  (L114/L116). */
  readonly isPubliclyReachable?: boolean;
}

export type ShareStatus = 'idle' | 'minting' | 'shared' | 'error' | 'unreachable';

/**
 * The ONLY definition, in this package, of "not actually public" — loopback,
 * RFC1918 private ranges, link-local, and mDNS (`.local`) hostnames. Pure and
 * deploy-target-agnostic (Physics, not Society): it works identically whether the
 * origin came from `window.location` or from a `service-connections` deploy-target
 * descriptor's reported URL — adding a new deploy target NEVER touches this
 * function. Fails CLOSED on empty/unparsable input: an origin is trusted as public
 * ONLY when it demonstrably is not a private-network address.
 */
export function isPubliclyReachableOrigin(origin: string): boolean {
  if (!origin || origin.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname.length === 0) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
  if (hostname.endsWith('.local')) return false; // mDNS
  if (hostname === '0.0.0.0' || hostname === '::1' || hostname === '[::1]') return false;
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0) return false; // 0.0.0.0/8
    if (a === 10) return false; // 10.0.0.0/8
    if (a === 127) return false; // loopback 127.0.0.0/8
    if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
  }
  return true;
}

/** The human-facing view-model a Share affordance renders. Zero machine vocabulary. */
export interface ShareView {
  readonly status: ShareStatus;
  /** The label on the primary action button. */
  readonly primaryLabel: string;
  /** The shareable URL once minted, else null. */
  readonly shareUrl: string | null;
  /** Secondary helper line (success reassurance / error reason), else null. */
  readonly helpText: string | null;
  /** Whether a copy-to-clipboard affordance should be offered. */
  readonly canCopy: boolean;
  /** Whether the primary action should be disabled (mid-mint). */
  readonly busy: boolean;
}

/** Build the shareable URL from a capsule hash — the one place the link shape lives. */
export function shareUrlFromHash(publicShareOrigin: string, capsuleHash: string): string {
  const origin = publicShareOrigin.replace(/\/+$/, '');
  return `${origin}/c/${capsuleHash}`;
}

/** Idle (pre-share) view. */
export function idleShareView(): ShareView {
  return { status: 'idle', primaryLabel: 'Share this view', shareUrl: null, helpText: null, canCopy: false, busy: false };
}

/** In-flight (minting) view. */
export function mintingShareView(): ShareView {
  return { status: 'minting', primaryLabel: 'Creating link…', shareUrl: null, helpText: null, canCopy: false, busy: true };
}

/** No deploy target connected — the resolved origin is private/loopback. A distinct,
 *  honest state (never "shared", never "error"): it refuses to mint or present a fake
 *  public link and tells the human exactly what to do (L114/L116). */
export function unreachableShareView(): ShareView {
  return {
    status: 'unreachable',
    primaryLabel: 'Connect a deploy target',
    shareUrl: null,
    helpText: 'This app is not publicly reachable yet — connect a deploy target to get a real link.',
    canCopy: false,
    busy: false,
  };
}

/**
 * Map a settled `create-capsule` reply to the human view-model. The success path
 * requires BOTH `ok` AND a non-empty `capsuleHash` — an `ok` reply with no hash is
 * treated as an error (the link cannot be formed), never a silent success.
 *
 * Checked BEFORE the reply is even inspected: if the configured origin is not
 * publicly reachable, the honest "connect a deploy target" state wins regardless of
 * whether the mint itself succeeded — a successful mint against an unreachable
 * origin is still not a usable public link (L114/L116).
 */
export function shareViewFromReply(reply: CapsuleReply, config: ShareConfig): ShareView {
  if (config.isPubliclyReachable === false) return unreachableShareView();
  if (reply.ok && reply.capsuleHash && reply.capsuleHash.length > 0) {
    return {
      status: 'shared',
      primaryLabel: 'Copy link',
      shareUrl: shareUrlFromHash(config.publicShareOrigin, reply.capsuleHash),
      helpText: 'Anyone with this link can open a frozen copy of this view.',
      canCopy: true,
      busy: false,
    };
  }
  return {
    status: 'error',
    primaryLabel: 'Try again',
    shareUrl: null,
    helpText: reply.reason && reply.reason.length > 0 ? reply.reason : 'Could not create a share link. Please try again.',
    canCopy: false,
    busy: false,
  };
}
