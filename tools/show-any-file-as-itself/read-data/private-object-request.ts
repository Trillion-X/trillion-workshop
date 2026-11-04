// media-playback/read-data/private-object-request.ts
//
// Pure view-state machine for opening a PRIVATE object (book PDF, audiobook, any
// paid private asset). The surface calls the `material-delivery.request-private-object`
// target and feeds the reply here; this maps it to ONE on-screen state with copy in
// the USER's language (L114/L115/L118 — never internal vocabulary like "lease",
// "entitlement", "cas", "token"). Pure + framework-agnostic so it is unit-testable
// without a browser; the .tsx shell only does the I/O (browser_id + target call) and
// renders whatever state this returns.
//
// Self-describing + DATA-driven: copy is a DATA map with maximally-capable defaults
// (L083). A deployment overrides any line without touching code.

/** The reply shape from `material-delivery.request-private-object`. */
export type PrivateObjectReply =
  | { status: 'grant'; delivery_url: string; expires_at?: number; mime?: string }
  | { status: 'loading' }
  | { status: 'denied'; reason?: string }
  | { status: 'unavailable'; reason?: string }
  | { status?: string; [k: string]: unknown };

/** What the surface should put on screen — ONE thing at a time. */
export type PrivateObjectView =
  | { kind: 'opening'; message: string }
  | { kind: 'ready'; deliveryUrl: string; mime?: string }
  | { kind: 'sign-in'; message: string }
  | { kind: 'upgrade'; message: string }
  | { kind: 'not-ready'; message: string }
  | { kind: 'error'; message: string };

/** User-language copy. Overridable as DATA; defaults are plain and jargon-free. */
export type PrivateObjectCopy = {
  opening: string;
  signIn: string;
  upgrade: string;
  notReady: string;
  error: string;
  /** Button labels for the actionable states (sign-in / upgrade / retry). */
  signInAction: string;
  upgradeAction: string;
  retryAction: string;
};

const DEFAULT_COPY: PrivateObjectCopy = {
  opening: 'Opening…',
  signIn: 'Sign in to open this.',
  upgrade: 'Included with your membership.',
  notReady: 'Not available yet.',
  error: 'Could not open this. Try again.',
  signInAction: 'Sign in',
  upgradeAction: 'Get access',
  retryAction: 'Try again',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function copyWith(over?: Partial<PrivateObjectCopy>): PrivateObjectCopy {
  return { ...DEFAULT_COPY, ...(over ?? {}) };
}

/**
 * Map a delivery reply (or the in-flight / error condition) to a single view state.
 * `reply === null` = request in flight. A thrown/failed request = pass `'error'`.
 */
export function privateObjectView(
  reply: PrivateObjectReply | null | 'error',
  copyOverride?: Partial<PrivateObjectCopy>,
): PrivateObjectView {
  const copy = copyWith(copyOverride);
  if (reply === null) return { kind: 'opening', message: copy.opening };
  if (reply === 'error') return { kind: 'error', message: copy.error };

  const status = isRecord(reply) ? String(reply.status ?? '') : '';
  if (status === 'grant') {
    const url = typeof (reply as { delivery_url?: unknown }).delivery_url === 'string'
      ? (reply as { delivery_url: string }).delivery_url
      : '';
    if (!url) return { kind: 'error', message: copy.error };
    const mime = typeof (reply as { mime?: unknown }).mime === 'string'
      ? (reply as { mime: string }).mime
      : undefined;
    return { kind: 'ready', deliveryUrl: url, mime };
  }
  if (status === 'loading') return { kind: 'opening', message: copy.opening };
  if (status === 'denied') {
    const reason = String((reply as { reason?: unknown }).reason ?? '');
    // anonymous → authenticate; anything else (not-entitled) → upgrade/purchase.
    return reason === 'anonymous'
      ? { kind: 'sign-in', message: copy.signIn }
      : { kind: 'upgrade', message: copy.upgrade };
  }
  if (status === 'unavailable') return { kind: 'not-ready', message: copy.notReady };
  return { kind: 'error', message: copy.error };
}

/**
 * What the gated surface paints: ONE message, whether to show a busy/working
 * indicator, and (when the user can do something) ONE action. Pure so the .tsx
 * shell stays dumb — it renders this verbatim and wires the action callback.
 */
export type PrivateObjectControl = {
  kind: PrivateObjectView['kind'];
  message: string;
  /** True while the system is working and the user just waits (opening / not-ready). */
  busy: boolean;
  /** The single thing the user can do to move forward, if any. */
  actionKind?: 'sign-in' | 'upgrade' | 'retry';
  actionLabel?: string;
};

/**
 * Map a view state to its on-screen control. `ready` collapses to busy: the host
 * swaps in the player the instant it has the delivered URL, so the gate only ever
 * shows the transient "opening" while that swap happens — never a dead end.
 */
export function privateObjectControl(
  view: PrivateObjectView,
  copyOverride?: Partial<PrivateObjectCopy>,
): PrivateObjectControl {
  const copy = copyWith(copyOverride);
  switch (view.kind) {
    case 'ready':
    case 'opening':
      return { kind: view.kind, message: copy.opening, busy: true };
    case 'not-ready':
      return { kind: 'not-ready', message: view.message, busy: true };
    case 'sign-in':
      return { kind: 'sign-in', message: view.message, busy: false, actionKind: 'sign-in', actionLabel: copy.signInAction };
    case 'upgrade':
      return { kind: 'upgrade', message: view.message, busy: false, actionKind: 'upgrade', actionLabel: copy.upgradeAction };
    case 'error':
    default:
      return { kind: 'error', message: view.message, busy: false, actionKind: 'retry', actionLabel: copy.retryAction };
  }
}
