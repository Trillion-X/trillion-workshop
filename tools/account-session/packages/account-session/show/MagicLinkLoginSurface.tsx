// packages/account-session/show/MagicLinkLoginSurface.tsx
//
// Generic, DATA-driven magic-link login surface (Task #17 U3 — finishes the anon-entry
// AnonEntrySurface enum dissolution). The anonymous entry router (screen-after-sign-in-check)
// no longer renders a hardcoded provider-specific <LoginPanel> inline; it mounts THIS surface
// BY ADDRESS as the resolved plan's login primary and hands it `surfaceInput` DATA.
//
// This surface is provider-AGNOSTIC: it names no auth provider in code. Everything that varies
// per context is `surfaceInput` DATA:
//   - requestTarget : the envelope TARGET that mints+sends the magic link (e.g. the supabase
//                     request-sign-in-link target). Dispatched by name — ZERO compile coupling
//                     to the provider package (L106/decoupling: cross-package = envelope, not import).
//   - redirectPath  : where the magic link returns the visitor (e.g. /app?supabase_sign_in=complete).
//   - ctaHref       : the "don't have an account?" CTA target. Missing DATA uses the
//                     current app's local checkout route; no product or provider is compiled in.
// The provider's own descriptor records are read from ONE declared input ('provider-records') and
// forwarded opaquely in the dispatch payload — the surface never inspects them.
//
// It owns its own request state (no consumer React callbacks — a by-address mount can't receive
// them) and reads its own browser session so LoginPanel renders the right state. Renders the
// shared LoginPanel (owned by this package — no cross-package UI import).

'use client';

import React from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { LockKeyhole } from 'lucide-react';
import {
  Button,
  Container,
  PlaceableSurfaceHost,
  Text,
  mountReactSurface,
} from '../../../../ui';
import { readAccountPortalBrowserSession } from '../do-work/read-browser-session-state';
import { currentPresenterBrowserSessionId as currentLogBrowserSessionBrowserId, currentBrowserSessionAccessKey } from '../../../../shared-code/packages/account-session/do-work/browser-session-access-key';
import { readLocalFirstRunProvenance, type LocalFirstRunProvenanceMarker } from '../do-work/remove-local-first-run-provenance';
import { readAccountSession, type AccountSessionProjection } from '../read-data/read-session';
import { chooseCallbackOrigin } from '../read-data/choose-callback-origin';
import {
  CHECKOUT_CONTEXT_STORAGE_KEY,
  DEFAULT_CHECKOUT_HREF,
  LoginPanel,
  readCheckoutContext,
  type CheckoutContext,
  type LoginCopyVariant,
  type LoginCopyVariants,
} from './LoginPanel';
import { FloatingPanel } from '../../../../screen-arrangement/show/FloatingPanel';

/** DATA config carried on the resolved plan primary's `surfaceInput`. All optional — a missing
 *  requestTarget yields an honest "not configured" error rather than a silent broken form. */
export interface MagicLinkLoginConfig {
  requestTarget?: string;
  redirectPath?: string;
  /** Optional public HTTPS origin that consumes the emailed proof. Desktop apps
   * use this so the link still works when opened on another device. */
  callbackOrigin?: string;
  ctaHref?: string;
  app_name?: string;
  /** `page` is the legacy full-page auth destination. `embedded` lets a caller
   * own the dialog. `modal` is a protected-surface gate with the canonical
   * movable FloatingPanel over the still-usable workspace. */
  presentation?: 'page' | 'embedded' | 'modal';
  protected_surface?: ProtectedSurfaceDescriptor;
  modal_title?: string;
  modal_description?: string;
  locked_title?: string;
  locked_description?: string;
  show_signup?: boolean;
  /** DATA-authored copy per real state. Keys: default | first_run | just_paid. */
  login_copy_variants?: LoginCopyVariants;
  /** localStorage key that records an app-originated checkout attempt. Default carries the browser id + email. */
  checkout_context_storage_key?: string;
  /** A DATA-provided first-run signal key (e.g. the persisted orientation ordinal). Presence => first_run copy. */
  first_run_signal_key?: string;
}

export interface ProtectedSurfaceDescriptor {
  package_entry?: { package_name?: string; entry_name?: string };
  material_target?: string;
  target?: string;
  surface_input?: Record<string, unknown>;
}

export interface MagicLinkLoginSurfaceProps {
  surfaceInput?: MagicLinkLoginConfig;
  /** Test seam: when omitted, provider records are read from the injected 'provider-records' input. */
  providerRecords?: unknown;
}

function LockedSurfacePreview() {
  return (
    <div
      aria-hidden="true"
      data-authenticated-surface-backdrop="sanitized"
      inert
      className="absolute inset-0 pointer-events-none select-none overflow-hidden bg-[var(--surface-base)] p-5"
    >
      <div className="flex h-full min-h-0 gap-4 opacity-65">
        <div className="hidden w-64 shrink-0 flex-col gap-3 rounded-2xl border border-[var(--border-primary)] bg-[var(--surface-raised)] p-4 sm:flex">
          <div className="h-8 w-28 rounded-lg bg-[var(--glass-bg-active)]" />
          <div className="h-11 w-full rounded-xl bg-[var(--glass-bg-subtle)]" />
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="h-16 w-full rounded-xl bg-[var(--glass-bg-subtle)]" />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4 rounded-2xl border border-[var(--border-primary)] bg-[var(--surface-raised)] p-5">
          <div className="h-8 w-2/5 rounded-lg bg-[var(--glass-bg-active)]" />
          <div className="h-4 w-4/5 rounded bg-[var(--glass-bg-subtle)]" />
          <div className="h-4 w-3/5 rounded bg-[var(--glass-bg-subtle)]" />
          <div className="mt-2 min-h-56 flex-1 rounded-2xl bg-[var(--glass-bg-subtle)]" />
        </div>
      </div>
    </div>
  );
}

export function loginLinkFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/SIGN_IN_HANDOFF_UNAVAILABLE|Sign-in could not finish|Sign-in handoff is unavailable|Sign-in link has already been used/.test(message)) {
    return 'Sign-in could not finish. Enter your email below to request a new sign-in link. Code: SIGN_IN_LINK_RETRY.';
  }
  if (/credential handle is required|login proof signing descriptor is not configured|ACCOUNT_PUBLIC_URL is not configured/.test(message)) {
    return 'Sign-in is not configured correctly for this app. No email was sent. Code: SIGN_IN_NOT_CONFIGURED.';
  }
  if (/rate.limit|too many requests|\b429\b/i.test(message)) {
    return 'Too many sign-in requests. Wait a few minutes before trying again. Code: SIGN_IN_RATE_LIMITED.';
  }
  if (/network|failed to fetch|timed? ?out|timeout/i.test(message)) {
    return 'Could not reach the sign-in service. Check your connection and try again. Code: SIGN_IN_CONNECTION_FAILED.';
  }
  return 'The sign-in service could not complete your request. Try again; if it keeps failing, report code SIGN_IN_FAILED.';
}

function decodeReplyOk(reply: unknown): boolean {
  const payload = reply && typeof reply === 'object' ? (reply as { payload?: unknown }).payload : undefined;
  if (!(payload instanceof Uint8Array)) return false;
  try {
    const body = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    return body.ok === true || body.accepted === true;
  } catch {
    return false;
  }
}

export function MagicLinkLoginSurface({ surfaceInput, providerRecords }: MagicLinkLoginSurfaceProps = {}) {
  const injected = useBitfieldData('provider-records');
  const records = providerRecords ?? injected;
  const cfg = surfaceInput ?? {};
  const [session, setSession] = React.useState<Partial<AccountSessionProjection> | null | undefined>(undefined);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionPending, setActionPending] = React.useState(false);
  const [modalOpen, setModalOpen] = React.useState(true);
  const [checkoutContext, setCheckoutContext] = React.useState<CheckoutContext | null>(null);
  const [localFirstRunMarker, setLocalFirstRunMarker] = React.useState<LocalFirstRunProvenanceMarker | null>(null);

  // Real-state copy branching (D4): just_paid > first_run > default. The signals are
  // DATA-addressable: the checkout context records an app-originated "Start your account"
  // attempt, and the first-run key names any persisted first-run signal (e.g. the
  // orientation ordinal). Nothing here fabricates payment knowledge; the just_paid
  // variant only claims the checkout was STARTED from this app and names that email.
  const copyVariant: LoginCopyVariant = React.useMemo(() => {
    if (checkoutContext?.email) return 'just_paid';
    if (cfg.first_run_signal_key && typeof window !== 'undefined') {
      try {
        if (window.localStorage.getItem(cfg.first_run_signal_key) !== null) return 'first_run';
      } catch { /* storage unavailable -> default */ }
    }
    return 'default';
  }, [cfg.first_run_signal_key, checkoutContext?.email]);

  React.useEffect(() => {
    try {
      setCheckoutContext(readCheckoutContext());
    } catch { setCheckoutContext(null); }
    const refreshOnStorage = () => {
      try { setCheckoutContext(readCheckoutContext()); } catch { /* ignore */ }
    };
    window.addEventListener('storage', refreshOnStorage);
    window.addEventListener('focus', refreshOnStorage);
    return () => {
      window.removeEventListener('storage', refreshOnStorage);
      window.removeEventListener('focus', refreshOnStorage);
    };
  }, []);

  React.useEffect(() => {
    try {
      setLocalFirstRunMarker(readLocalFirstRunProvenance());
    } catch {
      setLocalFirstRunMarker(null);
    }
    const refreshAdoptionMarker = () => {
      try {
        setLocalFirstRunMarker(readLocalFirstRunProvenance());
      } catch { /* storage unavailable is not an account state */ }
    };
    window.addEventListener('storage', refreshAdoptionMarker);
    window.addEventListener('focus', refreshAdoptionMarker);
    return () => {
      window.removeEventListener('storage', refreshAdoptionMarker);
      window.removeEventListener('focus', refreshAdoptionMarker);
    };
  }, []);

  const recordCheckoutStart = React.useCallback((email: string) => {
    const trimmed = email.trim();
    try {
      const payload: CheckoutContext = {
        ...(trimmed ? { email: trimmed } : {}),
        startedAt: Date.now(),
        ...(currentLogBrowserSessionBrowserId() ? { browserId: currentLogBrowserSessionBrowserId() } : {}),
      };
      window.localStorage.setItem(cfg.checkout_context_storage_key ?? CHECKOUT_CONTEXT_STORAGE_KEY, JSON.stringify(payload));
      setCheckoutContext(payload);
    } catch { /* storage unavailable: the link still works, just without context */ }
  }, [cfg.checkout_context_storage_key]);

  const refreshSession = React.useCallback(async () => {
    const next = await readAccountPortalBrowserSession((error) => setActionError(loginLinkFailureMessage(error)));
    setSession(next);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void readAccountPortalBrowserSession((error) => { if (!cancelled) setActionError(loginLinkFailureMessage(error)); }).then((next) => {
      if (!cancelled) {
        setSession(next);
      }
    });
    const refreshOnFocus = () => { if (!cancelled) void refreshSession(); };
    const refreshWhenVisible = () => {
      if (!cancelled && document.visibilityState === 'visible') void refreshSession();
    };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refreshSession]);

  // The session authority owns the exact lease boundary. Schedule one wake at
  // that boundary so an already-open lesson cannot remain readable after the
  // lease expires. Focus/visibility events above cover revocation and resume.
  React.useEffect(() => {
    const expiresAt = session?.sessionExpiresAtMilliseconds;
    if (readAccountSession(session).status !== 'signed_in' || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return;
    const delay = Math.max(0, Math.min(expiresAt - Date.now() + 25, 2_147_483_647));
    const timer = window.setTimeout(() => { void refreshSession(); }, delay);
    return () => window.clearTimeout(timer);
  }, [refreshSession, session]);

  async function requestLink(email: string) {
    const requestTarget = cfg.requestTarget;
    if (typeof requestTarget !== 'string' || requestTarget.trim().length === 0) {
      setActionError('Sign-in is temporarily unavailable. Please try again shortly.');
      throw new Error('magic-link login surface: surfaceInput.requestTarget is required');
    }
    setActionPending(true);
    setActionError(null);
    try {
      const callbackOrigin = chooseCallbackOrigin({
        browserOrigin: window.location.origin,
        declaredOrigin: cfg.callbackOrigin,
      });
      const redirectTo = new URL(cfg.redirectPath ?? '/app', callbackOrigin).toString();
      const destination = new URL(redirectTo);
      const reply = await sendRequestToBitfieldTarget({
        target: requestTarget,
        payload: {
          browser_id: currentLogBrowserSessionBrowserId(),
          session_access_key: currentBrowserSessionAccessKey(),
          email,
          provider_records: records,
          redirect_to: redirectTo,
          returnPath: `${destination.pathname}${destination.search}${destination.hash}`,
        },
      });
      if (!decodeReplyOk(reply)) throw new Error('Could not send the sign-in link.');
    } catch (error) {
      // Never leak raw internal dispatch errors (e.g. "slot invocation failed:
      // status=3") to the user (L114). Log the technical detail; show plain
      // domain language.
      console.error('sign-in link request failed:', error);
      setActionError(loginLinkFailureMessage(error));
      throw error;
    } finally {
      setActionPending(false);
    }
  }

  const projection = session === undefined ? undefined : readAccountSession(session);
  const scopedLocalFirstRunMarker = projection?.status === 'signed_in'
    && localFirstRunMarker?.account_scope === projection.accountIdHash
    ? localFirstRunMarker
    : null;
  const presentation = cfg.presentation === 'modal' || cfg.presentation === 'embedded'
    ? cfg.presentation
    : 'page';
  const protectedSurface = cfg.protected_surface;
  const protectedPackage = protectedSurface?.package_entry?.package_name?.trim();
  const protectedEntry = protectedSurface?.package_entry?.entry_name?.trim();
  const protectedTarget = protectedSurface?.material_target?.trim();

  if (projection?.status === 'signed_in' && protectedPackage && protectedEntry && protectedTarget) {
    return (
      <Container data-authenticated-surface-gate="open" height="full" minHeight="0" width="full" overflow="hidden">
        <PlaceableSurfaceHost
          packageName={protectedPackage}
          entryName={protectedEntry}
          materialTarget={protectedTarget}
          target={protectedSurface?.target}
          surfaceInput={protectedSurface?.surface_input}
          fill
          interactive
        />
      </Container>
    );
  }

  if (presentation === 'embedded' || presentation === 'page') {
    return (
      <LoginPanel
        actionError={actionError}
        actionPending={actionPending}
        checkoutHref={cfg.ctaHref ?? DEFAULT_CHECKOUT_HREF}
        appName={cfg.app_name ?? 'this app'}
        checkoutContext={checkoutContext}
        copyVariant={copyVariant}
        copyVariants={cfg.login_copy_variants}
        presentation={presentation === 'embedded' ? 'embedded' : 'page'}
        session={projection}
        localFirstRunAdoptionId={scopedLocalFirstRunMarker?.adoption_id ?? null}
        localFirstRunJourneyId={scopedLocalFirstRunMarker?.journey_id ?? null}
        showSignup={cfg.show_signup !== false}
        onRequestLoginLink={requestLink}
        onCheckoutStart={recordCheckoutStart}
      />
    );
  }

  const lockedTitle = cfg.locked_title?.trim() || 'Your lessons are ready';
  const lockedDescription = cfg.locked_description?.trim()
    || 'Sign in with your email to open the course and keep your learning connected to your account.';
  const modalTitle = cfg.modal_title?.trim() || 'Sign in to learn';
  const modalDescription = cfg.modal_description?.trim()
    || 'We will email you a secure sign-in link. If you are new, the same link creates your free account.';

  const hasProtectedSurface = Boolean(protectedPackage && protectedEntry && protectedTarget);
  const protectedSurfaceUnavailable = projection?.status === 'signed_in' && !hasProtectedSurface;

  return (
    <Container
      data-authenticated-surface-gate={projection === undefined ? 'checking' : 'locked'}
      height="full"
      minHeight="0"
      width="full"
      overflow="hidden"
      className="relative"
    >
      <LockedSurfacePreview />
      {projection === undefined || !modalOpen || protectedSurfaceUnavailable ? (
        <Container
          className="absolute inset-0 bg-[var(--glass-overlay-background)] backdrop-blur-sm"
          alignItems="center"
          justifyContent="center"
          padding="xl"
        >
          <Container layout="vertical" gap="md" alignItems="center" className="max-w-md text-center">
            <Container alignItems="center" justifyContent="center" className="size-12 rounded-full bg-[var(--surface-raised)] text-[var(--text-secondary)]">
              <LockKeyhole aria-hidden="true" size={22} />
            </Container>
            <Text variant="heading-lg" color="strong">
              {projection === undefined ? 'Checking your sign-in…' : protectedSurfaceUnavailable ? 'Learning is not available right now' : lockedTitle}
            </Text>
            <Text variant="body" color="secondary">
              {projection === undefined ? 'This usually takes a moment.' : protectedSurfaceUnavailable ? 'Your account is signed in, but this learning surface could not be opened.' : lockedDescription}
            </Text>
            {projection !== undefined && !protectedSurfaceUnavailable ? <Button variant="primary" onClick={() => setModalOpen(true)}>Sign in to continue</Button> : null}
          </Container>
        </Container>
      ) : null}
      <FloatingPanel
        open={projection !== undefined && projection.status !== 'signed_in' && modalOpen}
        onClose={() => setModalOpen(false)}
        title={modalTitle}
        description={modalDescription}
        width={480}
      >
        <LoginPanel
          actionError={actionError}
          actionPending={actionPending}
          checkoutHref={cfg.ctaHref ?? DEFAULT_CHECKOUT_HREF}
          appName={cfg.app_name ?? 'this app'}
          checkoutContext={checkoutContext}
          copyVariant={copyVariant}
          copyVariants={cfg.login_copy_variants}
          presentation="embedded"
          session={projection}
          showSignup={cfg.show_signup === true}
          onRequestLoginLink={requestLink}
          onCheckoutStart={recordCheckoutStart}
        />
      </FloatingPanel>
    </Container>
  );
}

type MountArgs = { el: HTMLElement; props?: { surfaceInput?: MagicLinkLoginConfig } };

export default function mount({ el, props }: MountArgs) {
  return mountReactSurface(el, <MagicLinkLoginSurface surfaceInput={props?.surfaceInput} />);
}
