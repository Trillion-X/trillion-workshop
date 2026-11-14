// package-set://bitfield-studio/packages/request-intake/show/RequestPreviewAndPublish.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The "preview & publish" workspace: shows the form exactly as a requester will
// see it (version label + questions), then the publish actions. Actions are DATA
// rendered through the shared RequestActionBar, so publish / unpublish / any
// future action appears by adding a descriptor row, not by editing this file.
//
// =============================================================================

import {
  Badge,
  Card,
  Container,
  EmptyPlaceholder,
  Text,
} from '@/packages/ui';
import { Eye } from 'lucide-react';
import type { RequestIntakeScreenPreview } from '@/packages/request-intake/show/request-intake-screen-model';
import { RequestQuestionList } from '@/packages/request-intake/show/RequestQuestionList';
import {
  RequestActionBar,
  type RequestIntakeActionHandler,
} from '@/packages/request-intake/show/RequestActionBar';

interface RequestPreviewAndPublishProps {
  preview: RequestIntakeScreenPreview;
  shapeId?: string;
  onAction?: RequestIntakeActionHandler;
}

export function RequestPreviewAndPublish({
  preview,
  shapeId,
  onAction,
}: RequestPreviewAndPublishProps): JSX.Element {
  if (preview.questions.length === 0) {
    return <EmptyPlaceholder icon={Eye} message={preview.emptyCopy} />;
  }

  return (
    <Container layout="vertical" gap="md">
      <Card variant="surface" padding="lg" layout="stack">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
          <Text variant="heading-lg" weight="semibold">How people will see your form</Text>
          <Badge variant="muted-outline" size="sm">{preview.versionLabel}</Badge>
        </Container>
      </Card>
      <RequestQuestionList questions={preview.questions} emptyCopy={preview.emptyCopy} />
      <RequestActionBar actions={preview.actions} scope={{ shapeId }} onAction={onAction} align="end" />
    </Container>
  );
}
