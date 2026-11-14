// package-set://bitfield-studio/packages/request-intake/show/RequestShareSettings.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The "share" workspace: lists the share policies that control who can send a
// request, each with a plain-language helper, then the share actions. Policies
// and actions are DATA; a new policy or action renders by adding a descriptor
// row, never by editing this file.
//
// =============================================================================

import {
  Card,
  Container,
  EmptyPlaceholder,
  Text,
} from '@/packages/ui';
import { Share2 } from 'lucide-react';
import type { RequestIntakeScreenShare } from '@/packages/request-intake/show/request-intake-screen-model';
import {
  RequestActionBar,
  type RequestIntakeActionHandler,
} from '@/packages/request-intake/show/RequestActionBar';

interface RequestShareSettingsProps {
  share: RequestIntakeScreenShare;
  shapeId?: string;
  onAction?: RequestIntakeActionHandler;
}

export function RequestShareSettings({
  share,
  shapeId,
  onAction,
}: RequestShareSettingsProps): JSX.Element {
  return (
    <Container layout="vertical" gap="md">
      {share.policies.length === 0 ? (
        <EmptyPlaceholder icon={Share2} message={share.emptyCopy} />
      ) : (
        <Container layout="vertical" gap="sm">
          {share.policies.map((policy) => (
            <Card key={policy.id} variant="nested" padding="md" layout="stack">
              <Text variant="body" weight="medium">{policy.label}</Text>
              <Text variant="caption" color="muted">{policy.helper}</Text>
            </Card>
          ))}
        </Container>
      )}
      <RequestActionBar actions={share.actions} scope={{ shapeId }} onAction={onAction} align="end" />
    </Container>
  );
}
