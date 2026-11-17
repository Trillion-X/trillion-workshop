import React from 'react';
import { AlertCircle, RefreshCw, Settings } from 'lucide-react';
import { Badge, Button, Container, Text } from '../../ui';
import type { MailAction, MailAccount, MailStatus } from '../read-data/read-mail-workspace.ts';

type MailStatusBannerProps = {
  accountsByAddress: Record<string, MailAccount>;
  actionsById: Record<string, MailAction>;
  statuses: MailStatus[];
  loading: boolean;
  onAction(action: MailAction, status: MailStatus): void;
};

export function MailStatusBanner({ accountsByAddress, actionsById, statuses, loading, onAction }: MailStatusBannerProps) {
  if (loading) {
    return (
      <Container layout="horizontal" gap="sm" alignItems="center" padding="sm" className="rounded-md border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)]">
        <RefreshCw className="h-4 w-4 animate-spin text-[var(--text-secondary)]" aria-hidden="true" />
        <Text variant="body-xs" color="muted">Syncing mail</Text>
      </Container>
    );
  }

  if (statuses.length === 0) return null;

  return (
    <Container layout="vertical" gap="xs">
      {statuses.map((status) => {
        const account = status.accountAddress ? accountsByAddress[status.accountAddress] : undefined;
        const actions = status.actionIds.map((id) => actionsById[id]).filter(Boolean);
        return (
          <Container key={status.address} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" padding="sm" className="rounded-md border border-status-warning/30 bg-status-warning/10">
            <Container layout="horizontal" gap="sm" alignItems="center" minWidth="0">
              <AlertCircle className="h-4 w-4 shrink-0 text-status-warning" aria-hidden="true" />
              <Container layout="vertical" gap="none" minWidth="0">
                <Text variant="body-xs" weight="medium" truncate>{status.label}</Text>
                {account && <Text variant="caption" color="muted">{account.name}</Text>}
              </Container>
            </Container>
            <Container layout="horizontal" gap="xs" alignItems="center" wrap="wrap">
              {actions.length === 0 && <Badge variant="warning">Needs attention</Badge>}
              {actions.map((action) => (
                <Button key={action.id} variant="outline" size="sm" onClick={() => onAction(action, status)} disabled={Boolean(action.disabledReason)} title={action.disabledReason}>
                  {action.label === 'Account settings' && <Settings className="h-3.5 w-3.5" aria-hidden="true" />}
                  {action.label}
                </Button>
              ))}
            </Container>
          </Container>
        );
      })}
    </Container>
  );
}
