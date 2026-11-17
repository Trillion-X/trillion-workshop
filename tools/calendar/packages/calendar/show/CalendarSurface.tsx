import React from 'react';
import { AnchoredOverlay } from '../../../../ui';
import { cssEscape } from '../../../../ui/show/anchor-resolver/anchor-resolver';
import { Button } from '../../../../ui/show/button';
import { Container } from '../../../../ui/show/container';
import { emitPlaceableSurfaceIntent } from '../../../../ui/show/placeable-surface-intent';
import { Spinner } from '../../../../ui/show/spinner';
import { Text } from '../../../../ui/show/text';
import { runCalendarOwnerAction } from '../do-work/run-calendar-owner-action';
import { CalendarAccountRail } from './CalendarAccountRail';
import { CalendarAgenda } from './CalendarAgenda';
import { CalendarConflictPanel } from './CalendarConflictPanel';
import { CalendarDetailPanel } from './CalendarDetailPanel';
import { CalendarTopBar } from './CalendarTopBar';
import { renderCalendarView } from './calendar-view-registry';
import { createCalendarScreenModel, type CalendarActionModel, type CalendarScreenModel } from './calendar-screen-model';

function openConnectionsSurface(): void {
  emitPlaceableSurfaceIntent({
    version: 1,
    id: 'service-connections.settings',
    title: 'Outside accounts and keys',
    materialTarget: 'component:service-connections',
    icon: 'KeyRound',
    packageEntry: {
      packageName: 'service-connections',
      entryName: 'service-connections',
    },
  });
}

function IssueStrip({
  model,
  onAction,
}: {
  model: CalendarScreenModel;
  onAction: (action: CalendarActionModel, source?: Record<string, unknown>) => void;
}) {
  if (model.state === 'loading') {
    return (
      <Container layout="horizontal" gap="sm" alignItems="center" padding="sm" rounded="md" background="secondary">
        <Spinner size="sm" />
        <Text variant="body-xs" color="muted">Loading calendars</Text>
      </Container>
    );
  }

  if (model.issues.length === 0) return null;

  return (
    <Container layout="vertical" gap="sm">
      {model.issues.map((issue) => (
        <Container key={issue.id} layout="horizontal" alignItems="center" justifyContent="between" gap="sm" padding="sm" border="all" rounded="md" background="secondary">
          <Container layout="vertical" gap="xs" minWidth="0">
            <Text variant="body-xs" weight="semibold" color={issue.tone === 'error' ? 'error' : issue.tone === 'warning' ? 'warning' : 'primary'}>
              {issue.label}
            </Text>
            {issue.detail ? <Text variant="caption" color="muted" truncate>{issue.detail}</Text> : null}
          </Container>
          {issue.action ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => issue.action && onAction(issue.action)}>
              {issue.action.label}
            </Button>
          ) : null}
        </Container>
      ))}
    </Container>
  );
}

// Amie's week/day grid does not carry a persistent details column — clicking
// a block opens a floating popover anchored to that block, leaving the grid
// full-width (see 2026-07-19-real-amie-week-and-day-grid-evidence.md). The
// grid views (HourGrid via CalendarTimeGrid, CalendarMonthView, CalendarAgenda)
// each own their block DOM nodes internally and already stamp a stable
// selector attribute on the clickable element for exactly this purpose —
// reusing it here needs zero changes to any of those domain-blind views.
const BLOCK_ANCHOR_SELECTORS = [
  '[data-hour-grid-item="ID"]',
  '[data-calendar-month-block="ID"]',
  '[data-calendar-agenda-block="ID"]',
] as const;

function findBlockAnchorElement(blockId: string): HTMLElement | null {
  for (const template of BLOCK_ANCHOR_SELECTORS) {
    const selector = template.replace('ID', cssEscape(blockId));
    const element = document.querySelector<HTMLElement>(selector);
    if (element) return element;
  }
  return null;
}

// The grid body is dispatched entirely through the geometry registry keyed by
// the active descriptor's `layout` — no `if (view === …)` lives here anymore.
// Adding a view (a DATA descriptor row) changes what renders with zero edit to
// this file. `agenda-list` gets a bordered frame on desktop to match the other
// bordered geometries; the registry renderer itself stays chrome-agnostic.
function CalendarViewBody({
  model,
  onAction,
  onSelectBlock,
}: {
  model: CalendarScreenModel;
  onAction: (action: CalendarActionModel, source?: Record<string, unknown>) => void;
  onSelectBlock(blockId: string): void;
}) {
  const body = renderCalendarView({ model, descriptor: model.activeView, onAction, onSelectBlock });
  if (model.activeView.layout === 'agenda-list') {
    return (
      <Container minHeight="0" overflow="hidden" rounded="md" border="all" data-calendar-desktop-agenda="true">
        {body}
      </Container>
    );
  }
  return <>{body}</>;
}

export function CalendarSurface({
  initialModel,
}: {
  initialModel: CalendarScreenModel;
}) {
  const [viewId, setViewId] = React.useState<string>(initialModel.viewId);
  const [selectedBlockId, setSelectedBlockId] = React.useState<string | null>(initialModel.selectedBlockId);
  const [actionMessage, setActionMessage] = React.useState<string | null>(null);
  const detailAnchorRef = React.useRef<HTMLElement | null>(null);
  // Bumped every time detailAnchorRef.current is (re)resolved, so it can sit
  // inside AnchoredOverlay's measureKey — a ref mutation alone doesn't
  // trigger a re-render, so without this the overlay would never re-measure
  // after an async anchor resolution (see the mount effect below).
  const [anchorVersion, setAnchorVersion] = React.useState(0);
  const resolveDetailAnchor = React.useCallback((blockId: string | null) => {
    detailAnchorRef.current = blockId ? findBlockAnchorElement(blockId) : null;
    setAnchorVersion((version) => version + 1);
  }, []);
  React.useEffect(() => {
    setViewId(initialModel.viewId);
    setSelectedBlockId(initialModel.selectedBlockId);
  }, [initialModel]);
  const model = React.useMemo(() => createCalendarScreenModel({
    ...initialModel,
    viewId,
    selectedBlockId: selectedBlockId ?? initialModel.selectedBlockId,
  }), [initialModel, selectedBlockId, viewId]);
  const isMobile = model.renderMode === 'mobile';
  const closeDetail = React.useCallback(() => setSelectedBlockId(null), []);
  const handleSelectBlock = React.useCallback((blockId: string) => {
    resolveDetailAnchor(blockId);
    setSelectedBlockId(blockId);
  }, [resolveDetailAnchor]);
  // A block can arrive pre-selected (initialModel.selectedBlockId) with no
  // click ever firing, so detailAnchorRef would otherwise stay unresolved —
  // resolve it once the grid has painted the corresponding DOM node.
  React.useEffect(() => {
    if (model.selectedBlockId && !detailAnchorRef.current) {
      resolveDetailAnchor(model.selectedBlockId);
    }
  }, [model.selectedBlockId, resolveDetailAnchor]);
  const handleAction = React.useCallback(async (action: CalendarActionModel, source: Record<string, unknown> = {}) => {
    setActionMessage(null);
    const result = await runCalendarOwnerAction(action, {
      calendar: model,
      ...source,
    });
    setActionMessage(result.message);
  }, [model]);
  const actionNotice = actionMessage ? (
    <Container layout="horizontal" gap="sm" alignItems="center" padding="sm" rounded="md" background="secondary">
      <Text variant="caption" color="muted">{actionMessage}</Text>
    </Container>
  ) : null;

  if (isMobile) {
    return (
      <Container data-calendar-surface={model.state} layout="vertical" height="full" minHeight="0" overflow="hidden" background="primary">
        <Container padding="md" border="bottom" background="primary">
          <CalendarTopBar model={model} onViewChange={setViewId} onAction={handleAction} />
        </Container>
        <IssueStrip model={model} onAction={handleAction} />
        {actionNotice}
        <CalendarAgenda model={model} onAction={handleAction} onSelectBlock={setSelectedBlockId} />
        <Container maxHeight="46%" border="top" background="secondary">
          <CalendarDetailPanel model={model} onAction={handleAction} />
        </Container>
      </Container>
    );
  }

  return (
    <Container data-calendar-surface={model.state} layout="vertical" height="full" minHeight="0" overflow="hidden" background="primary" data-calendar-surface-root="true">
      <Container padding="md" border="bottom" background="primary">
        <CalendarTopBar model={model} onViewChange={setViewId} onAction={handleAction} />
      </Container>

      <Container
        layout="grid"
        flex="1"
        minHeight="0"
        overflow="hidden"
        style={{ gridTemplateColumns: '240px minmax(0, 1fr)' }}
      >
        <CalendarAccountRail accounts={model.accounts} onOpenConnections={openConnectionsSurface} />

        <Container layout="vertical" gap="md" padding="md" minHeight="0" overflow="hidden" data-reach-role="time-blocks">
          <IssueStrip model={model} onAction={handleAction} />
          {actionNotice}
          <CalendarConflictPanel model={model} />
          <Container flex="1" minHeight="0" overflow="hidden" data-reach-role="calendar-view" data-reach-action="view-event">
            <CalendarViewBody model={model} onAction={handleAction} onSelectBlock={handleSelectBlock} />
          </Container>
        </Container>
      </Container>

      {/* Amie-style click-to-open popover, not a persistent side panel — see
          the BLOCK_ANCHOR_SELECTORS comment above for how the anchor element
          is found without HourGrid/CalendarMonthView/CalendarAgenda knowing
          this popover exists. measureKey folds in anchorVersion (not just
          selectedBlockId): switching selection from block A to block B while
          the popover is already open changes neither `open` nor object
          identity of anchorRef, and a pre-selected block resolved
          asynchronously via the mount effect above changes detailAnchorRef.current
          without any state change of its own — anchorVersion is the state
          bump that guarantees AnchoredOverlay re-measures in both cases
          instead of staying anchored to a stale or null position. */}
      <AnchoredOverlay
        anchorRef={detailAnchorRef}
        open={!!model.selectedBlock}
        placement="below"
        gap={8}
        measureKey={`${model.selectedBlockId ?? ''}:${anchorVersion}`}
        onDismiss={closeDetail}
      >
        <CalendarDetailPanel model={model} onAction={handleAction} onClose={closeDetail} />
      </AnchoredOverlay>
    </Container>
  );
}
