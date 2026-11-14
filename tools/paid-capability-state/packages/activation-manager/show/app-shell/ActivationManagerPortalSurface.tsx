// packages/activation-manager/show/app-shell/ActivationManagerPortalSurface.tsx
//
// Portal devices panel: authorized-device list for the signed-in account.
// The class names bind to the portal stylesheet record
// (document-stylesheet:account-portal-chrome / bitfield-site-global-look).

'use client';

import React from 'react';
import { MonitorSmartphone, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, Container, Icon, Text } from '../../../../../ui';
import {
  readPortalActivationSummary,
  type PortalActivation,
  type PortalActivationSummary,
} from '../../do-work/read-portal-activations';

function isActive(status: string) {
  return status.toLowerCase() === 'active';
}

function displayStatus(value: string) {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ') || 'Unknown';
}

function shortValue(value: string) {
  if (value.length <= 28) return value;
  return `${value.slice(0, 14)}...${value.slice(-8)}`;
}

function displayActivationLabel(activation: PortalActivation) {
  if (activation.label && activation.label !== activation.activationId) return activation.label;
  return shortValue(activation.activationId);
}

function displayDate(value: string | null) {
  if (!value) return 'Not recorded';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function ActivationManagerPortalSurface() {
  const [summary, setSummary] =
    React.useState<PortalActivationSummary | null | undefined>(undefined);
  const [statusFilter, setStatusFilter] = React.useState('all');

  React.useEffect(() => {
    let cancelled = false;
    void readPortalActivationSummary().then((next) => {
      if (!cancelled) setSummary(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const activations = summary ? summary.devices : summary;

  if (activations === undefined) {
    return (
      <Container as="section" className="account-self-service-shell activation-manager-shell">
        <Text muted>Loading devices...</Text>
      </Container>
    );
  }

  if (activations === null) {
    return (
      <Container as="section" className="account-self-service-shell activation-manager-shell">
        <Container gap="xs">
          <Text as="h2" variant="title">Authorized devices.</Text>
          <Text muted>Sign in to review the devices that can use this account.</Text>
        </Container>
      </Container>
    );
  }

  // The billable count comes from the account's plan effect (active_activation_count),
  // which is authoritative even when no per-device rows are visible for this subject.
  const activeCount = summary.activeDeviceCount;
  const totalCount = summary.totalDeviceCount;
  const statusFilters = ['all', ...new Set(activations.map((activation) => activation.status))];
  const visibleActivations = statusFilter === 'all'
    ? activations
    : activations.filter((activation) => activation.status === statusFilter);

  return (
    <Container as="section" className="account-self-service-shell activation-manager-shell">
      <Container className="account-self-service-hero" layout="horizontal" alignItems="center" justifyContent="between">
        <Container gap="xs">
          <Text as="p" className="account-dashboard-eyebrow">
            Devices
          </Text>
          <Text as="h2" variant="title">Authorized devices.</Text>
          <Text muted>
            Review every device that can use this account.
          </Text>
        </Container>
        <Container className="account-self-service-hero-icon" aria-hidden="true">
          <Icon icon={MonitorSmartphone} size="xl" />
        </Container>
      </Container>

      <Container className="account-self-service-stat-grid activation-manager-stats">
        <Container className="account-self-service-stat-card">
          <Text as="strong">{totalCount}</Text>
          <Text muted>Total devices</Text>
        </Container>
        <Container className="account-self-service-stat-card">
          <Text as="strong">{activeCount}</Text>
          <Text muted>Active</Text>
        </Container>
        <Container className="account-self-service-stat-card">
          <Text as="strong">{Math.max(0, totalCount - activeCount)}</Text>
          <Text muted>Need review</Text>
        </Container>
      </Container>

      <Card className="account-self-service-primary-card activation-manager-card" padding="lg">
        <Container className="account-self-service-card-heading" layout="horizontal" alignItems="center" justifyContent="between">
          <Container gap="xs">
            <Text as="p" className="account-dashboard-eyebrow">
              Device list
            </Text>
            <Text as="h3" variant="heading-lg">
              {visibleActivations.length} shown
            </Text>
          </Container>
          <Container className="activation-manager-filter-row" layout="horizontal" alignItems="center">
            {statusFilters.map((status) => (
              <Button
                active={statusFilter === status}
                key={status}
                onClick={() => setStatusFilter(status)}
                size="sm"
                type="button"
                variant="secondary"
              >
                {status === 'all' ? 'All' : displayStatus(status)}
              </Button>
            ))}
          </Container>
        </Container>

        {activations.length === 0 ? (
          <Container className="account-self-service-empty-card activation-manager-empty">
            <Container className="account-dashboard-icon-chip" aria-hidden="true">
              <Icon icon={ShieldCheck} size="lg" />
            </Container>
            <Container gap="xs">
              {activeCount > 0 ? (
                <>
                  <Text as="strong">
                    {activeCount} active {activeCount === 1 ? 'device' : 'devices'}
                    {summary.planLabel ? ` on your ${summary.planLabel} plan` : ''}.
                  </Text>
                  <Text muted>
                    Open Bitfield on a device to see it listed here.
                  </Text>
                </>
              ) : (
                <>
                  <Text as="strong">No devices yet.</Text>
                  <Text muted>
                    Authorize a device from a Bitfield app and it will appear here.
                  </Text>
                </>
              )}
            </Container>
          </Container>
        ) : (
          <Container className="activation-manager-list">
            {visibleActivations.map((activation) => (
              <Container className="activation-manager-row" key={activation.activationId}>
                <Container className="activation-manager-row-main">
                  <Text as="strong">{displayActivationLabel(activation)}</Text>
                  <Text muted mono>{activation.devicePublicKeyHash}</Text>
                </Container>
                <Container className="activation-manager-row-meta">
                  <Text muted>Last seen</Text>
                  <Text as="strong">{displayDate(activation.lastSeenAt)}</Text>
                </Container>
                <Badge tone={isActive(activation.status) ? 'green' : 'neutral'}>
                  {displayStatus(activation.status)}
                </Badge>
              </Container>
            ))}
          </Container>
        )}
      </Card>
    </Container>
  );
}
