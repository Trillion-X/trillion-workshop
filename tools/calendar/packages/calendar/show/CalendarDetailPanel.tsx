// packages/calendar/show/CalendarDetailPanel.tsx
//
// Selected-event detail panel. Amie does not show this as a persistent
// side column (see 2026-07-19-real-amie-week-and-day-grid-evidence.md) — it
// opens as a floating popover anchored to the clicked block, owned by
// CalendarSurface via the shared AnchoredOverlay primitive. This component
// only renders the popover BODY: color dot + title, muted time row, state
// badge + source label, a read-only NOTES region that envelope-mounts the
// shared editor when the block's `notes` relation carries a document
// address (PlaceableSurfaceHost — ZERO compile-time imports of the editor
// package; the document ref is pure lens DATA), and a generic action grid
// rendered from the block's action-template DATA. Per the AnchoredOverlay
// convention (see MetricPanel/ItemStylePicker), it does not paint its own
// background — the overlay's own opaque surface owns that. No event-source
// vocabulary; zero package-local styling (L065 — surfaces painted via
// Container props).

import React from 'react';
import { Badge } from '@/packages/ui/show/badge';
import { Button } from '@/packages/ui/show/button';
import { ColorDot } from '@/packages/ui/show/color-dot';
import { Container } from '@/packages/ui/show/container';
import { Divider } from '@/packages/ui/show/divider/Divider';
import { PlaceableSurfaceHost } from '@/packages/ui/show/placeable-surface-host';
import { Text } from '@/packages/ui/show/text';
import type { CalendarActionModel, CalendarScreenModel } from './calendar-screen-model';
import { labelForBlockState } from './calendar-screen-model';

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

/** A notes relation value is a document ADDRESS authored as lens DATA in the
 *  shape `<packageName>/<entryName>/<documentRef>` — parsed structurally, never
 *  by naming a package in code. */
function parseDocumentRef(value: string | undefined): { packageName: string; entryName: string; documentRef: string } | null {
  if (!value) return null;
  const parts = value.split('/');
  if (parts.length < 3 || parts.some((part) => !part)) return null;
  return { packageName: parts[0], entryName: parts[1], documentRef: parts.slice(2).join('/') };
}

function stateVariant(state: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (state === 'ready' || state === 'available') return 'success';
  if (state === 'waiting-to-sync' || state === 'syncing' || state === 'tentative') return 'warning';
  if (state === 'error' || state === 'conflict') return 'error';
  return 'neutral';
}

export function CalendarDetailPanel({
  model,
  onAction,
  onClose,
}: {
  model: CalendarScreenModel;
  onAction: (action: CalendarActionModel, source?: Record<string, unknown>) => void;
  /** Present only when mounted inside a dismissible popover (desktop). Absent on the mobile bottom sheet. */
  onClose?: () => void;
}) {
  const block = model.selectedBlock;
  const [editingNotes, setEditingNotes] = React.useState(false);
  React.useEffect(() => { setEditingNotes(false); }, [block?.id]);
  const notesRef = parseDocumentRef(block?.relations.notes?.[0]);

  return (
    <Container
      layout="vertical"
      gap="md"
      padding="md"
      overflow="auto"
      minWidth="0"
      style={{ width: 360 }}
      data-calendar-detail-panel="true"
    >
      <Container layout="horizontal" alignItems="center" justifyContent="between">
        <Text variant="heading-xs">Details</Text>
        {onClose ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close event details">Close</Button>
        ) : null}
      </Container>
      {!block ? (
        <Container layout="vertical" gap="sm" padding="md" border="all" rounded="md" background="tertiary">
          <Text variant="body-xs" weight="medium">Select a time block.</Text>
          <Text variant="caption" color="muted">Event, task, availability, and booking details appear here.</Text>
        </Container>
      ) : (
        <>
          <Container layout="vertical" gap="xs">
            <Container layout="horizontal" alignItems="center" gap="sm">
              <ColorDot color={block.display.color || 'var(--accent-purple)'} size="sm" />
              <Text variant="heading-lg" truncate>{block.display.title}</Text>
            </Container>
            <Text variant="caption" color="muted">
              {formatTime(block.interval.start)} - {formatTime(block.interval.end)}
              {block.interval.allDay ? ' · All day' : ''}
            </Text>
            <Container layout="horizontal" gap="sm" alignItems="center">
              <Badge variant={stateVariant(block.state.ref)}>{labelForBlockState(block.state.ref)}</Badge>
              <Text variant="caption" color="muted" truncate>{block.display.ownerLabel}</Text>
            </Container>
          </Container>

          {notesRef ? (
            <>
              <Divider />
              <Container layout="vertical" gap="sm" data-calendar-notes={editingNotes ? 'editing' : 'reading'}>
                <Container layout="horizontal" alignItems="center" justifyContent="between">
                  <Text variant="heading-xs">Notes</Text>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditingNotes((open) => !open)}>
                    {editingNotes ? 'Done' : 'Edit'}
                  </Button>
                </Container>
                <Container minHeight="0" overflow="hidden" rounded="md" border="all">
                  <PlaceableSurfaceHost
                    packageName={notesRef.packageName}
                    entryName={notesRef.entryName}
                    surfaceInput={{ document_ref: notesRef.documentRef, read_only: !editingNotes }}
                    interactive={editingNotes}
                    unavailableText="Notes can't be shown right now."
                  />
                </Container>
              </Container>
            </>
          ) : null}

          <Divider />

          <Container layout="vertical" gap="sm">
            <Text variant="heading-xs">Links</Text>
            {Object.entries(block.relations).filter(([key, values]) => key !== 'notes' && values.length > 0).length === 0 ? (
              <Text variant="caption" color="muted">No linked items.</Text>
            ) : Object.entries(block.relations).map(([key, values]) => key !== 'notes' && values.length > 0 ? (
              <Container key={key} layout="horizontal" alignItems="center" justifyContent="between" gap="sm">
                <Text variant="caption" color="muted">{key.replace(/([A-Z])/g, ' $1')}</Text>
                <Text variant="caption" color="primary" truncate>{values.length} linked</Text>
              </Container>
            ) : null)}
          </Container>

          <Divider />

          <Container layout="vertical" gap="sm">
            <Text variant="heading-xs">Actions</Text>
            <Container layout="grid" gridCols={2} gap="sm">
              {(model.actions.length > 0 ? model.actions : block.actions).map((action) => (
                <Button
                  key={action.id}
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={'disabledReason' in action && !!action.disabledReason}
                  title={('disabledReason' in action && action.disabledReason) || undefined}
                  onClick={() => onAction(action as CalendarActionModel, { block })}
                >
                  {action.label ?? 'Use action'}
                </Button>
              ))}
            </Container>
          </Container>
        </>
      )}
    </Container>
  );
}
