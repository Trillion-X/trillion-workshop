//
// =============================================================================
// PURPOSE
// =============================================================================
//
// React component for displaying rail spend-authority configuration and budget controls.
// Shows rail address, network, asset, budget limits, and spending totals.
// All styling through ui/ component props — zero raw HTML (L065/L066).
// Wallet-specific display is configuration-driven, not code-branched.
// Pure display component — no local edit state. onConfigure prop handles mutation.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero raw HTML — all layout through Container, Text, Button, Badge
// 2. Zero hardcoded wallet-specific logic — wallet is just data to display
// 3. All imports from @/packages/ui barrel only
// 4. Component is stateless — no local state management
// 5. Configuration is pure data, never code
// 6. Zero inline styles — all styling through component props
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Card, Container, Text, Button, Badge } from '@/packages/ui';
import type { SpendAuthority } from '@/packages/agent-wallet/read-data/read-agent-wallet';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface AgentWalletPanelProps {
  wallet: SpendAuthority | null;
  onConfigure?: () => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * AgentWalletPanel: Display rail spend-authority configuration and budget controls.
 *
 * Pure display component. Shows wallet status, address, network, asset,
 * auto-approve threshold, daily limit, and spending totals. No local edit
 * state — mutations are delegated to the parent via onConfigure callback.
 */
export function AgentWalletPanel({ wallet, onConfigure }: AgentWalletPanelProps) {
  if (!wallet) {
    return (
      <Card>
        <Container layout="vertical" gap="lg" padding="lg">
          <Text variant="heading-xs">Payment budget</Text>
          <Text variant="body" color="muted">
            No wallet configuration found. Click configure to set up your wallet.
          </Text>
          <Button onClick={onConfigure}>Configure Wallet</Button>
        </Container>
      </Card>
    );
  }

  const statusColor = wallet.status === 'active' ? 'success' : 'warning';
  const spendingPercentage =
    wallet.dailyLimit > 0 ? Math.round((wallet.totalSpentToday / wallet.dailyLimit) * 100) : 0;

  return (
    <Card>
      <Container layout="vertical" gap="md" padding="lg">
        {/* Header */}
        <Container layout="horizontal" gap="md" alignItems="center">
          <Text variant="heading-xs">{wallet.serviceName}</Text>
          <Badge variant={statusColor}>{wallet.status}</Badge>
          <Badge variant="secondary">{wallet.network}</Badge>
          <Badge variant="secondary">{wallet.asset}</Badge>
        </Container>

        {/* Wallet Address */}
        {wallet.walletAddress && (
          <Container layout="vertical" gap="xs">
            <Text variant="label" color="muted">
              Wallet Address
            </Text>
            <Text variant="body-xs" color="muted">
              {wallet.walletAddress}
            </Text>
          </Container>
        )}

        {/* Facilitator URL */}
        {wallet.facilitatorUrl && (
          <Container layout="vertical" gap="xs">
            <Text variant="label" color="muted">
              Facilitator
            </Text>
            <Text variant="body-xs" color="muted">
              {wallet.facilitatorUrl}
            </Text>
          </Container>
        )}

        {/* Budget Configuration */}
        <Container layout="vertical" gap="md">
          <Text variant="label">Budget Configuration</Text>

          {/* Auto-Approve Threshold */}
          <Container layout="vertical" gap="xs">
            <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between">
              <Text variant="body">Auto-Approve Threshold</Text>
              <Text variant="body-xs">${wallet.autoApproveThreshold}</Text>
            </Container>
            <Text variant="caption" color="muted">
              Transactions below this amount auto-approve without confirmation
            </Text>
          </Container>

          {/* Daily Limit */}
          <Container layout="vertical" gap="xs">
            <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between">
              <Text variant="body">Daily Limit</Text>
              <Text variant="body-xs">${wallet.dailyLimit}</Text>
            </Container>
            <Text variant="caption" color="muted">
              Maximum spend per 24 hours
            </Text>
          </Container>
        </Container>

        {/* Spending Status */}
        <Container layout="vertical" gap="md">
          <Text variant="label">Spending Status</Text>

          {/* Today */}
          <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between">
            <Text variant="body">Spent Today</Text>
            <Container layout="horizontal" gap="sm">
              <Text variant="body-xs">
                ${wallet.totalSpentToday} / ${wallet.dailyLimit}
              </Text>
              <Badge
                variant={spendingPercentage > 80 ? 'danger' : spendingPercentage > 50 ? 'warning' : 'success'}
              >
                {spendingPercentage}%
              </Badge>
            </Container>
          </Container>

          {/* All Time */}
          <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between">
            <Text variant="body">Total Spent (All Time)</Text>
            <Text variant="body-xs">${wallet.totalSpentAllTime}</Text>
          </Container>
        </Container>

        {/* Status */}
        {wallet.status === 'pending_setup' && (
          <Container layout="vertical" gap="md">
            <Text variant="caption" color="muted">
              This payment method needs setup. Finish setup before allowing payments.
            </Text>
            {onConfigure && (
              <Button onClick={onConfigure}>Complete Setup</Button>
            )}
          </Container>
        )}

        {/* Configure button (active state) */}
        {wallet.status === 'active' && onConfigure && (
          <Button variant="ghost" onClick={onConfigure}>Configure Wallet</Button>
        )}
      </Container>
    </Card>
  );
}
