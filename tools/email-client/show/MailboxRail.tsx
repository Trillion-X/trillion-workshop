import React from 'react';
import { Inbox, MailPlus, Settings } from 'lucide-react';
import { Badge, Button, Container, Text } from '../../ui';
import type { MailAccount, Mailbox } from '../read-data/read-mail-workspace.ts';

type MailboxRailProps = {
  accounts: MailAccount[];
  mailboxes: Mailbox[];
  selectedMailboxAddress: string | null;
  onSelectMailbox(address: string | null): void;
  onOpenConnections(): void;
};

export function MailboxRail({
  accounts,
  mailboxes,
  selectedMailboxAddress,
  onSelectMailbox,
  onOpenConnections,
}: MailboxRailProps) {
  const mailboxCountByAccount = Object.fromEntries(
    accounts.map((account) => [
      account.address,
      mailboxes
        .filter((mailbox) => mailbox.accountAddress === account.address)
        .reduce((count, mailbox) => count + mailbox.messageAddresses.length, 0),
    ]),
  );

  return (
    <Container layout="vertical" gap="md" overflow="auto" padding="md" className="h-full rounded-md border border-[var(--border-primary)] bg-[var(--surface-secondary)]" data-reach-role="account-rail">
      <Container layout="horizontal" alignItems="center" justifyContent="between" gap="sm">
        <Text variant="heading-xs">Mailboxes</Text>
        <Button variant="ghost" size="icon" aria-label="Connect an email account" title="Connect an email account" onClick={onOpenConnections} data-reach-action="connect-account">
          <MailPlus className="h-4 w-4" aria-hidden="true" />
        </Button>
      </Container>

      {accounts.length === 0 ? (
        <Container layout="vertical" gap="sm" padding="md" className="rounded-md border border-dashed border-[var(--border-primary)]">
          <Text variant="body-xs" weight="medium">Connect an email account</Text>
          <Text variant="caption" color="muted">Read, reply, and make follow-up work from one place.</Text>
          <Button variant="primary" size="sm" onClick={onOpenConnections} data-reach-action="connect-account">Connect account</Button>
        </Container>
      ) : (
        <Container layout="vertical" gap="xs">
          <Button
            variant="ghost"
            size="nav"
            active={selectedMailboxAddress === null}
            onClick={() => onSelectMailbox(null)}
          >
            <Inbox className="h-4 w-4" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left">All inboxes</span>
            <Badge>{mailboxes.reduce((count, mailbox) => count + mailbox.messageAddresses.length, 0)}</Badge>
          </Button>
          {mailboxes.map((mailbox) => (
            <Button
              key={mailbox.address}
              variant="ghost"
              size="nav"
              active={selectedMailboxAddress === mailbox.address}
              onClick={() => onSelectMailbox(mailbox.address)}
            >
              <span className="min-w-0 flex-1 truncate text-left">{mailbox.label}</span>
              <Badge>{mailbox.messageAddresses.length}</Badge>
            </Button>
          ))}
        </Container>
      )}

      {accounts.length > 0 && (
        <Container layout="vertical" gap="xs">
          <Text variant="heading-xs">Accounts</Text>
          {accounts.map((account) => (
            <Container key={account.address} layout="horizontal" gap="sm" alignItems="center" justifyContent="between" className="rounded-md px-2 py-1.5">
              <Container layout="horizontal" gap="sm" alignItems="center" minWidth="0">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent-purple" aria-hidden="true" />
                <Container layout="vertical" gap="none" minWidth="0">
                  <Text variant="body-xs" weight="medium" truncate>{account.name}</Text>
                  {!account.canSend && <Text variant="caption" color="warning">Needs account settings</Text>}
                </Container>
              </Container>
              {!account.canSend && (
                <Button variant="ghost" size="icon-xs" aria-label={`${account.name} account settings`} title={`${account.name} account settings`} onClick={onOpenConnections}>
                  <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              )}
              {account.canSend && <Badge variant="success">Ready</Badge>}
            </Container>
          ))}
          {Object.entries(mailboxCountByAccount).some(([, count]) => count === 0) && (
            <Text variant="caption" color="muted">No messages in one connected account.</Text>
          )}
        </Container>
      )}
    </Container>
  );
}
