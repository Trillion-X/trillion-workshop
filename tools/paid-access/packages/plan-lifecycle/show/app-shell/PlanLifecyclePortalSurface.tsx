// packages/plan-lifecycle/show/app-shell/PlanLifecyclePortalSurface.tsx
//
// Portal plan panel: current access status plus pause/resume/cancel lifecycle
// actions signed and admitted through the signed event authority. Plan changes
// go through the checkout surface; account closure goes to the deletion surface.
// Class names bind to the portal stylesheet record.

'use client';

import React from 'react';
import { CalendarClock, CreditCard, PauseCircle, PlayCircle, Trash2, XCircle } from 'lucide-react';
import { Badge, Button, Card, Container, Icon, Text } from '../../../../../ui';
import {
  readPortalPlanState,
  type PortalPlanState,
} from '../../do-work/read-portal-plan-state';
import { sendPlanLifecycleEvent } from '../../do-work/send-plan-lifecycle-event';

const CHANGE_PLAN_HREF = '/account?surface=checkout';
const CLOSE_ACCOUNT_HREF = '/account?surface=deletion';

function displayState(value: string) {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ') || 'Waiting';
}

function displayDate(value: string | null | undefined) {
  if (!value) return 'Not set';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function PlanLifecyclePortalSurface() {
  const [plan, setPlan] = React.useState<PortalPlanState | null | undefined>(undefined);
  const [actionStatus, setActionStatus] = React.useState<string | null>(null);
  const [actionPending, setActionPending] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void readPortalPlanState().then((next) => {
      if (!cancelled) setPlan(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function runLifecycleAction(eventType: string) {
    if (!plan?.accountId) return;
    setActionPending(true);
    setActionStatus('Sending account update...');
    try {
      const occurredAt = new Date().toISOString();
      await sendPlanLifecycleEvent({
        accountId: plan.accountId,
        eventId: `${plan.accountId}:${eventType}:${occurredAt}`,
        eventType,
        occurredAt,
      });
      setPlan(await readPortalPlanState());
      setActionStatus('Account update recorded.');
    } catch {
      setActionStatus('Account update failed.');
    } finally {
      setActionPending(false);
    }
  }

  if (plan === undefined) {
    return (
      <Container as="section" className="account-self-service-shell plan-lifecycle-shell">
        <Text muted>Loading plan...</Text>
      </Container>
    );
  }

  if (plan === null) {
    return (
      <Container as="section" className="account-self-service-shell plan-lifecycle-shell">
        <Container gap="xs">
          <Text as="h2" variant="title">Manage your access.</Text>
          <Text muted>Sign in to manage your plan and billing.</Text>
        </Container>
      </Container>
    );
  }

  const statusCopy = displayState(plan.lifecycleState);
  const lifecycleTone = plan.lifecycleState === 'cancelled' ? 'red' : 'green';
  const paused = plan.lifecycleState === 'paused';

  return (
    <Container as="section" className="account-self-service-shell plan-lifecycle-shell">
      <Container className="account-self-service-hero" layout="horizontal" alignItems="center" justifyContent="between">
        <Container gap="xs">
          <Text as="p" className="account-dashboard-eyebrow">
            Plan &amp; billing
          </Text>
          <Text as="h2" variant="title">Manage your access.</Text>
          <Text muted>
            Change plan, billing, or account closure.
          </Text>
        </Container>
        <Container className="account-self-service-hero-icon" aria-hidden="true">
          <Icon icon={CreditCard} size="xl" />
        </Container>
      </Container>

      <Container className="account-self-service-grid">
        <Card className="account-self-service-primary-card" padding="lg">
          <Container className="account-self-service-card-heading" layout="horizontal" alignItems="center" justifyContent="between">
            <Container gap="xs">
              <Text as="p" className="account-dashboard-eyebrow">
                Current access
              </Text>
              <Text as="h3" variant="heading-xl">
                {plan.planLabel}
              </Text>
            </Container>
            <Badge tone={lifecycleTone}>{statusCopy}</Badge>
          </Container>

          <Container className="account-self-service-stat-grid">
            <Container className="account-self-service-stat-card">
              <Text muted>Status</Text>
              <Text as="strong">{statusCopy}</Text>
            </Container>
            <Container className="account-self-service-stat-card">
              <Text muted>Resumes</Text>
              <Text as="strong">{displayDate(plan.resumesAt)}</Text>
            </Container>
            <Container className="account-self-service-stat-card">
              <Text muted>Cancelled</Text>
              <Text as="strong">{displayDate(plan.cancelledAt)}</Text>
            </Container>
          </Container>
        </Card>

        <Card variant="nested" className="account-self-service-action-card plan-lifecycle-plan-management-card" padding="lg">
          <Container gap="xs">
            <Text as="p" className="account-dashboard-eyebrow">
              Plan changes
            </Text>
            <Text as="h3" variant="heading-lg">Update access.</Text>
            <Text muted>
              Choose a different plan through checkout, or pause, resume, and cancel here.
            </Text>
          </Container>

          <Container className="account-self-service-action-row">
            <Button fullWidth onClick={() => { window.location.assign(CHANGE_PLAN_HREF); }} type="button" variant="secondary">
              <Icon icon={CreditCard} size="sm" aria-hidden="true" />
              Change plan
            </Button>
            {paused ? (
              <Button disabled={actionPending} fullWidth onClick={() => runLifecycleAction('resumed')} type="button" variant="secondary">
                <Icon icon={PlayCircle} size="sm" aria-hidden="true" />
                Resume
              </Button>
            ) : (
              <Button disabled={actionPending} fullWidth onClick={() => runLifecycleAction('paused')} type="button" variant="secondary">
                <Icon icon={PauseCircle} size="sm" aria-hidden="true" />
                Pause
              </Button>
            )}
            <Button disabled={actionPending} fullWidth onClick={() => runLifecycleAction('cancelled')} type="button" tone="danger">
              <Icon icon={XCircle} size="sm" aria-hidden="true" />
              Cancel plan
            </Button>
            <Button fullWidth onClick={() => { window.location.assign(CLOSE_ACCOUNT_HREF); }} type="button" variant="secondary">
              <Icon icon={Trash2} size="sm" aria-hidden="true" />
              Delete account
            </Button>
          </Container>
          {actionStatus ? <Text muted>{actionStatus}</Text> : null}
        </Card>

        <Card variant="nested" className="account-self-service-detail-card" padding="lg">
          <Container className="account-self-service-card-heading" layout="horizontal" alignItems="center">
            <Container className="account-dashboard-icon-chip" aria-hidden="true">
              <Icon icon={CalendarClock} size="lg" />
            </Container>
            <Container gap="xs">
              <Text as="p" className="account-dashboard-eyebrow">
                Billing
              </Text>
              <Text muted>
                Purchase details appear when available.
              </Text>
            </Container>
          </Container>
          <Container className="account-self-service-stat-grid">
            <Container className="account-self-service-stat-card">
              <Text muted>Purchase</Text>
              <Text as="strong" mono>{plan.contractId ?? 'Not available'}</Text>
            </Container>
            <Container className="account-self-service-stat-card">
              <Text muted>Renews</Text>
              <Text as="strong">{displayDate(plan.resumesAt)}</Text>
            </Container>
          </Container>
        </Card>
      </Container>
    </Container>
  );
}
