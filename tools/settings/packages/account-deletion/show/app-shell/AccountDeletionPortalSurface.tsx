// packages/account-deletion/show/app-shell/AccountDeletionPortalSurface.tsx
//
// Portal close-account panel: start account closure with a note, or keep the
// account open. Deletion state folds from signed effects. Class names
// bind to the portal stylesheet record.

'use client';

import React from 'react';
import { ShieldAlert, Trash2, Undo2 } from 'lucide-react';
import { Button, Card, Container, Icon, Text, Textarea } from '../../../../../ui';
import {
  readAccountDeletionState,
  type AccountDeletionState,
} from '../../do-work/read-account-deletion-state';
import { sendAccountDeletionEvent } from '../../do-work/send-account-deletion-event';

function displayDate(value: string | null | undefined) {
  if (!value) return 'Not started';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function AccountDeletionPortalSurface() {
  const [state, setState] = React.useState<AccountDeletionState | null | undefined>(undefined);
  const [reasonText, setReasonText] = React.useState('');
  const [actionStatus, setActionStatus] = React.useState<string | null>(null);
  const [actionPending, setActionPending] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void readAccountDeletionState().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function runDeletionAction(eventType: 'deletion_requested' | 'deletion_cancelled') {
    if (!state?.accountId) return;
    setActionPending(true);
    setActionStatus('Sending account update...');
    try {
      const occurredAt = new Date().toISOString();
      await sendAccountDeletionEvent({
        accountId: state.accountId,
        eventId: `${state.accountId}:${eventType}:${occurredAt}`,
        eventType,
        occurredAt,
        reasonText: eventType === 'deletion_requested' ? reasonText : null,
      });
      setState(await readAccountDeletionState());
      setActionStatus('Account update recorded.');
    } catch {
      setActionStatus('Account update failed.');
    } finally {
      setActionPending(false);
    }
  }

  if (state === undefined) {
    return (
      <Container as="section" className="account-self-service-shell account-deletion-shell">
        <Text muted>Loading...</Text>
      </Container>
    );
  }

  if (state === null) {
    return (
      <Container as="section" className="account-self-service-shell account-deletion-shell">
        <Container gap="xs">
          <Text as="h2" variant="title">Close your account.</Text>
          <Text muted>Sign in to close this account.</Text>
        </Container>
      </Container>
    );
  }

  const deletionRequestedAt = state.deletionRequestedAt;

  return (
    <Container as="section" className="account-self-service-shell account-deletion-shell">
      <Container className="account-self-service-hero" layout="horizontal" alignItems="center" justifyContent="between">
        <Container gap="xs">
          <Text as="p" className="account-dashboard-eyebrow">
            Close account
          </Text>
          <Text as="h2" variant="title">Close your account.</Text>
          <Text muted>
            Close this account or keep it open before closure finishes.
          </Text>
        </Container>
        <Container className="account-self-service-hero-icon" aria-hidden="true">
          <Icon icon={ShieldAlert} size="xl" />
        </Container>
      </Container>

      <Container className="account-self-service-grid">
        <Card className="account-self-service-primary-card" padding="lg">
          <Container className="account-self-service-card-heading" layout="horizontal" alignItems="center" justifyContent="between">
            <Container gap="xs">
              <Text as="p" className="account-dashboard-eyebrow">
                Current state
              </Text>
              <Text as="h3" variant="heading-xl">
                {deletionRequestedAt ? 'Closure started' : 'Account open'}
              </Text>
            </Container>
            <Container className="account-dashboard-icon-chip" aria-hidden="true">
              <Icon icon={Trash2} size="lg" />
            </Container>
          </Container>
          <Container className="account-self-service-stat-grid">
            <Container className="account-self-service-stat-card">
              <Text muted>Started</Text>
              <Text as="strong">{displayDate(deletionRequestedAt)}</Text>
            </Container>
            <Container className="account-self-service-stat-card">
              <Text muted>Account</Text>
              <Text as="strong">{deletionRequestedAt ? 'Closing' : 'Active'}</Text>
            </Container>
          </Container>
        </Card>

        <Card variant="nested" className="account-self-service-action-card" padding="lg">
          {deletionRequestedAt ? (
            <Container gap="md">
              <Container gap="xs">
                <Text as="p" className="account-dashboard-eyebrow">
                  Closure in progress
                </Text>
                <Text muted>
                  Account closure is recorded. Keep the account open below if you changed your mind.
                </Text>
              </Container>
              <Button disabled={actionPending} onClick={() => runDeletionAction('deletion_cancelled')} type="button" variant="secondary">
                <Icon icon={Undo2} size="sm" aria-hidden="true" />
                Keep account open
              </Button>
              {actionStatus ? <Text muted>{actionStatus}</Text> : null}
            </Container>
          ) : (
            <Container
              as="form"
              className="account-deletion-form"
              onSubmit={(event: React.FormEvent) => {
                event.preventDefault();
                void runDeletionAction('deletion_requested');
              }}
            >
              <Container gap="xs">
                <Text as="p" className="account-dashboard-eyebrow">
                  Close account
                </Text>
                <Text muted>
                  Tell us why you are leaving if you like, then confirm account closure.
                </Text>
              </Container>
              <Textarea
                label="Reason"
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setReasonText(event.currentTarget.value)}
                placeholder="Reason"
                value={reasonText}
              />
              <Button disabled={actionPending} tone="danger" type="submit">
                <Icon icon={Trash2} size="sm" aria-hidden="true" />
                Close account
              </Button>
              {actionStatus ? <Text muted>{actionStatus}</Text> : null}
            </Container>
          )}
        </Card>
      </Container>
    </Container>
  );
}
