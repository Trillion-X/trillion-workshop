import React from 'react';
import { Check, Copy, KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { BitfieldBrand, Button, Card, Container, Icon, Input, Text } from '../../../../shared-code/packages/ui';
import type { AccountStateProjection } from '../read-data/read-account-state';

export interface AccountDashboardProps {
  actionError?: string | null;
  actionPending?: boolean;
  account: AccountStateProjection | null | undefined;
  checkoutHref?: string;
  linkSent?: boolean;
  onEndSession?: () => Promise<void> | void;
  onRequestLoginLink?: (email: string) => Promise<void> | void;
}

function AccountAccessGate({
  actionError = null,
  actionPending = false,
  checkoutHref = '/?surface=checkout',
  linkSent = false,
  onRequestLoginLink,
}: Omit<AccountDashboardProps, 'account'>) {
  const [email, setEmail] = React.useState('');

  async function requestLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onRequestLoginLink) return;
    await onRequestLoginLink(email);
  }

  return (
    <section className="account-auth-screen" data-account-auth-screen>
      <aside className="account-auth-brand-panel" aria-hidden="true">
        <BitfieldBrand />
        <Text as="p">
          Your access, devices, rewards, and plan all live behind your account.
        </Text>
      </aside>
      <Container className="account-auth-form-panel">
        <Container className="account-auth-card">
          <Container className="account-auth-mobile-brand">
            <BitfieldBrand />
          </Container>
          <Container className="account-auth-copy">
            <Text as="p" className="account-auth-eyebrow">
              Your account
            </Text>
            <Text as="h1" variant="display">
              Sign in to continue.
            </Text>
            <Text muted>
              Enter the email you signed up with and we will send you a secure
              sign-in link.
            </Text>
          </Container>
          {actionError ? (
            <Text muted role="alert">
              {actionError}
            </Text>
          ) : null}
          {linkSent ? (
            <Text muted role="status">
              Check your email for the sign-in link.
            </Text>
          ) : null}
          <form className="account-auth-form" onSubmit={requestLink}>
            <Input
              autoComplete="email"
              inputMode="email"
              label="Email"
              name="email"
              onChange={(event) => setEmail(event.currentTarget.value)}
              placeholder="you@example.com"
              required
              type="email"
              value={email}
            />
            <Button
              disabled={actionPending || !email.trim() || !onRequestLoginLink}
              loading={actionPending}
              size="lg"
              type="submit"
              variant="primary"
              fullWidth
            >
              {actionPending ? 'Sending link' : 'Email sign-in link'}
            </Button>
          </form>
          <Container className="account-auth-divider" layout="horizontal" alignItems="center">
            <span />
            <Text muted>No account yet?</Text>
            <span />
          </Container>
          <Button
            onClick={() => {
              window.location.assign(checkoutHref);
            }}
            size="lg"
            type="button"
            variant="secondary"
            fullWidth
          >
            Create an account
          </Button>
        </Container>
      </Container>
    </section>
  );
}

function AccountDashboardLoading() {
  return (
    <Container as="section">
      <Text as="h2" variant="heading-2xl">Account status</Text>
      <Card>
        <Container gap="sm">
          <Text muted>Checking sign-in...</Text>
        </Container>
      </Card>
    </Container>
  );
}

function displayValue(value: string | null | undefined) {
  return value && value.trim() ? value : 'Not available';
}

function displayStatus(value: string | null | undefined) {
  return displayValue(value)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function AccountDashboard({
  actionError = null,
  actionPending = false,
  account,
  checkoutHref = '/?surface=checkout',
  linkSent = false,
  onEndSession,
  onRequestLoginLink,
}: AccountDashboardProps) {
  const [copiedValue, setCopiedValue] = React.useState<string | null>(null);

  async function copyAccountValue(label: string, value: string | null | undefined) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopiedValue(label);
    window.setTimeout(() => setCopiedValue(null), 1600);
  }

  if (account === undefined) {
    return <AccountDashboardLoading />;
  }

  if (!account) {
    return (
      <AccountAccessGate
        actionError={actionError}
        actionPending={actionPending}
        checkoutHref={checkoutHref}
        linkSent={linkSent}
        onRequestLoginLink={onRequestLoginLink}
      />
    );
  }

  return (
    <Container as="section" className="account-dashboard-shell">
      <Container className="account-dashboard-hero" layout="horizontal" alignItems="center" justifyContent="between">
        <Container className="account-dashboard-hero-copy" gap="xs">
          <Text as="p" className="account-dashboard-eyebrow">
            Signed in
          </Text>
          <Text as="h2" variant="heading-2xl">Account status</Text>
          <Text muted>
            This browser session is signed in to your account.
          </Text>
        </Container>
        <Container className="account-dashboard-status-pill" layout="horizontal" alignItems="center">
          <Icon icon={ShieldCheck} size="md" aria-hidden="true" />
          <Text as="span">{displayStatus(account.lifecycleState)}</Text>
        </Container>
      </Container>

      {actionError ? (
        <Card variant="error" role="alert" className="account-dashboard-alert">
          <Text>{actionError}</Text>
        </Card>
      ) : null}

      <Container className="account-dashboard-grid">
        <Card className="account-dashboard-primary-card" padding="lg">
          <Container className="account-dashboard-card-heading" layout="horizontal" alignItems="center" justifyContent="between">
            <Container gap="xs">
              <Text as="p" className="account-dashboard-eyebrow">
                Member key
              </Text>
              <Text as="h3" variant="heading-xl">Identity</Text>
            </Container>
            <span className="account-dashboard-icon-chip" aria-hidden="true">
              <Icon icon={KeyRound} size="lg" />
            </span>
          </Container>

          <Container className="account-dashboard-copy-card">
            <Text as="span" className="account-dashboard-copy-value" mono>
              {account.accountKey}
            </Text>
            <Button
              aria-label="Copy member key"
              fullWidth
              onClick={() => void copyAccountValue('key', account.accountKey)}
              size="sm"
              type="button"
              variant="secondary"
            >
              <Icon icon={copiedValue === 'key' ? Check : Copy} size="sm" aria-hidden="true" />
              {copiedValue === 'key' ? 'Copied' : 'Copy'}
            </Button>
          </Container>

          <Container className="account-dashboard-stat-grid">
            <Container className="account-dashboard-stat-card">
              <Text muted>Access</Text>
              <Text as="strong">{displayValue(account.planLabel)}</Text>
            </Container>
            <Container className="account-dashboard-stat-card">
              <Text muted>Devices</Text>
              <Text as="strong">{displayValue(account.activeActivationCount)}</Text>
            </Container>
            <Container className="account-dashboard-stat-card">
              <Text muted>Renews</Text>
              <Text as="strong">{displayValue(account.currentPeriodEndsAt)}</Text>
            </Container>
          </Container>
        </Card>

        <Container className="account-dashboard-side-stack">
          <Card variant="nested" className="account-dashboard-detail-card">
            <Text as="p" className="account-dashboard-eyebrow">
              Account details
            </Text>
            <Container className="account-dashboard-detail-list">
              <Container>
                <Text muted>Account ID</Text>
                <Text as="strong" mono>{account.accountId}</Text>
              </Container>
              <Container>
                <Text muted>Purchase record</Text>
                <Text as="strong" mono>{displayValue(account.contractId)}</Text>
              </Container>
              <Container>
                <Text muted>Renews</Text>
                <Text as="strong" mono>{displayValue(account.currentPeriodEndsAt)}</Text>
              </Container>
            </Container>
          </Card>

          <Card variant="nested" className="account-dashboard-session-card">
            <Container gap="xs">
              <Text as="p" className="account-dashboard-eyebrow">
                This browser
              </Text>
              <Text muted>
                Sign out only ends this browser session. Your account and active devices stay intact.
              </Text>
            </Container>
            <Button
              disabled={actionPending || !onEndSession}
              fullWidth
              loading={actionPending}
              onClick={onEndSession}
              size="lg"
              type="button"
              variant="primary"
            >
              <Icon icon={LogOut} size="md" aria-hidden="true" />
              {actionPending ? 'Signing out' : 'Sign out'}
            </Button>
          </Card>
        </Container>
      </Container>
    </Container>
  );
}
