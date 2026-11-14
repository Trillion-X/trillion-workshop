// package-set://bitfield-studio/packages/marketing-pipeline/show/MarketingPipelineSurface.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Coordination Workbench — ONE generic surface that renders ANY
// CoordinationSurfaceModel (marketing pipeline, relationship work, booking
// holds, …). Grounded in the Mobbin coordination-app anatomy, it composes FIVE
// regions, each its own module:
//
//   1. Source inbox    (source-inbox.tsx)      — real upstream connections rail
//   2. Record collection (record-collection.tsx) — grouped, data-driven layout
//   3. Selected detail  (record-detail.tsx)     — connections, outputs, runs
//   4. Owner-action rail (record-detail.tsx)    — the actions a record exposes
//   5. Recoverable issue (issue-banner.tsx)     — calm banner with bound retry
//
// This file is the composition root: it owns selection + active-view state and
// arranges the regions as a three-pane desktop / stacked-with-detail-push
// mobile. Everything visible comes from DATA — fields, statuses, views, actions,
// copy. There is ZERO marketing vocabulary here; the words a marketer sees
// arrive as descriptor DATA + human copy.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic / Data-Driven Gate (L063/L090): a new field/status/view/action/
//    arrangement appears by adding a DATA row, never by editing a panel. No
//    closed status union, no `if (kind === …)`, no domain term in code.
// 2. Props-only styling (L065/L066): composes shared `ui` atoms — no raw HTML,
//    no className.
// 3. Refs never leak (L098): humanize.ts translates every ref/role/key into
//    human words before display.
// 4. Honest states (L117): empty/loading/error/sparse/dense all render from real
//    data or an honest placeholder — never fake rows.
//
// =============================================================================

import React from 'react';
import {
  ActionControl,
  Badge,
  Container,
  EmptyPlaceholder,
  SafeErrorCard,
  SegmentedControl,
  Spinner,
  Text,
  useNarrowViewport,
} from '@/packages/ui';
import { Inbox } from 'lucide-react';
import type {
  CoordinationActionDescriptor,
  CoordinationRecord,
  CoordinationRecoverableIssue,
  CoordinationSurfaceModel,
  CoordinationViewDescriptor,
  JsonRecord,
} from '../read-data/read-coordination-records';
import { inboxEntries } from '../read-data/coordination-metrics';
import {
  requestCoordinationAction,
  type CoordinationActionDescriptor as ActionRequestDescriptor,
  type CoordinationActionRequest,
} from '../do-work/request-coordination-action';
import { IssueBanner } from './issue-banner';
import { SourceInbox } from './source-inbox';
import { RecordCollection } from './record-collection';
import { RecordDetail } from './record-detail';

export interface MarketingPipelineSurfaceProps {
  model: CoordinationSurfaceModel;
  /** Loading skeleton toggle — true while the surface model is being read. */
  loading?: boolean;
  /** Hard error that prevented loading — rendered through the safe error card. */
  errorMessage?: string;
  /** Owner-action handler. Defaults to logging the prepared request. */
  onAction?: (request: CoordinationActionRequest) => void;
  /** Evidence-open handler. Defaults to logging the opened evidence ref. */
  onOpenEvidence?: (evidence: JsonRecord) => void;
}

// ---------------------------------------------------------------------------
// Header (generic — title + count + view switch)
// ---------------------------------------------------------------------------

function WorkbenchHeader({
  model,
  views,
  activeViewId,
  onViewChange,
}: {
  model: CoordinationSurfaceModel;
  views: CoordinationViewDescriptor[];
  activeViewId: string | undefined;
  onViewChange: (id: string) => void;
}): React.ReactElement {
  const activeView = views.find((view) => view.id === activeViewId);
  return (
    <Container as="header" layout="vertical" gap="sm">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="heading-xl">{model.surfaceCopy.title}</Text>
          {model.records.length > 0 && (
            <Badge variant="neutral" size="sm">{model.freshness.recordCount}</Badge>
          )}
        </Container>
        <Text variant="body" color="muted">
          {activeView?.label ?? model.surfaceCopy.defaultViewLabel}
        </Text>
      </Container>
      {views.length > 1 && activeViewId && (
        <SegmentedControl
          ariaLabel="Views"
          value={activeViewId}
          items={views.map((view) => ({ id: view.id, label: view.label }))}
          onValueChange={onViewChange}
        />
      )}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export function MarketingPipelineSurface({
  model,
  loading = false,
  errorMessage,
  onAction,
  onOpenEvidence,
}: MarketingPipelineSurfaceProps): React.ReactElement {
  const narrow = useNarrowViewport();
  const views = model.views;
  const [activeViewId, setActiveViewId] = React.useState<string | undefined>(views[0]?.id);
  const [selectedId, setSelectedId] = React.useState<string | undefined>(model.records[0]?.id);
  // On a narrow viewport the detail is a full-screen push over the collection.
  const [detailOpen, setDetailOpen] = React.useState(false);

  const handleAction = React.useCallback(
    (action: CoordinationActionDescriptor, record: CoordinationRecord | undefined) => {
      const request = requestCoordinationAction(
        {
          id: action.id,
          targetRef: action.targetRef,
          operation: action.operation,
          definitionRef: action.definitionRef,
          inputMap: action.inputMap as ActionRequestDescriptor['inputMap'],
          receiptRef: action.receiptRef,
        },
        { operationId: `${action.id}:${record?.id ?? 'none'}`, recordRef: record?.id },
      );
      if (onAction) onAction(request);
      else console.info('[marketing-pipeline] action request prepared', request.targetRequests.length);
    },
    [onAction],
  );

  const handleOpenEvidence = React.useCallback(
    (evidence: JsonRecord) => {
      if (onOpenEvidence) onOpenEvidence(evidence);
      else console.info('[marketing-pipeline] open evidence');
    },
    [onOpenEvidence],
  );

  const handleSelect = React.useCallback(
    (id: string) => {
      setSelectedId(id);
      setDetailOpen(true);
    },
    [],
  );

  const resolveAction = React.useCallback(
    (actionId: string): CoordinationActionDescriptor | undefined =>
      model.actions.find((action) => action.id === actionId),
    [model.actions],
  );

  const handleRetry = React.useCallback(
    (action: CoordinationActionDescriptor, issue: CoordinationRecoverableIssue) => {
      const record = issue.recordRef ? model.records.find((r) => r.id === issue.recordRef) : undefined;
      handleAction(action, record);
    },
    [handleAction, model.records],
  );

  // Hard error — nothing else can be trusted to render.
  if (errorMessage) {
    return (
      <Container as="main" layout="vertical" gap="md" padding="lg">
        <Text variant="heading-xl">{model.surfaceCopy.title}</Text>
        <SafeErrorCard message={errorMessage} />
      </Container>
    );
  }

  // Loading skeleton — honest "reading work" state, not fake rows.
  if (loading) {
    return (
      <Container as="main" layout="vertical" gap="md" padding="lg" alignItems="center">
        <Text variant="heading-xl">{model.surfaceCopy.title}</Text>
        <Spinner aria-label="Loading work" />
      </Container>
    );
  }

  // Empty — no records yet. Title + honest placeholder + the one starter action.
  if (model.records.length === 0) {
    return (
      <Container as="main" layout="vertical" gap="md" padding="lg" alignItems="center">
        <Text variant="heading-xl">{model.surfaceCopy.title}</Text>
        <EmptyPlaceholder icon={Inbox} message={model.surfaceCopy.emptyText} />
        <ActionControl variant="primary">{model.surfaceCopy.emptyActionLabel}</ActionControl>
      </Container>
    );
  }

  const activeView = views.find((view) => view.id === activeViewId) ?? views[0];
  const selectedRecord = model.records.find((record) => record.id === selectedId) ?? model.records[0];
  const entries = inboxEntries(model);

  const detail = selectedRecord ? (
    <RecordDetail
      model={model}
      record={selectedRecord}
      onActivate={(action) => handleAction(action, selectedRecord)}
      onOpenEvidence={handleOpenEvidence}
    />
  ) : null;

  // Mobile: a selected record pushes a full-screen detail with a back affordance.
  if (narrow && detailOpen && detail) {
    return (
      <Container as="main" layout="vertical" gap="md" padding="lg">
        <ActionControl variant="secondary" onClick={() => setDetailOpen(false)}>
          Back
        </ActionControl>
        {detail}
      </Container>
    );
  }

  return (
    <Container as="main" layout="vertical" gap="lg" padding="lg">
      <WorkbenchHeader
        model={model}
        views={views}
        activeViewId={activeView?.id}
        onViewChange={setActiveViewId}
      />
      <IssueBanner issues={model.recoverableIssues} resolveAction={resolveAction} onRetry={handleRetry} />
      <Container layout={narrow ? 'vertical' : 'horizontal'} gap="lg" alignItems="start">
        {!narrow && (
          <SourceInbox
            entries={entries}
            selectedRecordId={selectedRecord?.id}
            onSelectRecord={handleSelect}
          />
        )}
        <RecordCollection
          model={model}
          view={activeView}
          selectedId={selectedRecord?.id}
          onSelect={handleSelect}
        />
        {!narrow && detail}
      </Container>
    </Container>
  );
}

export default MarketingPipelineSurface;
