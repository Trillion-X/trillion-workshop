// package-set://bitfield-studio/packages/permission-lease/show/PermissionLeasePanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Guardrails / Allowed-Trading surface — built ON the visual-database generic
// primitive, NOT as bespoke rule rows. The guardrail DIMENSIONS (the caps, the
// allowed symbols, the posture, the expiry) are visual-database FIELD DESCRIPTORS
// authored as DATA (permission-lease:guardrails.fields); this file renders the
// lease's self-describing fields through visual-database's generic RecordMetricRow +
// the shared statusTone helper. A venue with different guardrails
// (max_open_positions, leverage, a Polymarket Yes/No cap) renders by DATA alone —
// ZERO change to this file.
//
// What this file shows:
//   - POSTURE: the lease's `live_money_allowed` status field, as a dot+label from
//     its DATA domain (paper=green, real money=warning+pulse) via the shared
//     visual-database statusTone helper. No paper/real branch in the TSX.
//   - LIMITS: the lease's metric descriptors as a fey hairline strip via the
//     shared RecordMetricRow; each value's presentation (money/symbol-list/expiry)
//     comes from the descriptor's data-declared `format`, never a fixed list.
//   - LEASE PHYSICS (universal to ANY permission lease, not a dimension): the
//     every-order-is-checked promise, the latest verdict, and what the agent is
//     doing right now (the canonical hold-reason sentence) — prose rows.
//
// THE GENERIC TEST: point this exact file at a Schwab-options / Polymarket /
// x402 lease by authoring different guardrail field descriptors — ZERO change
// here. There is no guardrail vocabulary in this file: no cap names, no
// paper/live literals, no fixed dimension set.
//
// fey-grade via tools/ui; zero raw HTML, zero className.
// =============================================================================

import React from 'react';
import { Container, Icon, ScrollableSurface, Spinner, StatusDot, Text } from '../../ui/index.ts';
import { ShieldOff } from 'lucide-react';
import {
  decodeVisualDatabaseModel,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseRecord,
} from '../../keep-lists-of-rows/read-data/visual-database';
import { statusTone } from '../../keep-lists-of-rows/show/field-editors';
import { RecordMetricRow, type RecordMetricFormat } from '../../keep-lists-of-rows/show/RecordMetricRow';
import {
  type GuardrailLine,
  type GuardrailTone,
} from '../read-data/live-guardrails-surface.ts';
import { useLiveGuardrails } from '../read-data/read-live-guardrails.ts';

const TONE_TO_DOT: Record<GuardrailTone, 'success' | 'warning' | 'error' | 'info' | 'accent' | 'idle'> = {
  safe: 'success', caution: 'warning', 'live-money': 'warning', blocked: 'error', unknown: 'idle',
};

/** Data-declared value presentation. The descriptor's `format` (money / symbol-list /
 *  expiry / count) names how to render the raw value; an unknown format degrades to
 *  a plain string. Presentation is the data owner's call (visual-database never
 *  enumerates currency vs count) — this is the surface's formatValue. */
function formatGuardrailValue(value: unknown, descriptor: VisualDatabaseFieldDescriptor): RecordMetricFormat {
  const format = (descriptor as { format?: string }).format;
  if (value === null || value === undefined) return { value: format === 'expiry' ? 'No expiry' : '—' };
  if (format === 'money' && typeof value === 'number') {
    return { value: value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value % 1 === 0 ? 0 : 2 }) };
  }
  if (format === 'symbol-list') {
    const list = Array.isArray(value) ? value.map(String) : [String(value)];
    return { value: list.length === 0 ? 'Any' : list.join(', ') };
  }
  if (format === 'expiry') {
    const time = Date.parse(String(value));
    if (!Number.isFinite(time)) return { value: 'No expiry' };
    return { value: new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), tone: time <= Date.now() ? 'error' : undefined };
  }
  if (format === 'count' && typeof value === 'number') return { value: value.toLocaleString('en-US') };
  return { value: Array.isArray(value) ? value.map(String).join(', ') : String(value) };
}

/** A lease-primitive prose row: status dot + sentence + optional detail. */
function StatementRow({ line, first }: { line: GuardrailLine; first: boolean }) {
  return (
    <Container layout="horizontal" gap="sm" alignItems="start" padding="none" border={first ? 'none' : 'top'}>
      <StatusDot status={TONE_TO_DOT[line.tone]} label={line.text} size="md" />
      <Container layout="vertical" gap="none" padding="none" flex="1" minWidth="0">
        <Text variant="body" color="strong" leading="snug">{line.text}</Text>
        {line.detail ? <Text variant="caption" color="faint" leading="snug">{line.detail}</Text> : null}
      </Container>
    </Container>
  );
}

function StateMessage({ icon, title, body }: { icon: typeof ShieldOff | null; title: string; body: string }) {
  return (
    <Container layout="vertical" gap="sm" alignItems="center" justifyContent="center" padding="xl">
      {icon ? <Icon icon={icon} size="lg" color="muted" /> : <Spinner />}
      <Text variant="heading-lg" leading="tight" align="center">{title}</Text>
      {body ? <Text variant="body" color="muted" leading="snug" align="center">{body}</Text> : null}
    </Container>
  );
}

export function PermissionLeasePanel() {
  const { surface, loading, fieldsData, viewsData } = useLiveGuardrails();

  // Build the visual-database model from the projected lease record + the guardrail
  // field/view descriptor DATA. WHICH guardrails render is these descriptors.
  const model = React.useMemo(
    () => decodeVisualDatabaseModel({
      records: surface.leaseRecord ? [{ id: surface.leaseRecord.id, payload: surface.leaseRecord.payload }] : [],
      fields: fieldsData,
      views: viewsData,
      actions: null,
    }),
    [surface.leaseRecord, fieldsData, viewsData],
  );

  if (loading) return <ScrollableSurface><StateMessage icon={null} title="Checking your trading safety…" body="" /></ScrollableSurface>;
  if (surface.recordsMissing) {
    return <ScrollableSurface><StateMessage icon={ShieldOff} title="Trading isn't set up yet" body="Connect an account and the safety rules will show up here." /></ScrollableSurface>;
  }

  const leaseRow: VisualDatabaseRecord | undefined = model.records[0];
  const posture = leaseRow ? statusTone(leaseRow, model) : null;
  const metricDescriptors = model.fields.filter((field) => field.role === 'metric');
  const statements: GuardrailLine[] = [
    surface.checkGate,
    ...(surface.agentStatus ? [surface.agentStatus] : []),
    surface.latestCheck,
  ];

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="xl" padding="none">
        {/* Posture hero — quiet status line; dot tone + label from the lease's DATA domain */}
        <Container layout="vertical" gap="sm" padding="none">
          <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
            <StatusDot status={posture?.status ?? TONE_TO_DOT[surface.headlineTone]} color={posture?.color} size="lg" pulse={posture?.active} label={surface.headline} />
            <Text variant="heading-lg" leading="tight">{surface.headline}</Text>
          </Container>
          <Text variant="body" color="muted" leading="snug">{surface.subhead}</Text>
        </Container>

        {/* Limits — the lease's metric descriptors as a fey hairline strip (DATA-driven) */}
        {leaseRow && metricDescriptors.length > 0 ? (
          <Container layout="vertical" gap="sm" padding="none">
            <Text variant="overline">Limits in force</Text>
            <RecordMetricRow record={leaseRow} descriptors={metricDescriptors} formatValue={formatGuardrailValue} align="start" />
          </Container>
        ) : null}

        {/* Lease Physics — the check promise, the agent's current hold, the latest verdict */}
        <Container layout="vertical" gap="sm" padding="none">
          <Text variant="overline">Safety</Text>
          <Container layout="vertical" gap="md" padding="none">
            {statements.map((line, index) => <StatementRow key={line.key} line={line} first={index === 0} />)}
          </Container>
        </Container>

        <Text variant="caption" color="faint" leading="relaxed">{surface.liveSwitchNote}</Text>
      </Container>
    </ScrollableSurface>
  );
}
