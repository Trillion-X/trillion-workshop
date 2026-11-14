// package-set://bitfield-studio/packages/customer-support/show/CustomerSupportSurface.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// SupportWorkbenchView — ONE generic surface that renders ANY record-work
// workspace (customer support, relationship work, booking holds, …). Grounded
// in the Mobbin support-workbench anatomy, it composes the regions, each its own
// module:
//
//   1. Source rail     (source-inbox.tsx)     — real upstream connections
//   2. Record list     (record-collection.tsx) — the scannable work collection
//   3. Selected detail (record-detail.tsx)     — state, fields, actions, activity
//   4. Issue banner    (issue-banner.tsx)       — calm, DATA-driven recoverable issues
//
// This file is the composition root: it owns selection + active-view state and
// arranges the regions as a three-pane desktop / detail-push mobile. Everything
// visible comes from DATA — fields, statuses, views, actions, copy. There is
// ZERO support vocabulary here; the words a support agent sees arrive as
// descriptor DATA + human copy. Actions never dispatch here — the user's intent
// leaves through `onAction(action, record, answers)` for the entry to invoke,
// keeping this renderer blind and iOS-JSCore-safe (no browser globals, no
// transport).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic / Data-Driven Gate (L063/L090): a new field/status/view/action/copy
//    appears by adding a DATA row, never by editing a panel. No closed status
//    union, no `if (kind === …)`, no domain term in code.
// 2. Props-only styling (L065/L066): composes shared `ui` atoms — no raw HTML,
//    no className.
// 3. Refs never leak (L098): humanize.ts translates every ref/role/key into human
//    words before display; copy keys resolve through DATA.
// 4. Honest states (L117): empty/loading/error/sparse/dense all render from real
//    data or an honest placeholder — never fake rows, never a dead button.
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
import type { WorkDescriptor } from '../read-data/record-work-graph';
import type { CustomerSupportWorkspace } from '../read-data/read-customer-support-workspace';
import type { SupportRecord } from './workspace-types';
import { answerKeysForAction, type ActionAnswers } from './action-composer';
import { IssueBanner } from './issue-banner';
import { RecordCollection } from './record-collection';
import { RecordDetail } from './record-detail';
import { SourceInbox } from './source-inbox';

/** The user's intent leaving the surface: which action, on which record, with what answers. */
export type SupportActionHandler = (
  action: WorkDescriptor,
  record: SupportRecord | undefined,
  answers: ActionAnswers,
) => void;

export interface CustomerSupportSurfaceProps {
  workspace: CustomerSupportWorkspace;
  /** Layout hint; the surface still adapts to a narrow viewport on its own. */
  layout?: 'desktop' | 'mobile';
  /** Loading skeleton toggle — true while the workspace is being read. */
  loading?: boolean;
  /** Hard error that prevented loading — rendered through the safe error card. */
  errorMessage?: string;
  /** Owner-action handler. Defaults to logging the action id. */
  onAction?: SupportActionHandler;
}

// ---------------------------------------------------------------------------
// Copy resolution (generic — every label comes from the copy DATA map)
// ---------------------------------------------------------------------------

/** Resolve the surface chrome copy from DATA, with calm generic fallbacks. */
function surfaceCopy(workspace: CustomerSupportWorkspace, activeView: WorkDescriptor | undefined) {
  const copy = workspace.copy;
  return {
    title: copy['title'] || activeView?.label || 'Workspace',
    defaultViewLabel: activeView?.label || copy['view.default'] || 'All',
    emptyText: copy['empty'] || 'Nothing here yet.',
    emptyActionLabel: copy['empty.action'] || '',
  };
}

// ---------------------------------------------------------------------------
// Header (generic — title + count + view switch)
// ---------------------------------------------------------------------------

function WorkbenchHeader({
  title,
  defaultViewLabel,
  recordCount,
  views,
  activeViewId,
  onViewChange,
}: {
  title: string;
  defaultViewLabel: string;
  recordCount: number;
  views: WorkDescriptor[];
  activeViewId: string | undefined;
  onViewChange: (id: string) => void;
}): React.ReactElement {
  return (
    <Container as="header" layout="vertical" gap="sm">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="heading-xl">{title}</Text>
          {recordCount > 0 && <Badge variant="neutral" size="sm">{recordCount}</Badge>}
        </Container>
        <Text variant="body" color="muted">{defaultViewLabel}</Text>
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

export function CustomerSupportSurface({
  workspace,
  loading = false,
  errorMessage,
  onAction,
}: CustomerSupportSurfaceProps): React.ReactElement {
  const narrow = useNarrowViewport();
  const views = workspace.views;
  const records = workspace.records;
  const [activeViewId, setActiveViewId] = React.useState<string | undefined>(views[0]?.id);
  const [selectedId, setSelectedId] = React.useState<string | undefined>(records[0]?.id);
  // On a narrow viewport the detail is a full-screen push over the collection.
  const [detailOpen, setDetailOpen] = React.useState(false);

  const activeView = views.find((view) => view.id === activeViewId) ?? views[0];
  const copy = surfaceCopy(workspace, activeView);

  const handleAction = React.useCallback<SupportActionHandler>(
    (action, record, answers) => {
      if (onAction) onAction(action, record, answers);
      else console.info(`[customer-support] action prepared ${action.id}`);
    },
    [onAction],
  );

  const handleSelect = React.useCallback((id: string) => {
    setSelectedId(id);
    setDetailOpen(true);
  }, []);

  // The one starter action for an empty workspace: a real, wired, input-free
  // action — rendered as a button only when one exists, never a dead label.
  const starterAction = React.useMemo(
    () => workspace.actions.find((action) => action.target && answerKeysForAction(action).length === 0),
    [workspace.actions],
  );

  // Hard error — nothing else can be trusted to render.
  if (errorMessage) {
    return (
      <Container as="main" layout="vertical" gap="md" padding="lg">
        <Text variant="heading-xl">{copy.title}</Text>
        <SafeErrorCard message={errorMessage} />
      </Container>
    );
  }

  // Loading skeleton — honest "reading work" state, not fake rows.
  if (loading) {
    return (
      <Container as="main" layout="vertical" gap="md" padding="lg" alignItems="center">
        <Text variant="heading-xl">{copy.title}</Text>
        <Spinner aria-label="Loading work" />
      </Container>
    );
  }

  // Empty — no records yet. Title + honest placeholder + the one starter action.
  if (records.length === 0) {
    return (
      <Container as="main" layout="vertical" gap="md" padding="lg" alignItems="center">
        <Text variant="heading-xl">{copy.title}</Text>
        <EmptyPlaceholder icon={Inbox} message={copy.emptyText} />
        {starterAction && (
          <ActionControl variant="primary" onClick={() => handleAction(starterAction, undefined, {})}>
            {copy.emptyActionLabel || starterAction.label}
          </ActionControl>
        )}
      </Container>
    );
  }

  const selectedRecord = records.find((record) => record.id === selectedId) ?? records[0];

  const detail = selectedRecord ? (
    <RecordDetail
      record={selectedRecord}
      view={activeView}
      onAction={(action, answers) => handleAction(action, selectedRecord, answers)}
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
        title={copy.title}
        defaultViewLabel={copy.defaultViewLabel}
        recordCount={records.length}
        views={views}
        activeViewId={activeView?.id}
        onViewChange={setActiveViewId}
      />
      <IssueBanner issues={workspace.issues} copy={workspace.copy} />
      <Container layout={narrow ? 'vertical' : 'horizontal'} gap="lg" alignItems="start">
        {!narrow && (
          <SourceInbox
            records={records}
            selectedRecordId={selectedRecord?.id}
            onSelectRecord={handleSelect}
          />
        )}
        <RecordCollection
          records={records}
          view={activeView}
          selectedId={selectedRecord?.id}
          onSelect={handleSelect}
        />
        {!narrow && detail}
      </Container>
    </Container>
  );
}

export default CustomerSupportSurface;
