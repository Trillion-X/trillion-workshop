// packages/service-connections/show/ServiceConnectionCard.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// One service tile inside the responsive catalog grid. Reference anatomy:
// Langdock integrations tile — mark + name on the first line, one-line
// purpose under it, state/action right-aligned on the first line. Compact
// (~64px) so the auto-fill grid stays dense at any container width.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Uses ONLY @/packages/ui barrel imports — zero raw HTML
// 2. Name and purpose truncate, never wrap — tile height stays constant
// 3. Connected state is quiet (green check + text); Disconnect is reachable
//    but never the loudest element
// 4. Zero branching on service identity — all configuration is props
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import {
  Button,
  Card,
  Container,
  Icon,
  ProviderMark,
  Text,
  type ProviderIconRegistryRow,
} from '@/packages/ui';
import { Check } from 'lucide-react';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ServiceConnectionCardProps {
  /** Display name ("GitHub", "Notion", etc.) */
  serviceName: string;

  /** Open provider identity used to resolve the shared brand registry */
  serviceVendor: string;

  /** What connecting this service lets the user do, in their language */
  purpose: string;

  /**
   * Account identity for this connected instance ("work@example.com",
   * "Personal"); '' = never set. When present it REPLACES the purpose line —
   * a connected tile answers "which account is this?", not "what could this
   * do?" (the question the purpose line answers for available tiles).
   */
  accountLabel?: string;

  /** Raw provider-icon DATA rows; unknown vendors keep the monogram fallback */
  providerIconRegistry: readonly ProviderIconRegistryRow[];

  /** True when the service is connected */
  isConnected: boolean;

  /** True when a connection attempt failed and can be retried */
  isError: boolean;

  /** Callback when user clicks Connect */
  onConnect: () => void;

  /** Caller-owned wording for a non-connection choice such as onboarding. */
  actionLabel?: string;

  /** Prevent duplicate owner writes while the chosen action is in flight. */
  actionDisabled?: boolean;

  /** Callback when user clicks Disconnect */
  onDisconnect: () => void;

  /** Callback when user adds another account of this service */
  onAddAccount: () => void;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

export function ServiceConnectionCard({
  serviceName,
  serviceVendor,
  purpose,
  accountLabel = '',
  providerIconRegistry,
  isConnected,
  isError,
  onConnect,
  actionLabel,
  actionDisabled = false,
  onDisconnect,
  onAddAccount,
}: ServiceConnectionCardProps) {
  // Connected tiles identify WHICH account; available tiles pitch WHAT
  // connecting does. One line either way — tile height stays constant.
  const subline = (isConnected && accountLabel) ? accountLabel : purpose;
  return (
    // No `interactive` — the tile itself is not clickable, only its button.
    // A whole-card pointer cursor promises a click the card doesn't honor.
    <Card variant="nested" padding="sm">
      <Container layout="horizontal" alignItems="center" gap="sm" padding="none">
        <ProviderMark
          providerSlug={serviceVendor}
          providerName={serviceName}
          registry={providerIconRegistry}
          size="md"
          decorative
        />

        <Container layout="vertical" gap="none" padding="none" flex={1} minWidth="0">
          <Text variant="body" weight="medium" truncate>{serviceName}</Text>
          {subline ? (
            <Text variant="body-xs" color="muted" truncate>{subline}</Text>
          ) : null}
        </Container>

        {isConnected ? (
          <Container layout="horizontal" gap="xs" alignItems="center" padding="none">
            <Icon icon={Check} size="xs" color="success" />
            <Text variant="body-xs" color="success">Connected</Text>
            <Button variant="ghost" size="sm" onClick={onAddAccount} title="Connect another account">
              Add account
            </Button>
            <Button variant="ghost" size="sm" onClick={onDisconnect}>
              Disconnect
            </Button>
          </Container>
        ) : (
          <Button
            variant={isError ? 'secondary' : 'primary'}
            size="sm"
            onClick={onConnect}
            disabled={actionDisabled}
          >
            {actionLabel ?? (isError ? 'Retry' : 'Connect')}
          </Button>
        )}
      </Container>
    </Card>
  );
}
