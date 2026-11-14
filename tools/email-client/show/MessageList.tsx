import React from 'react';
import { Mail, RefreshCw } from 'lucide-react';
import { Button, Container, EmptyPlaceholder, Text } from '@/packages/ui';
import type { MailAccount, MailAction, MailMessage } from '../read-data/read-mail-workspace.ts';
import { MessageRow } from './MessageRow.tsx';

type MessageListProps = {
  accountsByAddress: Record<string, MailAccount>;
  actionsById: Record<string, MailAction>;
  messages: MailMessage[];
  selectedAddress: string | null;
  refreshAction?: MailAction;
  refreshing: boolean;
  onSelect(address: string): void;
  onAction(action: MailAction, message: MailMessage): void;
  onRefresh(action: MailAction): void;
};

export function MessageList({
  accountsByAddress,
  actionsById,
  messages,
  selectedAddress,
  refreshAction,
  refreshing,
  onSelect,
  onAction,
  onRefresh,
}: MessageListProps) {
  return (
    <Container layout="vertical" gap="sm" overflow="hidden" className="h-full rounded-md border border-[var(--border-primary)] bg-[var(--surface-secondary)]" data-reach-role="message-list">
      <Container layout="horizontal" alignItems="center" justifyContent="between" gap="sm" padding="md" wrap="wrap" className="border-b border-[var(--border-primary)]">
        <Container layout="vertical" gap="none" minWidth="0">
          <Text variant="heading-xs">Messages</Text>
          <Text variant="caption" color="muted">{messages.length} in this view</Text>
        </Container>
        {refreshAction ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={refreshing}
            disabled={Boolean(refreshAction.disabledReason)}
            title={refreshAction.disabledReason}
            onClick={() => onRefresh(refreshAction)}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {refreshAction.label}
          </Button>
        ) : null}
      </Container>
      {messages.length === 0 ? (
        <Container layout="vertical" justifyContent="center" flex="1" data-reach-role="empty-state">
          <EmptyPlaceholder icon={Mail} message="No messages in this mailbox" />
        </Container>
      ) : (
        <Container layout="vertical" gap="xs" overflow="auto" padding="sm">
          {messages.map((message) => (
            <MessageRow
              key={message.address}
              account={accountsByAddress[message.accountAddress]}
              actionsById={actionsById}
              message={message}
              selected={selectedAddress === message.address}
              onSelect={onSelect}
              onAction={onAction}
            />
          ))}
        </Container>
      )}
    </Container>
  );
}
