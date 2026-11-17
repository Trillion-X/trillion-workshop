import React from 'react';
import { Search } from 'lucide-react';
import { Badge, Button, Container, Input, Text } from '../../ui';
import type { MailAccount, MailMessage } from '../read-data/read-mail-workspace.ts';

type MailSearchOverlayProps = {
  accountsByAddress: Record<string, MailAccount>;
  messages: MailMessage[];
  open: boolean;
  onClose(): void;
  onSelect(address: string): void;
};

export function MailSearchOverlay({ accountsByAddress, messages, open, onClose, onSelect }: MailSearchOverlayProps) {
  if (!open) return null;
  const results = messages.slice(0, 8);
  return (
    <Container layout="vertical" gap="md" padding="lg" className="absolute inset-x-6 top-6 z-20 rounded-md border border-[var(--border-primary)] bg-[var(--surface-primary)] shadow-2xl">
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Input icon={<Search className="h-4 w-4" aria-hidden="true" />} value="sender subject attachment action" readOnly aria-label="Search mail" />
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </Container>
      <Container layout="vertical" gap="xs">
        <Text variant="heading-xs">Search results</Text>
        {results.map((message) => (
          <button
            type="button"
            key={message.address}
            className="rounded-md border border-transparent px-3 py-2 text-left hover:border-[var(--border-primary)] hover:bg-[var(--glass-bg-hover)]"
            onClick={() => {
              onSelect(message.address);
              onClose();
            }}
          >
            <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
              <Container layout="vertical" gap="none" minWidth="0">
                <Text variant="body-xs" weight="medium" truncate>{message.subject}</Text>
                <Text variant="caption" color="muted" truncate>{message.sender}</Text>
              </Container>
              <Container layout="horizontal" gap="xs" alignItems="center">
                {accountsByAddress[message.accountAddress] && <Badge variant="muted-outline">{accountsByAddress[message.accountAddress].name}</Badge>}
                {message.attachmentCount > 0 && <Badge variant="neutral">Attachment</Badge>}
              </Container>
            </Container>
          </button>
        ))}
      </Container>
    </Container>
  );
}
