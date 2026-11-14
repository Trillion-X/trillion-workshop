import React from 'react';
import { Badge } from '@/packages/ui/show/badge';
import { Button } from '@/packages/ui/show/button';
import { ColorDot } from '@/packages/ui/show/color-dot';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';
import type { CalendarAccountModel } from './calendar-screen-model';

export function CalendarAccountRail({
  accounts,
  onOpenConnections,
}: {
  accounts: CalendarAccountModel[];
  onOpenConnections: () => void;
}) {
  return (
    <Container layout="vertical" gap="md" padding="md" border="right" overflow="auto" background="secondary" minWidth="0" data-calendar-account-rail="true">
      <Container layout="horizontal" alignItems="center" justifyContent="between" gap="sm">
        <Text variant="heading-xs">Calendars</Text>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Manage accounts" onClick={onOpenConnections}>...</Button>
      </Container>

      {accounts.length === 0 ? (
        <Container layout="vertical" gap="sm" padding="md" border="all" rounded="md" background="tertiary">
          <Text variant="body-xs" weight="medium">No calendars connected.</Text>
          <Text variant="caption" color="muted">Connect an account to see your events.</Text>
          <Button type="button" variant="primary" size="sm" onClick={onOpenConnections}>Connect calendar</Button>
        </Container>
      ) : accounts.map((account) => (
        <Container key={account.id} layout="vertical" gap="sm" padding="sm" rounded="md" background="tertiary">
          <Container layout="horizontal" alignItems="center" justifyContent="between" gap="sm">
            <Container layout="horizontal" alignItems="center" gap="sm" minWidth="0">
              <ColorDot color={account.color} label={account.label} size="md" />
              <Text variant="body-xs" weight="semibold" truncate>{account.label}</Text>
            </Container>
            <Badge variant={account.statusTone}>{account.statusLabel}</Badge>
          </Container>
          <Container layout="vertical" gap="xs">
            {account.calendars.map((calendar) => (
              <Container key={calendar.id} layout="horizontal" alignItems="center" justifyContent="between" gap="sm" minWidth="0">
                <Container layout="horizontal" alignItems="center" gap="sm" minWidth="0">
                  <ColorDot color={calendar.color} label={calendar.label} size="sm" />
                  <Text variant="caption" truncate>{calendar.label}</Text>
                </Container>
                <Text variant="caption" color={calendar.visible ? 'success' : 'muted'}>
                  {calendar.readOnly ? 'Read only' : calendar.visible ? 'On' : 'Off'}
                </Text>
              </Container>
            ))}
          </Container>
        </Container>
      ))}
    </Container>
  );
}
