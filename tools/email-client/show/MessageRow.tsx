import React from 'react';
import { Archive, CheckSquare, Paperclip, Reply, Trash2 } from 'lucide-react';
import { Badge, Button, Container, Text } from '@/packages/ui';
import type { MailAccount, MailAction, MailMessage } from '../read-data/read-mail-workspace.ts';

type MessageRowProps = {
  account?: MailAccount;
  actionsById: Record<string, MailAction>;
  message: MailMessage;
  selected: boolean;
  onSelect(address: string): void;
  onAction(action: MailAction, message: MailMessage): void;
};

function actionIcon(label: string) {
  if (label === 'Reply') return <Reply className="h-3.5 w-3.5" aria-hidden="true" />;
  if (label === 'Archive') return <Archive className="h-3.5 w-3.5" aria-hidden="true" />;
  if (label === 'Delete') return <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />;
  if (label === 'Make task') return <CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />;
  return null;
}

export function MessageRow({ account, actionsById, message, selected, onSelect, onAction }: MessageRowProps) {
  const actions = message.actionIds.map((id) => actionsById[id]).filter(Boolean);
  const primaryActions = actions.filter((action) => ['Reply', 'Archive', 'Make task'].includes(action.label));

  return (
    <button
      type="button"
      className={[
        'group w-full rounded-md border px-3 py-2 text-left transition-colors',
        selected
          ? 'border-accent-purple/50 bg-accent-purple/10'
          : 'border-transparent bg-[var(--surface-tertiary)] hover:border-[var(--border-primary)] hover:bg-[var(--glass-bg-hover)]',
      ].join(' ')}
      onClick={() => onSelect(message.address)}
      aria-pressed={selected}
    >
      <Container layout="vertical" gap="xs" minWidth="0">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" minWidth="0">
          <Container layout="horizontal" gap="xs" alignItems="center" minWidth="0">
            {message.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-accent-purple" aria-label="Unread" />}
            <Text variant="body-xs" weight={message.unread ? 'semibold' : 'medium'} truncate>{message.sender}</Text>
            {account && <Badge variant="muted-outline">{account.name}</Badge>}
          </Container>
          <Container layout="horizontal" gap="xs" alignItems="center">
            {message.attachmentCount > 0 && (
              <Badge variant="neutral">
                <Paperclip className="h-3 w-3" aria-hidden="true" />
                {message.attachmentCount}
              </Badge>
            )}
            {message.sentAt && <Text variant="caption" color="muted">{message.sentAt}</Text>}
          </Container>
        </Container>
        <Text variant="body" weight={message.unread ? 'semibold' : 'medium'} truncate>{message.subject}</Text>
        <Text variant="caption" color="muted" clamp={2}>{message.preview || 'No preview'}</Text>
        <Container layout="horizontal" gap="xs" alignItems="center" justifyContent="between">
          {message.sourceLink ? <Badge variant="info">Task linked</Badge> : <span />}
          <Container layout="horizontal" gap="xs" alignItems="center" className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            {primaryActions.map((action) => (
              <Button
                key={action.id}
                type="button"
                variant={action.label === 'Delete' ? 'danger' : 'ghost'}
                size="sm"
                disabled={Boolean(action.disabledReason)}
                title={action.disabledReason}
                onClick={(event) => {
                  event.stopPropagation();
                  onAction(action, message);
                }}
              >
                {actionIcon(action.label)}
                {action.label}
              </Button>
            ))}
          </Container>
        </Container>
      </Container>
    </button>
  );
}
