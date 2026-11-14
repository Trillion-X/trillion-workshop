/**
 * file: packages/content-production/show/ContentDeliverablesPanel.tsx
 *
 * PURPOSE: The Deliverables surface (plan §13A U05). One App-Store/Fey-style
 * card per production run: title, live status, every finished output with its
 * user-meaningful fields, and errors when they happened. Pure read surface —
 * runs are started from Make-content; publishing belongs to Distribution.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Zero imports from slot::workflow or slot::eeaf — reads only via useBitfieldData
 * 2. Components only from @/packages/ui; zero inline style objects
 * 3. Output kinds are DATA from each record — never enumerated here
 * 4. Observability: logs `[ui:content-deliverables] mounted input=<n> records` on mount
 */

import * as React from 'react';

import { useBitfieldData } from '@bitfield/runtime-kit/react';

import {
  Badge,
  Card,
  Container,
  OutputFieldList,
  SafeErrorCard,
  ScrollableSurface,
  Text,
  statusView,
} from '@/packages/ui';

import { friendlyDate } from '@/packages/content-production/read-data/read-content-library';
import {
  deliverableDisplayFields,
  deliverableTitle,
  readContentDeliverableRuns,
  type ContentDeliverableRun,
} from '@/packages/content-production/read-data/read-content-deliverables';

const TONE_TO_BADGE = {
  neutral: 'neutral',
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
} as const;

function DeliverableRunCard({ run }: { run: ContentDeliverableRun }) {
  // The status chip ALWAYS goes through the shared vocabulary — raw states
  // like "submitted"/"failed" never render as visible copy.
  const status = statusView(run.errors.length > 0 ? 'failed' : run.state);
  return (
    <Card variant="surface" padding="lg" layout="stack">
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Container layout="vertical" gap="xs" flex={1}>
          <Text variant="heading">{run.title}</Text>
          {run.requestedAt ? <Text variant="caption" color="faint">{friendlyDate(run.requestedAt)}</Text> : null}
        </Container>
        <Badge variant={TONE_TO_BADGE[status.tone]} size="sm">{status.label}</Badge>
      </Container>

      {run.stateMessage ? <Text variant="body-xs" color="secondary">{run.stateMessage}</Text> : null}

      {run.outputs.map((output) => (
        <Card key={output.outputId} variant="nested" padding="md" layout="stack">
          <Container layout="horizontal" gap="sm" alignItems="center">
            <Text variant="body" weight="medium" truncate>{deliverableTitle(output)}</Text>
            {output.completedAt ? <Text variant="caption" color="faint">{friendlyDate(output.completedAt)}</Text> : null}
          </Container>
          <OutputFieldList fields={deliverableDisplayFields(output)} />
        </Card>
      ))}

      {run.errors.map((error, index) => (
        <SafeErrorCard key={`${error.code}:${index}`} message={error.message || error.code} />
      ))}
    </Card>
  );
}

export function ContentDeliverablesPanel() {
  const evidenceRows = useBitfieldData('content-production:contentMediaEvidence');
  const runs = React.useMemo(() => readContentDeliverableRuns(evidenceRows), [evidenceRows]);

  React.useEffect(() => {
    console.log(`[ui:content-deliverables] mounted input=${runs.length} records`);
  }, [runs.length]);

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="lg" padding="lg" height="full">
        <Container layout="vertical" gap="xs">
          <Text variant="heading-lg">Deliverables</Text>
          <Text variant="label">Everything your runs produced, newest first.</Text>
        </Container>

        {runs.length === 0 ? (
          <Container layout="vertical" gap="xs" padding="xl" alignItems="center">
            <Text variant="body" color="secondary">No deliverables yet.</Text>
            <Text variant="label">Start a run from the Library or a Style and its outputs land here.</Text>
          </Container>
        ) : (
          <Container layout="vertical" gap="md">
            {runs.map((run) => (
              <DeliverableRunCard key={run.runId} run={run} />
            ))}
          </Container>
        )}
      </Container>
    </ScrollableSurface>
  );
}
