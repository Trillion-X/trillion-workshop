// packages/choose-per-observer/show/ObserverProfileSurface.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The observer profile (customer-360) — a record-detail built from shared
// primitives, not a bespoke screen. Three panes:
//   - left   : the visitor's attributes (emergent from their own DATA facts)
//   - center : the activity timeline (the append-only fact stream as a
//              visual-database kind:'timeline' model, grouped by day)
//   - right  : rollup totals (RecordMetricRow over DATA rollup descriptors) +
//              "why they saw this" (the decision transcript translated to plain
//              rows)
//
// THE GENERIC TEST (must stay YES): a new rollup or a new activity-kind tone
// appears by adding a DATA row in data/profile-descriptors.ts — ZERO change
// here. Attributes are emergent: one, a few, or a thousand render the same way
// (the one-or-list law). No attribute list, no rollup array, no activity-kind
// switch in this file. No fake data: an empty stream yields empty panes (L117).
//
// Render states: loading (skeleton), error, empty (no activity), dense (long
// timeline), mobile (3 panes -> tabs via useNarrowViewport), desktop (3-pane).
//
// fey-grade via @/packages/ui + @/packages/visual-database only. Zero raw HTML,
// zero inline styles, zero className hacking (L065/L066).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Activity, User, Sparkles, HelpCircle } from 'lucide-react';
import {
  Card,
  Container,
  Divider,
  EmptyPlaceholder,
  Icon,
  StatusDot,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Text,
  WorkSkeletonRows,
  useNarrowViewport,
} from '@/packages/ui';
import {
  decodeVisualDatabaseModel,
  recordsForView,
  type VisualDatabaseModel,
} from '@/packages/visual-database/read-data/visual-database';
import { displayTitle, statusTone } from '@/packages/visual-database/show/field-editors';
import { timelineDayGroups } from '@/packages/visual-database/show/timeline-grouping';
import { RecordMetricRow } from '@/packages/visual-database/show/RecordMetricRow';
import {
  PROFILE_ACTIVITY_STATUS_FIELD_ID,
  PROFILE_COPY,
  type ProfileCopy,
} from '@/packages/choose-per-observer/data/profile-descriptors';
import { formatMetric } from '@/packages/choose-per-observer/show/metric-format';
import type { ObserverProfileViewModel } from '@/packages/choose-per-observer/show/observer-profile-view-model';

export interface ObserverProfileSurfaceProps {
  /** The decoded view-model (read-data owns I/O; this surface is blind). */
  viewModel: ObserverProfileViewModel;
  loading?: boolean;
  error?: boolean;
  /** Copy override (DATA). Defaults to the ethos first-use copy. */
  copy?: ProfileCopy;
}

// ---------------------------------------------------------------------------
// Left pane — attributes, emergent from the visitor's own facts.
// ---------------------------------------------------------------------------

function AttributesPane({ viewModel, copy }: { viewModel: ObserverProfileViewModel; copy: ProfileCopy }) {
  return (
    <Card variant="surface" padding="lg" layout="column">
      <Container layout="vertical" gap="md" padding="none">
        <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
          <Icon icon={User} size="sm" color="muted" />
          <Text variant="heading-lg">{viewModel.displayName}</Text>
        </Container>
        <Divider />
        <Text variant="overline" color="faint">{copy.identityHeading}</Text>
        {viewModel.attributes.length > 0 ? (
          <Container layout="vertical" gap="sm" padding="none">
            {viewModel.attributes.map((attribute) => (
              <Container
                key={attribute.id}
                layout="horizontal"
                gap="sm"
                alignItems="center"
                justifyContent="between"
                padding="none"
              >
                <Text variant="body-xs" color="faint">{attribute.label}</Text>
                <Text variant="body-xs" weight="medium" truncate>{attribute.value}</Text>
              </Container>
            ))}
          </Container>
        ) : (
          <Text variant="body-xs" color="faint">{copy.emptyTimeline}</Text>
        )}
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Center pane — the activity timeline, grouped by day.
// ---------------------------------------------------------------------------

function TimelinePane({ model, copy }: { model: VisualDatabaseModel; copy: ProfileCopy }) {
  const view = model.views[0];
  const records = view ? recordsForView(view, model.records, model.fields) : model.records;
  const dateDescriptor = model.fields.find((field) => field.role === 'date') ?? null;
  const groups = timelineDayGroups(records, dateDescriptor);

  return (
    <Card variant="surface" padding="lg" layout="column">
      <Container layout="vertical" gap="md" padding="none">
        <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
          <Icon icon={Activity} size="sm" color="muted" />
          <Text variant="heading-lg">{copy.activityHeading}</Text>
        </Container>
        {records.length === 0 ? (
          <EmptyPlaceholder icon={Activity} message={copy.emptyTimeline} />
        ) : (
          <Container layout="vertical" gap="md" padding="none">
            {groups.map((group) => (
              <Container key={group.day ?? 'undated'} layout="vertical" gap="sm" padding="none">
                {group.day && <Text variant="overline" color="faint">{group.day}</Text>}
                {group.records.map((record) => {
                  const status = statusTone(record, model, PROFILE_ACTIVITY_STATUS_FIELD_ID);
                  return (
                    <Container key={record.id} layout="horizontal" gap="sm" alignItems="center" padding="none">
                      {status && <StatusDot status={status.status} color={status.color} size="sm" pulse={status.active} />}
                      <Text variant="body-xs" weight="medium" truncate>{displayTitle(record)}</Text>
                      {record.body && <Text variant="body-xs" color="faint" truncate>{record.body}</Text>}
                    </Container>
                  );
                })}
              </Container>
            ))}
          </Container>
        )}
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Right pane — rollup totals + "why they saw this".
// ---------------------------------------------------------------------------

function RollupsPane({ viewModel, copy }: { viewModel: ObserverProfileViewModel; copy: ProfileCopy }) {
  const rollupModel = React.useMemo(
    () => decodeVisualDatabaseModel(viewModel.rollupInput),
    [viewModel.rollupInput],
  );
  const rollupRecord = rollupModel.records[0] ?? null;
  const rollupDescriptors = rollupModel.fields.filter((field) => field.role === 'metric');

  return (
    <Container layout="vertical" gap="lg" padding="none">
      <Card variant="surface" padding="lg" layout="column">
        <Container layout="vertical" gap="md" padding="none">
          <Text variant="overline" color="faint">{copy.rollupHeading}</Text>
          {rollupRecord && rollupDescriptors.length > 0 ? (
            <RecordMetricRow
              record={rollupRecord}
              descriptors={rollupDescriptors}
              formatValue={(value, descriptor) => formatMetric(value, descriptor, { currencySymbol: copy.currencySymbol })}
            />
          ) : (
            <Text variant="body-xs" color="faint">{copy.emptyTimeline}</Text>
          )}
        </Container>
      </Card>

      <Card variant="surface" padding="lg" layout="column">
        <Container layout="vertical" gap="md" padding="none">
          <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
            <Icon icon={Sparkles} size="sm" color="muted" />
            <Text variant="overline" color="faint">{copy.whyHeading}</Text>
          </Container>
          {viewModel.why.length > 0 ? (
            <Container layout="vertical" gap="sm" padding="none">
              {viewModel.why.map((row) => (
                <Container key={row.id} layout="vertical" gap="none" padding="none">
                  <Text variant="body-xs" weight="medium">{`Saw ${row.version} on ${row.where}`}</Text>
                  {row.reason && <Text variant="body-xs" color="faint">{row.reason}</Text>}
                </Container>
              ))}
            </Container>
          ) : (
            <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
              <Icon icon={HelpCircle} size="xs" color="faint" />
              <Text variant="body-xs" color="faint">{copy.noDecision}</Text>
            </Container>
          )}
        </Container>
      </Card>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export function ObserverProfileSurface({ viewModel, loading, error, copy = PROFILE_COPY }: ObserverProfileSurfaceProps) {
  const timelineModel = React.useMemo(
    () => decodeVisualDatabaseModel(viewModel.timelineInput),
    [viewModel.timelineInput],
  );
  const narrow = useNarrowViewport();
  const [tab, setTab] = React.useState<string>('about');

  if (loading) {
    return (
      <Container layout="vertical" gap="lg" data-testid="observer-profile-surface">
        <Card variant="surface" padding="lg"><WorkSkeletonRows rows={3} /></Card>
        <Card variant="surface" padding="lg"><WorkSkeletonRows rows={5} /></Card>
      </Container>
    );
  }

  if (error) {
    return (
      <Container layout="vertical" gap="lg" data-testid="observer-profile-surface">
        <Card variant="surface" padding="lg">
          <EmptyPlaceholder icon={User} message={copy.errorMessage} />
        </Card>
      </Container>
    );
  }

  // Mobile: panes collapse to tabs.
  if (narrow) {
    return (
      <Container layout="vertical" gap="md" data-testid="observer-profile-surface">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="about">{copy.tabAbout}</TabsTrigger>
            <TabsTrigger value="activity">{copy.tabActivity}</TabsTrigger>
            <TabsTrigger value="totals">{copy.tabTotals}</TabsTrigger>
          </TabsList>
          <TabsContent value="about"><AttributesPane viewModel={viewModel} copy={copy} /></TabsContent>
          <TabsContent value="activity"><TimelinePane model={timelineModel} copy={copy} /></TabsContent>
          <TabsContent value="totals"><RollupsPane viewModel={viewModel} copy={copy} /></TabsContent>
        </Tabs>
      </Container>
    );
  }

  // Desktop: 3-pane split.
  return (
    <Container layout="horizontal" gap="lg" alignItems="start" data-testid="observer-profile-surface">
      <Container layout="vertical" padding="none" flex="1" minWidth="0">
        <AttributesPane viewModel={viewModel} copy={copy} />
      </Container>
      <Container layout="vertical" padding="none" flex="1" minWidth="0">
        <TimelinePane model={timelineModel} copy={copy} />
      </Container>
      <Container layout="vertical" padding="none" flex="1" minWidth="0">
        <RollupsPane viewModel={viewModel} copy={copy} />
      </Container>
    </Container>
  );
}
