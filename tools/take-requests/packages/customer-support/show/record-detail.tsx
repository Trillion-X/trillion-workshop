// package-set://bitfield-studio/packages/customer-support/show/record-detail.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// WorkItemDetailView — the selected record's detail region. It shows the
// record's state, fields, the actions it can run (each with a DATA-driven
// composer), its connections, and the owner-attached activity. Every part
// iterates DATA — the record's stateRefs, the active view's fields, the
// record's own actions, its relationRefs, and its resolved evidence — so a new
// state / field / action / connection / activity item appears with ZERO edits
// here (the Generic / Data-Driven Gate, L063/L090).
//
// BLIND renderer: zero support vocabulary. Refs never leak — roles, origins and
// keys humanize before display (L098). Actions never dispatch here; the user's
// intent flows out through `onAction(action, answers)` for the entry to invoke.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic / Data-Driven Gate (L063/L090): actions = `record.actions`;
//    statuses resolve through statusView (via StatusBadges); fields iterate the
//    active view. No closed union, no domain term in code.
// 2. Refs never leak (L098): connections/origins humanize before display.
// 3. Honest activity (L117): evidence rows read real owner-evidence fields —
//    nothing synthesized, no dead "Open" button for activity that can't open.
// 4. Composes shared `ui` only — no raw HTML, no className (L065/L066).
//
// =============================================================================

import React from 'react';
import { ActionControl, Badge, Card, Container, Text } from '@/packages/ui';
import type { OwnerEvidence, WorkDescriptor } from '../read-data/record-work-graph';
import type { SupportRecord } from './workspace-types';
import { RecordFieldList } from './record-field-list';
import { StatusBadges } from './field-value-view';
import { ActionComposer, answerKeysForAction, type ActionAnswers } from './action-composer';
import { humanizeOrigin, humanizeToken } from './humanize';

function ActionRail({
  actions,
  onAction,
}: {
  actions: WorkDescriptor[];
  onAction: (action: WorkDescriptor, answers: ActionAnswers) => void;
}): React.ReactElement | null {
  const [openId, setOpenId] = React.useState<string | undefined>(undefined);
  if (actions.length === 0) return null;
  const openAction = actions.find((action) => action.id === openId);

  const activate = (action: WorkDescriptor) => {
    if (answerKeysForAction(action).length === 0) {
      onAction(action, {});
      return;
    }
    setOpenId((current) => (current === action.id ? undefined : action.id));
  };

  return (
    <Container layout="vertical" gap="sm">
      <Container layout="horizontal" gap="sm" wrap alignItems="center">
        {actions.map((action) => (
          <ActionControlButton key={action.id} action={action} active={action.id === openId} onActivate={activate} />
        ))}
      </Container>
      {openAction && (
        <ActionComposer
          action={openAction}
          onSubmit={(action, answers) => {
            onAction(action, answers);
            setOpenId(undefined);
          }}
          onCancel={() => setOpenId(undefined)}
        />
      )}
    </Container>
  );
}

function ActionControlButton({
  action,
  active,
  onActivate,
}: {
  action: WorkDescriptor;
  active: boolean;
  onActivate: (action: WorkDescriptor) => void;
}): React.ReactElement {
  return (
    <ActionControl variant={active ? 'secondary' : 'primary'} size="sm" onClick={() => onActivate(action)}>
      {action.label}
    </ActionControl>
  );
}

function ConnectionList({ record }: { record: SupportRecord }): React.ReactElement | null {
  if (record.relationRefs.length === 0) return null;
  return (
    <Container layout="vertical" gap="xs">
      <Text variant="overline" color="muted">Connections</Text>
      {record.relationRefs.map((ref, index) => (
        <Card key={`${ref}-${index}`} variant="nested" padding="sm" layout="column">
          <Text variant="body">{humanizeToken(ref)}</Text>
          <Text variant="caption" color="faint">{humanizeOrigin(ref)}</Text>
        </Card>
      ))}
    </Container>
  );
}

function ActivityList({ evidence }: { evidence: OwnerEvidence[] }): React.ReactElement | null {
  if (evidence.length === 0) return null;
  return (
    <Container layout="vertical" gap="xs">
      <Text variant="overline" color="muted">Activity</Text>
      {evidence.map((item) => (
        <Card key={item.ref} variant="nested" padding="sm" layout="column">
          <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between">
            <Text variant="label">{item.label}</Text>
            {item.stateLabel ? <Badge variant="neutral" size="sm">{item.stateLabel}</Badge> : null}
          </Container>
          {item.summary ? <Text variant="body-xs" color="muted">{item.summary}</Text> : null}
          <Container layout="horizontal" gap="xs" alignItems="center" wrap>
            <Text variant="caption" color="faint">{humanizeOrigin(item.ownerRef)}</Text>
            {item.time ? <Text variant="caption" color="faint">{item.time}</Text> : null}
          </Container>
        </Card>
      ))}
    </Container>
  );
}

export interface RecordDetailProps {
  record: SupportRecord;
  /** The active view descriptor — supplies the field rows shown in the detail. */
  view: WorkDescriptor | undefined;
  onAction: (action: WorkDescriptor, answers: ActionAnswers) => void;
}

/** The detail panel for the selected record: state, fields, actions, connections, activity. */
export function RecordDetail({ record, view, onAction }: RecordDetailProps): React.ReactElement {
  return (
    <Container
      as="aside"
      layout="vertical"
      gap="md"
      padding="md"
      minWidth="280px"
      maxWidth="md"
      aria-label="Selected record"
    >
      <Container layout="vertical" gap="xs">
        <Text variant="heading-lg">{record.label}</Text>
        <StatusBadges stateRefs={record.stateRefs} />
      </Container>
      <ActionRail actions={record.actions} onAction={onAction} />
      <RecordFieldList fields={view?.fields ?? []} values={record.fields} />
      <ConnectionList record={record} />
      <ActivityList evidence={record.evidence} />
    </Container>
  );
}

export default RecordDetail;
