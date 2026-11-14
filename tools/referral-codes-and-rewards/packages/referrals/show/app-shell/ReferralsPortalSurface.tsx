// packages/referrals/show/app-shell/ReferralsPortalSurface.tsx
//
// Portal referrals panel: your referral code, accepted referral count, and an
// record-a-code form. Referral events sign and admit through the signed event
// authority. Class names bind to the portal stylesheet record.

'use client';

import React from 'react';
import { Gift, TicketPercent } from 'lucide-react';
import { Button, Card, Container, Icon, Input, Text } from '../../../../../ui';
import {
  readPortalReferralState,
  type PortalReferralState,
} from '../../do-work/read-portal-referrals';
import { makeReferralCode, sendReferralEvent } from '../../do-work/send-referral-event';

export function ReferralsPortalSurface({ codePrefix = 'REF' }: { codePrefix?: string }) {
  const [state, setState] = React.useState<PortalReferralState | null | undefined>(undefined);
  const [code, setCode] = React.useState('');
  const [actionStatus, setActionStatus] = React.useState<string | null>(null);
  const [actionPending, setActionPending] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void readPortalReferralState().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function runReferralAction(
    eventType: 'referral_code_created' | 'referral_code_applied',
    referralCode: string,
  ) {
    if (!state?.accountId || !referralCode.trim()) return;
    setActionPending(true);
    setActionStatus('Recording...');
    try {
      const occurredAt = new Date().toISOString();
      await sendReferralEvent({
        accountId: state.accountId,
        eventId: `${state.accountId}:${eventType}:${occurredAt}`,
        eventType,
        occurredAt,
        referralCode: referralCode.trim(),
      });
      setState(await readPortalReferralState());
      setActionStatus('Recorded.');
    } catch {
      setActionStatus('Could not record the referral update.');
    } finally {
      setActionPending(false);
    }
  }

  if (state === undefined) {
    return (
      <Container as="section" className="account-self-service-shell referrals-shell">
        <Text muted>Loading referrals...</Text>
      </Container>
    );
  }

  if (state === null) {
    return (
      <Container as="section" className="account-self-service-shell referrals-shell">
        <Container gap="xs">
          <Text as="h2" variant="title">Referrals.</Text>
          <Text muted>Sign in to create and record referral codes.</Text>
        </Container>
      </Container>
    );
  }

  return (
    <Container as="section" className="account-self-service-shell referrals-shell">
      <Container className="account-self-service-hero" layout="horizontal" alignItems="center" justifyContent="between">
        <Container gap="xs">
          <Text as="p" className="account-dashboard-eyebrow">
            Referrals
          </Text>
          <Text as="h2" variant="title">Share and track referrals.</Text>
          <Text muted>
            Create your referral code and record codes you receive.
          </Text>
        </Container>
        <Container className="account-self-service-hero-icon" aria-hidden="true">
          <Icon icon={Gift} size="xl" />
        </Container>
      </Container>

      <Container className="account-self-service-stat-grid">
        <Container className="account-self-service-stat-card">
          <Text as="strong" mono>{state.referralCode ?? 'None yet'}</Text>
          <Text muted>Your code</Text>
        </Container>
        <Container className="account-self-service-stat-card">
          <Text as="strong">{state.acceptedReferralCount}</Text>
          <Text muted>Accepted referrals</Text>
        </Container>
      </Container>

      <Container className="account-self-service-grid">
        <Card className="account-self-service-primary-card" padding="lg">
          <Container gap="xs">
            <Text as="p" className="account-dashboard-eyebrow">
              Your code
            </Text>
            <Text as="h3" variant="heading-lg">
              {state.referralCode ?? 'Create your referral code.'}
            </Text>
            <Text muted>
              Share your code to attribute future signups to your account.
            </Text>
          </Container>
          {!state.referralCode ? (
            <Container className="account-self-service-action-row">
              <Button
                disabled={actionPending}
                onClick={() => runReferralAction('referral_code_created', makeReferralCode(codePrefix))}
                type="button"
                variant="secondary"
              >
                <Icon icon={Gift} size="sm" aria-hidden="true" />
                Create code
              </Button>
            </Container>
          ) : null}
        </Card>

        <Card variant="nested" className="account-self-service-action-card" padding="lg">
          <Container
            as="form"
            onSubmit={(event: React.FormEvent) => {
              event.preventDefault();
              void runReferralAction('referral_code_applied', code);
            }}
          >
            <Container gap="xs">
              <Text as="p" className="account-dashboard-eyebrow">
                Record a code
              </Text>
              <Text muted>
                Record a referral code you received.
              </Text>
            </Container>
            <Input
              label="Referral code"
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setCode(event.currentTarget.value)}
              placeholder="Referral code"
              value={code}
            />
            <Button disabled={actionPending || !code.trim()} type="submit" variant="secondary">
              <Icon icon={TicketPercent} size="sm" aria-hidden="true" />
              Record code
            </Button>
            {actionStatus ? <Text muted>{actionStatus}</Text> : null}
          </Container>
        </Card>
      </Container>
    </Container>
  );
}
