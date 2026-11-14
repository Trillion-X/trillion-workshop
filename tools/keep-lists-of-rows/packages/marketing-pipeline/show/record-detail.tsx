// package-set://bitfield-studio/packages/marketing-pipeline/show/record-detail.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The selected-record detail region + the owner-action rail. Given the active
// record it shows the record's connections, outputs (evidence), and runs, with
// the actions the record exposes pinned at the top. Every part iterates DATA —
// the record's relationships, evidenceRefs, processSessionRefs, and the actions
// it lists — so a new connection/output/run/action appears with zero edits here.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Generic / Data-Driven Gate (L063/L090): actions iterate `model.actions`
//    filtered by the record's own descriptor ids; statuses resolve through
//    statusView. No closed union, no domain term in code.
// 2. Refs never leak (L098): roles/targets/origins/sessions humanize before
//    display.
// 3. Composes shared `ui` only — no raw HTML, no className (L065/L066).
//
// =============================================================================

import React from 'react';
import {
  ActionControl,
  Card,
  Container,
  EvidenceSourceCard,
  RunCard,
  Text,
  statusView,
} from '@/packages/ui';
import { FileText } from 'lucide-react';
import type {
  CoordinationActionDescriptor,
  CoordinationRecord,
  CoordinationSurfaceModel,
  JsonRecord,
} from '../read-data/read-coordination-records';
import { humanizeOrigin, humanizeToken } from './humanize';

/** Actions a record exposes: its own descriptor ids, or all when it pins none. */
export function actionsForRecord(
  model: CoordinationSurfaceModel,
  record: CoordinationRecord | undefined,
): CoordinationActionDescriptor[] {
  if (!record || record.actionDescriptorIds.length === 0) return model.actions;
  return model.actions.filter((action) => record.actionDescriptorIds.includes(action.id));
}

function ActionRail({
  actions,
  onActivate,
}: {
  actions: CoordinationActionDescriptor[];
  onActivate: (action: CoordinationActionDescriptor) => void;
}): React.ReactElement | null {
  if (actions.length === 0) return null;
  return (
    <Container layout="horizontal" gap="sm" wrap>
      {actions.map((action) => (
        <ActionControl key={action.id} variant="primary" onClick={() => onActivate(action)}>
          {action.label}
        </ActionControl>
      ))}
    </Container>
  );
}

function ConnectionList({ record }: { record: CoordinationRecord }): React.ReactElement | null {
  if (record.relationships.length === 0) return null;
  return (
    <Container layout="vertical" gap="xs">
      <Text variant="overline" color="muted">Connections</Text>
      {record.relationships.map((relationship, index) => (
        <Card key={`rel-${index}`} variant="nested" padding="sm" layout="column">
          <Text variant="label" color="muted">{humanizeToken(relationship.role)}</Text>
          <Text variant="body">{humanizeToken(relationship.targetRef)}</Text>
          {relationship.ownerRef && (
            <Text variant="caption" color="faint">{humanizeOrigin(relationship.ownerRef)}</Text>
          )}
        </Card>
      ))}
    </Container>
  );
}

function EvidenceList({
  record,
  onOpen,
}: {
  record: CoordinationRecord;
  onOpen: (evidence: JsonRecord) => void;
}): React.ReactElement | null {
  if (record.evidenceRefs.length === 0) return null;
  return (
    <Container layout="vertical" gap="xs">
      <Text variant="overline" color="muted">Outputs</Text>
      {record.evidenceRefs.map((evidence, index) => (
        <EvidenceSourceCard
          key={`evidence-${index}`}
          id={`${evidence.role}:${evidence.ownerRef}`}
          label={humanizeToken(evidence.role)}
          originLabel={humanizeOrigin(evidence.ownerRef)}
          kindLabel={evidence.status ? statusView(evidence.status).label : undefined}
          icon={FileText}
          density="row"
          actionLabel="Open"
          onAction={() => onOpen(evidence as unknown as JsonRecord)}
        />
      ))}
    </Container>
  );
}

function RunList({
  record,
  runningText,
}: {
  record: CoordinationRecord;
  runningText: string;
}): React.ReactElement | null {
  if (record.processSessionRefs.length === 0) return null;
  const anyActive = record.processSessionRefs.some(
    (session) => !session.terminalStateRef || !statusView(session.terminalStateRef).isTerminal,
  );
  return (
    <Container layout="vertical" gap="xs">
      <Text variant="overline" color="muted">{anyActive ? runningText : 'Runs'}</Text>
      {record.processSessionRefs.map((session) => (
        <RunCard
          key={session.sessionRef}
          title={humanizeToken(session.sessionRef)}
          status={session.terminalStateRef ?? 'running'}
        />
      ))}
    </Container>
  );
}

export interface RecordDetailProps {
  model: CoordinationSurfaceModel;
  record: CoordinationRecord;
  onActivate: (action: CoordinationActionDescriptor) => void;
  onOpenEvidence: (evidence: JsonRecord) => void;
}

/** The detail panel for the selected record: actions, connections, outputs, runs. */
export function RecordDetail({ model, record, onActivate, onOpenEvidence }: RecordDetailProps): React.ReactElement {
  const actions = actionsForRecord(model, record);
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
      <Text variant="heading-lg">{record.label}</Text>
      <ActionRail actions={actions} onActivate={onActivate} />
      <ConnectionList record={record} />
      <EvidenceList record={record} onOpen={onOpenEvidence} />
      <RunList record={record} runningText={model.surfaceCopy.runningText} />
    </Container>
  );
}

export default RecordDetail;
