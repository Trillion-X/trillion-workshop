import React from 'react';
import { Archive, CheckSquare, Clock, Reply, Tag, Trash2 } from 'lucide-react';
import { Badge, Button, Container, Text } from '@/packages/ui';
import type { MailAccount, MailAction, MailDraft, MailMessage, MailWorkspace } from '../read-data/read-mail-workspace.ts';
import { MailComposer } from './MailComposer.tsx';

type ThreadReaderProps = {
  accountsByAddress: Record<string, MailAccount>;
  workspace: MailWorkspace;
  composerOpen: boolean;
  onOpenComposer(): void;
  onCloseComposer(): void;
  onAction(action: MailAction, message?: MailMessage): void;
  onDraftAction(action: MailAction, draft?: MailDraft, message?: MailMessage): void;
};

function icon(label: string) {
  if (label === 'Reply') return <Reply className="h-4 w-4" aria-hidden="true" />;
  if (label === 'Archive') return <Archive className="h-4 w-4" aria-hidden="true" />;
  if (label === 'Snooze') return <Clock className="h-4 w-4" aria-hidden="true" />;
  if (label === 'Delete') return <Trash2 className="h-4 w-4" aria-hidden="true" />;
  if (label === 'Make task') return <CheckSquare className="h-4 w-4" aria-hidden="true" />;
  if (label === 'Unsubscribe') return <Tag className="h-4 w-4" aria-hidden="true" />;
  return null;
}

function messageBody(message: MailMessage): { text: string; availability: string } {
  const text = message.body || message.preview;
  const availability = message.body
    ? ''
    : message.bodyUnavailableReason
      ?? (message.preview ? 'Full message body is not available from this connection.' : 'Message body is not available from this connection.');
  return { text, availability };
}

export function ThreadReader({ accountsByAddress, workspace, composerOpen, onOpenComposer, onCloseComposer, onAction, onDraftAction }: ThreadReaderProps) {
  const selected = workspace.selectedThread;
  const firstMessage = selected?.messages[0];
  const account = firstMessage ? accountsByAddress[firstMessage.accountAddress] : undefined;
  const draft = workspace.drafts.find((item) => item.threadAddress === selected?.thread.address) ?? workspace.drafts[0];
  const sendAction = draft?.actionIds.map((id) => workspace.actionsById[id]).find((action) => action?.label === 'Send');
  const scheduleAction = draft?.actionIds.map((id) => workspace.actionsById[id]).find((action) => action?.label === 'Schedule send');

  return (
    <Container layout="vertical" gap="md" overflow="hidden" className="h-full rounded-md border border-[var(--border-primary)] bg-[var(--surface-secondary)]">
      {!selected || !firstMessage ? (
        <Container layout="vertical" gap="sm" justifyContent="center" alignItems="center" flex="1" padding="lg">
          <Text variant="heading-xs">Select a message</Text>
          <Text variant="body-xs" color="muted" align="center">Open a thread to reply, schedule, archive, or make a task.</Text>
        </Container>
      ) : (
        <>
          <Container layout="vertical" gap="sm" padding="md" className="border-b border-[var(--border-primary)]">
            <Container layout="horizontal" alignItems="start" justifyContent="between" gap="sm">
              <Container layout="vertical" gap="xs" minWidth="0">
                <Container layout="horizontal" gap="xs" alignItems="center" wrap="wrap">
                  {account && <Badge variant="muted-outline">{account.name}</Badge>}
                  {selected.sourceLink && <Badge variant="info">Task linked</Badge>}
                </Container>
                <Text variant="heading-lg" truncate>{firstMessage.subject}</Text>
                <Text variant="body-xs" color="muted">From {firstMessage.sender}</Text>
              </Container>
              <Button variant="primary" size="sm" onClick={onOpenComposer} disabled={Boolean(account && !account.canSend)}>
                <Reply className="h-4 w-4" aria-hidden="true" />
                Reply
              </Button>
            </Container>
            <Container layout="horizontal" gap="xs" alignItems="center" wrap="wrap">
              {selected.actions.map((action) => (
                <Button
                  key={action.id}
                  variant={action.label === 'Delete' ? 'danger' : 'ghost'}
                  size="sm"
                  disabled={Boolean(action.disabledReason)}
                  title={action.disabledReason}
                  onClick={() => onAction(action, firstMessage)}
                >
                  {icon(action.label)}
                  {action.label}
                </Button>
              ))}
            </Container>
          </Container>

          <Container layout="vertical" gap="md" overflow="auto" padding="md" flex="1">
            {selected.messages.map((message) => (
              <Container key={message.address} layout="vertical" gap="xs" padding="md" className="rounded-md border border-[var(--border-primary)] bg-[var(--surface-tertiary)]">
                <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
                  <Text variant="body-xs" weight="semibold">{message.sender}</Text>
                  {message.sentAt && <Text variant="caption" color="muted">{message.sentAt}</Text>}
                </Container>
                {(() => {
                  const body = messageBody(message);
                  return (
                    <>
                      {body.text ? <Text variant="body-xs" color="muted" wrap="preserve">{body.text}</Text> : null}
                      {body.availability ? <Text variant="caption" color="warning">{body.availability}</Text> : null}
                    </>
                  );
                })()}
                {message.attachmentCount > 0 && <Badge variant="neutral">{message.attachmentCount} attachments</Badge>}
              </Container>
            ))}
            {composerOpen && (
              <MailComposer
                account={account}
                draft={draft}
                message={firstMessage}
                sendAction={sendAction}
                scheduleAction={scheduleAction}
                onSend={onDraftAction}
                onSchedule={onDraftAction}
                onClose={onCloseComposer}
              />
            )}
          </Container>
        </>
      )}
    </Container>
  );
}
