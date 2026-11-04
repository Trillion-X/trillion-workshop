import * as React from 'react';
import { Button, Container, NamedIcon, Text } from '../../ui';
import type {
  CapabilityPermissionDescriptor,
  CapabilityPermissionState,
} from '../read-data/capability-permission';
import {
  capabilityPermissionRecoveryAvailable,
  deniedNoticeHere,
  recoverCapabilityPermission,
} from '../read-data/capability-permission';

export function CapabilityPermissionPrompt({
  descriptor,
  state,
  requesting,
  onRequest,
}: {
  descriptor: CapabilityPermissionDescriptor;
  state: Exclude<CapabilityPermissionState, 'granted'>;
  requesting: boolean;
  onRequest: () => void;
}) {
  const [recovering, setRecovering] = React.useState(false);
  const unavailable = state === 'platform-unavailable';
  const denied = state === 'denied-by-system';
  const deniedHere = deniedNoticeHere(descriptor);
  const content = unavailable ? descriptor.unavailable : denied ? deniedHere : descriptor.consent;
  const recoveryAvailable = denied && capabilityPermissionRecoveryAvailable();
  const handleRecover = React.useCallback(() => {
    if (recovering) return;
    setRecovering(true);
    recoverCapabilityPermission(descriptor)
      .then((outcome) => {
        if (outcome.recovered) {
          onRequest();
          return undefined;
        }
        // The native sheet was dismissed without allowing: stay on the card so
        // the next click retries from the top; no settings walk is offered
        // while the bridge can raise the sheet itself.
        return undefined;
      })
      .catch(() => undefined)
      .finally(() => setRecovering(false));
  }, [descriptor, onRequest, recovering]);
  const actionLabel = recoveryAvailable
    ? `Fix ${descriptor.denied.recovery_subject || 'this'} access`
    : descriptor.consent.action_label;
  return (
    <Container
      layout="vertical"
      gap="md"
      className="rounded-[24px] border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] px-6 py-8"
    >
      <Container layout="horizontal" gap="md" alignItems="center">
        <NamedIcon name={unavailable ? 'TriangleAlert' : denied ? 'Settings' : 'Lock'} size="sm" />
        <Text variant="heading">{content.title}</Text>
      </Container>
      <Text variant="body" color="secondary">{content.explanation}</Text>
      {denied && deniedHere.recovery_path && !recoveryAvailable ? (
        <Text variant="body" color="warning">{deniedHere.recovery_path}</Text>
      ) : null}
      {denied && recoveryAvailable ? (
        <Text variant="body" color="secondary">Click the button, then allow {descriptor.denied.recovery_subject || 'it'} in the macOS window that appears.</Text>
      ) : null}
      {!unavailable ? (
        <div>
          <Button
            variant="primary"
            loading={requesting || recovering}
            disabled={requesting || recovering}
            onClick={recoveryAvailable ? handleRecover : onRequest}
          >
            {actionLabel}
          </Button>
        </div>
      ) : null}
    </Container>
  );
}
