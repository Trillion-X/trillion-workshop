// package-set://bitfield-studio/packages/trade-order/show/TradeOrderPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Order surface — built ON the visual-database generic primitive, NOT as
// bespoke trading components. Two jobs, both data-driven:
//
//   1. ORDER HISTORY = the visual-database descriptor model rendered as a fey
//      table: COLUMNS come from field descriptors (DATA at trade:order-board.fields)
//      and each cell renders through visual-database's generic `FieldControl`
//      (read-only) — so the side/status OPTIONS + tones come from the descriptors'
//      `domain` via `effectiveDomain`. Zero hardcoded columns, zero side/status
//      literals in this file.
//   2. ORDER TICKET = the shared `ComposeFieldSet` (visual-database) rendering the
//      ORDER-CAPABILITY descriptor (DATA at trade:order-capability.latest): the
//      fields a person fills to draft an order, each field's options from data.
//      Buy/Sell, Market/Limit/Stop emerge from the capability DATA.
//
// THE GENERIC TEST: point this exact file at Schwab options / a Polymarket Yes-No
// market / an x402 wallet by authoring different descriptor records — ZERO change
// here. There is no order vocabulary in this file: no 'buy'/'sell'/'market', no
// fixed field set, no fixed column set.
//
// Live order ROWS are derived (decodeTradeOrderLive merges the executor order-set
// + per-order broker records + the agent cycle), then PROJECTED into visual-database
// records. The decoder is the self-describing translation boundary; this file
// renders generically. fey-grade via @/packages/ui; zero raw HTML, zero className.
// =============================================================================

import React from 'react';
import {
  Badge,
  Button,
  Card,
  Container,
  EmptyPlaceholder,
  MetricRow,
  ScrollableSurface,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
} from '@/packages/ui';
import type { MetricCell } from '@/packages/ui';
import { Inbox } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  decodeVisualDatabaseModel,
  recordsForView,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
} from '@/packages/visual-database/read-data/visual-database';
import { FieldControl, displayTitle, statusTone, toneVariant } from '@/packages/visual-database/show/field-editors';
import { ComposeFieldSet, type ComposeFieldDescriptor } from '@/packages/visual-database/show/ComposeFieldSet';
import { decodeTradeOrderLive, type TradeOrderAccount } from '@/packages/trade-order/read-data/trade-order-live';
import {
  tradeOrderCycleInput,
  tradeOrderSetInput,
  tradeOrderRecordsInput,
  tradeOrderFieldsInput,
  tradeOrderViewsInput,
  tradeOrderCapabilityInput,
} from '@/packages/trade-order/read-data/trade-order-cycle';
import {
  decodeOrderCapability,
  projectOrderRecords,
  type OrderCapability,
} from '@/packages/trade-order/read-data/order-capability';

// ---------------------------------------------------------------------------
// Order history (visual-database model → fey table; columns + options are DATA)
// ---------------------------------------------------------------------------

/** Columns = the display fields, in descriptor order. Purely structural bindings
 *  (the record id, the sort key) are not shown; every other field is a column.
 *  This is an exclude-list of structural roles, not an allow-list of field kinds,
 *  so any role a board invents (status, link, …) renders as a column for free. */
const STRUCTURAL_ROLES: ReadonlySet<string> = new Set(['id', 'sort']);

function columnDescriptors(model: VisualDatabaseModel): readonly VisualDatabaseFieldDescriptor[] {
  return model.fields.filter((field) => !STRUCTURAL_ROLES.has(field.role));
}

/** One read-only cell: the title column renders the human label + a leading dot
 *  whose tone and pulse come from the status field's DATA domain option (via the
 *  shared visual-database `statusTone` helper — no status lookup re-implemented
 *  here); every other column renders through visual-database's generic FieldControl
 *  (no writeRecord = read-only), so a choice column shows its tone-dotted option
 *  label sourced from the descriptor's DATA domain. */
function HistoryCell({ descriptor, record, model }: {
  descriptor: VisualDatabaseFieldDescriptor;
  record: VisualDatabaseRecord;
  model: VisualDatabaseModel;
}) {
  if (descriptor.role === 'title') {
    const status = statusTone(record, model);
    return (
      <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
        {status && <StatusDot status={status.status} color={status.color} size="sm" pulse={status.active} />}
        <Text variant="body-xs" weight="semibold" truncate>{displayTitle(record)}</Text>
      </Container>
    );
  }
  return <FieldControl descriptor={descriptor} record={record} model={model} lanes={[]} grouping={null} />;
}

function OrderHistory({ model, openOrderCount, ordersPlacedCount, hasLiveSnapshot }: {
  model: VisualDatabaseModel;
  openOrderCount: number;
  ordersPlacedCount: number;
  hasLiveSnapshot: boolean;
}) {
  const view = model.views[0];
  const rows = view ? recordsForView(view, model.records, model.fields) : model.records;
  const columns = columnDescriptors(model);
  // "Working" is the status option's DATA active flag (shared statusTone helper) —
  // no lifecycle vocabulary here.
  const workingShown = rows.filter((record) => statusTone(record, model)?.active === true).length;
  const pendingDetail = Math.max(0, openOrderCount - workingShown);

  return (
    <Card variant="surface" padding="lg" layout="column">
      <Container layout="vertical" gap="md" padding="none">
        <Container layout="horizontal" justifyContent="between" alignItems="center" wrap padding="none">
          <Text variant="heading-lg">{view?.label ?? 'Orders'}</Text>
          <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
            <Badge variant={openOrderCount > 0 ? 'info' : 'muted'} size="md">{openOrderCount} working</Badge>
            <Badge variant="muted-outline" size="md">{ordersPlacedCount} placed</Badge>
          </Container>
        </Container>

        {rows.length > 0 && columns.length > 0 ? (
          <Container layout="vertical" gap="sm" padding="none">
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((column) => (
                    <TableHead key={column.id}>{column.label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((record) => (
                  <TableRow key={record.id}>
                    {columns.map((column) => (
                      <TableCell key={column.id}>
                        <HistoryCell descriptor={column} record={record} model={model} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {pendingDetail > 0 && (
              <Container layout="horizontal" gap="sm" alignItems="center" padding="sm">
                <StatusDot status="info" size="sm" pulse />
                <Text variant="body-xs" color="faint">
                  {pendingDetail} more {pendingDetail === 1 ? 'order is' : 'orders are'} working at the broker, queued for the next open.
                </Text>
              </Container>
            )}
          </Container>
        ) : openOrderCount > 0 ? (
          <Container layout="horizontal" gap="sm" alignItems="center" padding="sm" border="all">
            <StatusDot status="info" size="sm" pulse />
            <Text variant="body-xs" color="faint">
              {openOrderCount} {openOrderCount === 1 ? 'order is' : 'orders are'} working at the broker, queued for the next open.
            </Text>
          </Container>
        ) : (
          <EmptyPlaceholder
            icon={Inbox}
            message={hasLiveSnapshot ? 'No orders yet. The agent places orders when a signal clears its gate.' : 'Connect the account to see live orders.'}
          />
        )}
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Order ticket (ComposeFieldSet over the capability DATA + confirm receipt)
// ---------------------------------------------------------------------------

function formatMoney(value: number | null, fallback = '—'): string {
  if (value === null) return fallback;
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function parsePositive(raw: unknown): number | null {
  const value = Number(raw);
  return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Interpolate "{field}" against the draft, using the chosen option's label. */
function interpolate(template: string, capability: OrderCapability, values: Readonly<Record<string, unknown>>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, id: string) => {
    const field = capability.fields.find((candidate) => candidate.id === id);
    const raw = values[id];
    const option = field?.domain?.values?.find((candidate) => candidate.id === raw);
    return option ? option.label.toLowerCase() : (raw === null || raw === undefined ? '' : String(raw));
  });
}

function OrderTicket({ capability, account }: { capability: OrderCapability | null; account: TradeOrderAccount }) {
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [reviewing, setReviewing] = React.useState(false);

  const fieldKey = (capability?.fields ?? []).map((field) => field.id).join('|');
  React.useEffect(() => {
    if (!capability) return;
    setValues((current) => {
      const next = { ...current };
      for (const field of capability.fields) {
        if (field.shape === 'choice' && next[field.id] === undefined) next[field.id] = field.domain?.values?.[0]?.id ?? '';
      }
      return next;
    });
  }, [fieldKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!capability) {
    return (
      <Card variant="surface" padding="lg" layout="column">
        <EmptyPlaceholder icon={Inbox} message="Order form not configured yet. Connect an account to compose orders." />
      </Card>
    );
  }

  // Live order-value estimate from the draft's number fields (best-effort, by id
  // convention; degrades to "—"). It is a preview figure, never a gate.
  const numberFields = capability.fields.filter((field) => field.shape === 'number');
  const notionalId = numberFields.find((field) => /amount|notional/i.test(field.id))?.id;
  const priceId = numberFields.find((field) => /price/i.test(field.id))?.id;
  const qtyId = numberFields.find((field) => /qty|share|quantity|contract/i.test(field.id))?.id;
  const notional = notionalId ? parsePositive(values[notionalId]) : null;
  const price = priceId ? parsePositive(values[priceId]) : null;
  const qty = qtyId ? parsePositive(values[qtyId]) : null;
  const orderValue = notional ?? (qty !== null && price !== null ? qty * price : null);

  const requiredOk = capability.fields.every((field) => !field.required || String(values[field.id] ?? '').trim().length > 0);
  const reviewLabel = interpolate(capability.submit.reviewLabelTemplate ?? 'Review order', capability, values);
  const sendLabel = interpolate(capability.submit.sendLabelTemplate ?? 'Send order', capability, values);

  const metricCells: MetricCell[] = capability.accountMetrics.map((metric) => ({
    label: metric.label,
    value: metric.format === 'integer'
      ? ((account as unknown as Record<string, number | null>)[metric.id] === null
        ? '—'
        : ((account as unknown as Record<string, number | null>)[metric.id] as number).toLocaleString('en-US'))
      : formatMoney((account as unknown as Record<string, number | null>)[metric.id] ?? null),
  }));
  metricCells.push({ label: 'Order value', value: formatMoney(orderValue) });

  if (reviewing) {
    return (
      <Card variant="surface" padding="lg" layout="column">
        <Container layout="vertical" gap="lg" padding="none">
          <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
            <Button variant="ghost" size="sm" onClick={() => setReviewing(false)} aria-label="Edit order">Edit</Button>
            <Text variant="heading-lg">{reviewLabel}</Text>
          </Container>
          <Container layout="vertical" gap="none" padding="none">
            {capability.fields
              .filter((field) => String(values[field.id] ?? '').trim().length > 0)
              .map((field) => {
                const raw = values[field.id];
                const option = field.domain?.values?.find((candidate) => candidate.id === raw);
                return (
                  <Container key={field.id} layout="horizontal" justifyContent="between" alignItems="center" gap="md" padding="sm" border="bottom">
                    <Text variant="body-xs" color="faint">{field.label}</Text>
                    <Text variant="body-xs" weight="medium" color="strong" mono tabular>{option ? option.label : String(raw)}</Text>
                  </Container>
                );
              })}
            <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" padding="sm" border="bottom">
              <Text variant="body-xs" color="faint">Estimated total</Text>
              <Text variant="body" weight="semibold" color="strong" mono tabular>{formatMoney(orderValue)}</Text>
            </Container>
          </Container>
          <Container layout="vertical" gap="sm" padding="none">
            <Button variant="primary" size="lg">{sendLabel}</Button>
            <Text variant="caption" color="faint" align="center">{capability.submit.guardrailFallback ?? ''}</Text>
          </Container>
        </Container>
      </Card>
    );
  }

  return (
    <Card variant="surface" padding="lg" layout="column">
      <Container layout="vertical" gap="lg" padding="none">
        <Container layout="horizontal" justifyContent="between" alignItems="center" padding="none">
          <Text variant="heading-lg">New order</Text>
          {capability.environment && capability.environment.label.length > 0 && (
            <Badge variant={toneVariant(capability.environment.tone)} size="md">{capability.environment.label}</Badge>
          )}
        </Container>
        <ComposeFieldSet fields={capability.fields as readonly ComposeFieldDescriptor[]} values={values} onChange={setValues} />
        {metricCells.length > 0 && <MetricRow cells={metricCells} />}
        <Button variant="primary" size="lg" disabled={!requiredOk} onClick={() => setReviewing(true)}>{reviewLabel}</Button>
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel — reads live order data + descriptor DATA, renders generically
// ---------------------------------------------------------------------------

export function TradeOrderPanel() {
  // Live order rows (derived): cycle account/decisions + executor order-set + per-order broker records.
  const cycleSnapshot = useBitfieldData(tradeOrderCycleInput.inputName);
  const orderSet = useBitfieldData(tradeOrderSetInput.inputName);
  const orderRecords = useBitfieldData(tradeOrderRecordsInput.inputName);
  // Self-describing visual-database DATA: field descriptors (columns + side/status
  // domains), the view, and the order-ticket capability. The UI READS these.
  const fieldsData = useBitfieldData(tradeOrderFieldsInput.inputName);
  const viewsData = useBitfieldData(tradeOrderViewsInput.inputName);
  const capabilityData = useBitfieldData(tradeOrderCapabilityInput.inputName);

  const live = React.useMemo(
    () => decodeTradeOrderLive(cycleSnapshot, orderSet, orderRecords),
    [cycleSnapshot, orderSet, orderRecords],
  );
  // Project the derived order rows into visual-database records, then decode the
  // generic model from the live rows + the DATA descriptors/views.
  const model = React.useMemo(
    () => decodeVisualDatabaseModel({
      records: projectOrderRecords(live.orders),
      fields: fieldsData,
      views: viewsData,
      actions: null,
    }),
    [live.orders, fieldsData, viewsData],
  );
  const capability = React.useMemo(() => decodeOrderCapability(capabilityData), [capabilityData]);

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="lg" data-testid="trade-order-surface">
        <OrderTicket capability={capability} account={live.account} />
        <OrderHistory
          model={model}
          openOrderCount={live.openOrderCount}
          ordersPlacedCount={live.ordersPlacedCount}
          hasLiveSnapshot={live.hasLiveSnapshot}
        />
      </Container>
    </ScrollableSurface>
  );
}
