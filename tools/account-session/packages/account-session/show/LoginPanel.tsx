import React from 'react';
import { Button, Container, Input, Text } from '../../../../shared-code/packages/ui';
import type { AccountSessionProjection } from '../read-data/read-session';

export type LoginCopyVariant = 'default' | 'first_run' | 'just_paid';

export interface LoginCopyVariants {
  default?: { title?: string; subtitle?: string };
  first_run?: { title?: string; subtitle?: string };
  just_paid?: { title?: string; subtitle?: string; status?: string };
}

export interface CheckoutContext {
  email?: string;
  startedAt?: number;
  browserId?: string;
}

export const CHECKOUT_CONTEXT_STORAGE_KEY = 'bitfield.account-session.checkout-context';

export function readCheckoutContext(storage?: Pick<Storage, 'getItem'>): CheckoutContext | null {
  try {
    const source = storage ?? globalThis.localStorage;
    const raw = source?.getItem?.(CHECKOUT_CONTEXT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CheckoutContext;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function checkoutHrefWithContext(baseHref: string, context: CheckoutContext | null): string {
  if (!context || !/^https?:\/\//i.test(baseHref)) return baseHref;
  try {
    const url = new URL(baseHref);
    const email = typeof context.email === 'string' && context.email.includes('@') ? context.email.trim() : '';
    if (email && !url.searchParams.has('prefilled_email')) url.searchParams.set('prefilled_email', email);
    if (context.browserId && !url.searchParams.has('client_reference_id')) url.searchParams.set('client_reference_id', context.browserId);
    return url.toString();
  } catch {
    return baseHref;
  }
}

export interface LoginPanelProps {
  actionError?: string | null;
  actionPending?: boolean;
  checkoutHref?: string;
  appName?: string;
  copyVariants?: LoginCopyVariants;
  copyVariant?: LoginCopyVariant;
  checkoutContext?: CheckoutContext | null;
  presentation?: 'page' | 'embedded';
  session: AccountSessionProjection | undefined;
  localFirstRunAdoptionId?: string | null;
  localFirstRunJourneyId?: string | null;
  showLocalFirstRunCleanup?: boolean;
  localFirstRunCleanupState?: 'idle' | 'running' | 'success' | 'error';
  onRemoveLocalFirstRunSummary?: () => void;
  showSignup?: boolean;
  onEndSession?: () => void;
  onRequestLoginLink?: (email: string) => Promise<void> | void;
  onCheckoutStart?: (email: string) => void;
}

function LocalFirstRunSummary({
  adoptionId,
  journeyId,
  showCleanup,
  cleanupState,
  onRemoveCleanup,
  onRetryCleanup,
}: {
  adoptionId?: string | null;
  journeyId?: string | null;
  showCleanup?: boolean;
  cleanupState?: 'idle' | 'running' | 'success' | 'error';
  onRemoveCleanup?: () => void;
  onRetryCleanup?: () => void;
}) {
  const hasMarker = Boolean(adoptionId);
  const busy = cleanupState === 'running';
  return (
    <Container
      as="section"
      className="grid gap-3 rounded-xl border border-[var(--border-primary)] bg-[var(--surface-raised)] p-4"
      data-local-first-run-summary={hasMarker ? 'present' : 'absent'}
      aria-labelledby="local-setup-summary-title"
    >
      <Text as="h2" className="text-lg font-semibold" id="local-setup-summary-title">Local setup summary</Text>
      {hasMarker ? (
        <>
          <Text role="status">Your local setup is ready</Text>
          <Text>Your first-run summary remains on this device.</Text>
        </>
      ) : (
        <Text>No local first-run summary is saved on this device.</Text>
      )}
      {showCleanup ? (
        <Button
          disabled={!hasMarker || busy}
          onClick={onRemoveCleanup}
          type="button"
          variant="secondary"
        >
          Remove this device’s setup summary
        </Button>
      ) : null}
      {cleanupState === 'success' ? (
        <>
          <Text role="status">Removed from this device</Text>
          <Text>Your account was not changed.</Text>
        </>
      ) : null}
      {cleanupState === 'error' ? (
        <>
          <Text role="alert">
            We couldn’t remove the local summary. Your account was not changed. Try again.
          </Text>
          <Button
            disabled={busy || !hasMarker || !onRetryCleanup}
            onClick={onRetryCleanup}
            type="button"
            variant="secondary"
          >
            Try again
          </Button>
        </>
      ) : null}
      {journeyId ? <Text className="sr-only">Journey: {journeyId}</Text> : null}
    </Container>
  );
}

const AUTH_SCREEN_CLASS = 'account-session-entry-screen fixed inset-0 z-[2147483000] flex min-h-screen w-full items-start justify-center overflow-y-auto bg-[var(--black-pure,#050505)] px-5 py-12 text-[var(--text-primary,#f8fafc)] md:py-16';
const AUTH_PANEL_CLASS = 'account-session-entry-panel w-full max-w-[28rem]';
const AUTH_CARD_CLASS = 'account-session-entry-card grid w-full gap-7 rounded-2xl bg-[var(--glass-bg-primary,rgba(17,17,17,0.86))] p-6 shadow-2xl backdrop-blur-xl md:p-8';
const AUTH_COPY_CLASS = 'account-session-entry-copy grid gap-3 text-left';
// Embedded auth intentionally avoids the page-level account-auth-* layout
// hooks. Those global look rules own a fixed, viewport-sized login page; using
// them inside a portal modal makes the form escape its panel and collapse the
// dialog into a scroll strip.
const EMBEDDED_SCREEN_CLASS = 'account-auth-embedded-screen w-full text-[var(--text-primary,#f8fafc)]';
const EMBEDDED_PANEL_CLASS = 'account-auth-embedded-panel w-full items-stretch';
const EMBEDDED_CARD_CLASS = 'account-auth-embedded-card w-full gap-5 p-0';
export const DEFAULT_CHECKOUT_HREF = '/#checkout';

export function LoginPanel({
  actionError = null,
  actionPending = false,
  checkoutHref = DEFAULT_CHECKOUT_HREF,
  appName = 'this app',
  copyVariants,
  copyVariant = 'default',
  checkoutContext = null,
  presentation = 'page',
  session,
  localFirstRunAdoptionId = null,
  localFirstRunJourneyId = null,
  showLocalFirstRunCleanup = false,
  localFirstRunCleanupState = 'idle',
  onRemoveLocalFirstRunSummary,
  showSignup = true,
  onEndSession,
  onRequestLoginLink,
  onCheckoutStart,
}: LoginPanelProps) {
  const [email, setEmail] = React.useState(checkoutContext?.email && checkoutContext.email.includes('@') ? checkoutContext.email : '');
  const [linkSent, setLinkSent] = React.useState(false);
  // The parent resolves the checkout context in an effect (it must also refresh on
  // focus/storage), so a just_paid context can arrive one commit AFTER mount. Once
  // the field is still untouched, adopt a late-arriving checkout email as the
  // prefill: the customer who just paid never re-types their address (D5).
  const emailTouched = React.useRef(false);
  const initialEmailRef = React.useRef(email);
  React.useEffect(() => {
    const late = checkoutContext?.email;
    if (
      late && late.includes('@') && !email && !emailTouched.current
      && initialEmailRef.current !== late
    ) setEmail(late);
  }, [checkoutContext?.email, email]);
  const embedded = presentation === 'embedded';
  const screenClass = embedded ? EMBEDDED_SCREEN_CLASS : AUTH_SCREEN_CLASS;
  const panelClass = embedded ? EMBEDDED_PANEL_CLASS : AUTH_PANEL_CLASS;
  const cardClass = embedded ? EMBEDDED_CARD_CLASS : AUTH_CARD_CLASS;
  const pageScreenStyle: React.CSSProperties | undefined = embedded
    ? undefined
    : {
        zIndex: 2_147_483_000,
        background: 'var(--black-pure, #050505)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 'clamp(3rem, 7vh, 5rem) 1.25rem',
        overflowY: 'auto',
      };
  const pagePanelStyle: React.CSSProperties | undefined = embedded ? undefined : { width: '100%', maxWidth: '28rem' };
  const pageCardStyle: React.CSSProperties | undefined = embedded
    ? undefined
    : {
        display: 'grid',
        width: '100%',
        gap: '1.75rem',
        padding: '2rem',
        border: 'none',
        borderRadius: '1rem',
        background: 'var(--glass-bg-primary, rgba(17,17,17,0.86))',
        boxShadow: '0 24px 80px rgba(0,0,0,0.38)',
      };
  const pageTitleStyle: React.CSSProperties | undefined = embedded
    ? undefined
    : { margin: 0, fontSize: '2rem', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.1 };
  const variantCopy = (copyVariants?.[copyVariant] ?? {}) as { title?: string; subtitle?: string; status?: string };
  const resolvedCheckoutHref = checkoutHrefWithContext(
    checkoutHref,
    checkoutContext ?? (copyVariant === 'just_paid' ? readCheckoutContext() : null),
  );
  // Keep the page inside its declared scene root. Portaling it to body made the
  // screen look present while the scene itself painted zero pixels, so the
  // current-presentation readiness check rejected an otherwise visible login.
  const present = (surface: React.ReactElement) => surface;

  async function requestLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLinkSent(false);
    if (!onRequestLoginLink) return;
    try {
      await onRequestLoginLink(email);
      setLinkSent(true);
    } catch {
      setLinkSent(false);
    }
  }

  if (session === undefined) {
    return present(
      <Container as="section" className={screenClass} data-account-auth-screen data-account-auth-presentation={presentation} style={pageScreenStyle}>
        <Container className={panelClass} style={pagePanelStyle}>
          <Container className={cardClass} style={pageCardStyle}>
            {!embedded ? <Text as="h1" className="account-auth-title" style={pageTitleStyle}>Welcome back</Text> : null}
            <Text className="account-auth-subtitle">
              checking browser session...
            </Text>
          </Container>
        </Container>
      </Container>,
    );
  }

  if (session.status === 'signed_in') {
    return present(
      <section className={screenClass} data-account-auth-screen data-account-auth-presentation={presentation} style={pageScreenStyle}>
        <Container className={panelClass} style={pagePanelStyle}>
          <Container className={cardClass} style={pageCardStyle}>
            {!embedded ? <Container className={AUTH_COPY_CLASS}>
              <Text as="h1" className="account-auth-title" style={pageTitleStyle}>
                You are signed in
              </Text>
              <Text className="account-auth-subtitle">
                Open your account or end this browser session.
              </Text>
            </Container> : null}
            {actionError ? (
              <Text className="account-auth-message account-auth-message-error" role="alert">
                {actionError}
              </Text>
            ) : null}
            <LocalFirstRunSummary
              adoptionId={localFirstRunAdoptionId}
              journeyId={localFirstRunJourneyId}
              showCleanup={showLocalFirstRunCleanup}
              cleanupState={localFirstRunCleanupState}
              onRemoveCleanup={onRemoveLocalFirstRunSummary}
              onRetryCleanup={onRemoveLocalFirstRunSummary}
            />
            <Button
              onClick={() => {
                window.location.assign('/account?surface=account');
              }}
              size="lg"
              type="button"
              variant="primary"
              className="account-auth-submit"
            >
              open account dashboard
            </Button>
            <Button
              disabled={actionPending || !onEndSession}
              onClick={onEndSession}
              size="lg"
              type="button"
              variant="secondary"
              className="account-auth-submit account-auth-submit-secondary"
            >
              {actionPending ? 'ending session...' : 'end session'}
            </Button>
          </Container>
        </Container>
      </section>,
    );
  }

  return present(
    <section className={screenClass} data-account-auth-screen data-account-auth-presentation={presentation} style={pageScreenStyle}>
      <Container className={panelClass} style={pagePanelStyle}>
        <Container className={cardClass} style={pageCardStyle}>
          {!embedded ? <Container className={AUTH_COPY_CLASS} data-account-auth-copy-variant={copyVariant}>
            <Text as="h1" className="account-auth-title" style={pageTitleStyle}>
              {variantCopy.title ?? 'Welcome back'}
            </Text>
            <Text className="account-auth-subtitle">
              {variantCopy.subtitle ?? 'Enter your email and we will send you a secure sign-in link.'}
            </Text>
          </Container> : null}
          {copyVariant === 'just_paid' && checkoutContext?.email ? (
            <Text className="account-auth-checkout-state" data-account-checkout-state="paid-pending-sign-in" role="status">
              {/* The DATA status template may name the checkout email with a literal
                  {email} slot; interpolate the RECORDED checkout email so the customer
                  sees their own address, never a raw template token. */}
              {(variantCopy.status ?? 'Your account is paid. Sign in with the email you used at checkout.')
                .replace(/\{email\}/g, checkoutContext.email)}
            </Text>
          ) : null}
          {actionError ? (
            <Text className="account-auth-message account-auth-message-error" role="alert">
              {actionError}
            </Text>
          ) : null}
          {linkSent ? (
            <Text className="account-auth-message" role="status">
              check your email for the sign-in link.
            </Text>
          ) : null}
          {onRequestLoginLink ? (
            <form className="account-auth-form grid gap-4" onSubmit={requestLink}>
              <Input
                autoComplete="email"
                inputMode="email"
                label="Email address"
                name="email"
                onChange={(event) => { emailTouched.current = true; setEmail(event.currentTarget.value); }}
                placeholder="you@example.com"
                required
                type="email"
                value={email}
              />
              <Button
                disabled={actionPending || !email.trim()}
                loading={actionPending}
                size="lg"
                type="submit"
                variant="primary"
                className="account-auth-submit"
              >
                {actionPending ? 'Sending your link...' : 'Email me a sign-in link'}
              </Button>
            </form>
          ) : null}
          {showSignup ? <Text as="p" className="account-auth-footer-copy text-center">
            New to {appName}?{' '}
            <a
              data-account-checkout-context={checkoutContext ? 'carried' : undefined}
              onClick={() => onCheckoutStart?.(email)}
              href={resolvedCheckoutHref}
              target={/^https?:\/\//i.test(resolvedCheckoutHref) ? '_blank' : undefined}
              rel={/^https?:\/\//i.test(resolvedCheckoutHref) ? 'noopener noreferrer' : undefined}
              className="account-auth-inline-action inline-flex min-h-10 items-center rounded-lg px-3 py-2 font-semibold text-[var(--text-primary,#f8fafc)] underline underline-offset-4"
            >
              Start your account
            </a>
          </Text> : null}
        </Container>
      </Container>
    </section>,
  );
}
