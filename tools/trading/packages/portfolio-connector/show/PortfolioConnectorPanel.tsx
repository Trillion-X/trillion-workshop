// package-set://bitfield-studio/packages/portfolio-connector/show/PortfolioConnectorPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Account surface — built ON the visual-database generic primitive, NOT bespoke
// trading components. Everything the user sees is DATA-driven:
//
//   1. HERO = the account's intrinsic identity (the ONE total value + today's
//      change every account has), rendered from a decoded `headline` + a quiet
//      LineChart equity line + the daily-goal line. No 'equity'/'shares' literal —
//      the figures come from the headline the decoder built off the cycle.
//   2. BALANCES = RecordMetricRow over METRIC DESCRIPTORS (DATA at
//      account:board.metrics): WHICH figures + label/format/tone/order are data.
//      A Schwab `margin_buying_power` metric appears by authoring a descriptor —
//      zero change here.
//   3. HOLDINGS = the visual-database model rendered as a fey table: COLUMNS come
//      from field descriptors (DATA at account:board.fields, discovered from the
//      position keys when absent) and each cell renders through visual-database's
//      generic FieldControl. An options position's strike/expiry, or a futures
//      contract's month, render as columns by DATA — zero column literals here.
//   4. GUARDRAILS = plain-language safety rows (package copy).
//
// THE GENERIC TEST: point this exact file at a Schwab account, an options
// portfolio, or a futures account by authoring different descriptor records (and
// the broker reporting its own fields) — ZERO change here. There is no account
// vocabulary in this file: no fixed field set, no fixed column set, no state enum.
//
// The decoder (read-data/account-board.ts) is the self-describing translation
// boundary; this file renders generically. Status dot tone/pulse come from the
// shared visual-database `statusTone` helper (DATA-driven), never a hardcoded set.
// fey-grade via @/packages/ui; zero raw HTML, zero className (L065/L066).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Activity, ShieldCheck, TrendingUp, Wallet } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  Badge,
  Bar,
  Button,
  Card,
  Container,
  EmptyPlaceholder,
  Icon,
  LineChart,
  ScrollableSurface,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  emitPlaceableSurfaceIntent,
  type LineChartTone,
} from '@/packages/ui';
import {
  decodeVisualDatabaseModel,
  recordsForView,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
} from '@/packages/visual-database/read-data/visual-database';
import { FieldControl, displayTitle, statusTone } from '@/packages/visual-database/show/field-editors';
import { RecordMetricRow } from '@/packages/visual-database/show/RecordMetricRow';
import {
  accountCycleInput,
  accountFieldsInput,
  accountMetricsInput,
  accountViewsInput,
  accountSurfaceCopy,
  decodeAccountHeadline,
  formatAccountMetric,
  projectAccountRecord,
  projectPositionRecords,
  unwrapAccountCycle,
  type AccountHeadline,
  type AccountTone,
} from '@/packages/portfolio-connector/read-data/account-board';

// ---------------------------------------------------------------------------
// Tone mapping (sign tone → LineChart/text tone) — no domain vocabulary.
// ---------------------------------------------------------------------------

function toneLineChart(tone: AccountTone): LineChartTone {
  return tone === 'up' ? 'success' : tone === 'down' ? 'error' : 'neutral';
}

function toneText(tone: AccountTone): 'success' | 'error' | 'muted' {
  return tone === 'up' ? 'success' : tone === 'down' ? 'error' : 'muted';
}

// ---------------------------------------------------------------------------
// HERO — the account's intrinsic identity: headline value + today's change +
// the equity line + the daily-goal line. All figures from the decoded headline.
// ---------------------------------------------------------------------------

function AccountHero({ headline }: { headline: AccountHeadline }) {
  const deltaColor = toneText(headline.deltaTone);
  return (
    <Card variant="surface" padding="lg" layout="column">
      <Container layout="vertical" gap="lg" padding="none">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap padding="none">
          <Text variant="overline" color="faint">Account value</Text>
          <Badge variant={headline.live ? 'success' : 'muted'} size="sm">
            {headline.live ? 'Agent live' : 'Awaiting first cycle'}
          </Badge>
        </Container>

        <Container layout="horizontal" gap="md" alignItems="end" wrap padding="none">
          <Text variant="display" color="strong" mono tabular leading="tight">{headline.value ?? '—'}</Text>
          {headline.deltaValue && (
            <Container layout="horizontal" gap="xs" alignItems="center" padding="none">
              <Text variant="heading-lg" color={deltaColor} mono tabular>{headline.deltaValue}</Text>
              {headline.deltaPct && (
                <Text variant="heading-lg" color={deltaColor} mono tabular>{headline.deltaPct}</Text>
              )}
              <Text variant="body" color="muted">today</Text>
            </Container>
          )}
        </Container>

        <LineChart points={headline.equitySeries} tone={toneLineChart(headline.deltaTone)} height="md" />

        {headline.goalLabel && (
          <Container layout="vertical" gap="xs" padding="none">
            <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
              <Icon icon={TrendingUp} size="xs" color={deltaColor === 'muted' ? 'faint' : deltaColor} />
              <Text variant="caption" color="faint">{headline.goalLabel}</Text>
            </Container>
            {headline.goalProgressPct != null && (
              <Bar
                height="sm"
                segments={[{
                  percent: headline.goalProgressPct,
                  variant: headline.deltaTone === 'down' ? 'error' : 'success',
                  title: headline.goalLabel,
                }]}
              />
            )}
          </Container>
        )}
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// HOLDINGS — visual-database model → fey table. Columns + cells are DATA (mirrors
// trade-order's OrderHistory). Structural roles excluded; every other descriptor
// is a column; cells render through generic FieldControl. The title cell shows a
// status dot whose tone/pulse come from the shared statusTone helper (DATA).
// ---------------------------------------------------------------------------

const STRUCTURAL_ROLES: ReadonlySet<string> = new Set(['id', 'sort']);

function columnDescriptors(model: VisualDatabaseModel): readonly VisualDatabaseFieldDescriptor[] {
  return model.fields.filter((field) => !STRUCTURAL_ROLES.has(field.role));
}

function HoldingCell({ descriptor, record, model }: {
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

function HoldingsSection({ model, hasCycle, openOrders }: {
  model: VisualDatabaseModel;
  hasCycle: boolean;
  openOrders: number;
}) {
  const view = model.views[0];
  const rows = view ? recordsForView(view, model.records, model.fields) : model.records;
  const columns = columnDescriptors(model);

  return (
    <Card variant="surface" padding="lg" layout="column">
      <Container layout="vertical" gap="md" padding="none">
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" wrap padding="none">
          <Text variant="heading-lg">{view?.label ?? 'Holdings'}</Text>
          {openOrders > 0 && (
            <Badge variant="info" size="md">{openOrders} order{openOrders === 1 ? '' : 's'} queued</Badge>
          )}
        </Container>

        {rows.length > 0 && columns.length > 0 ? (
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
                      <HoldingCell descriptor={column} record={record} model={model} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : openOrders > 0 ? (
          <EmptyPlaceholder
            icon={TrendingUp}
            message={`No open positions yet today. ${openOrders} order${openOrders === 1 ? '' : 's'} ${openOrders === 1 ? 'is' : 'are'} queued for the next market open.`}
          />
        ) : (
          <EmptyPlaceholder
            icon={Wallet}
            message={hasCycle ? 'No open positions yet today. The agent is holding flat.' : 'Connect the account to see live positions.'}
          />
        )}
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// GUARDRAILS — plain-language safety rows (package copy).
// ---------------------------------------------------------------------------

function GuardrailsSection() {
  return (
    <Card variant="surface" padding="lg" layout="column">
      <Container layout="vertical" gap="md" padding="none">
        <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
          <Icon icon={ShieldCheck} size="sm" color="success" />
          <Text variant="heading-lg">Guardrails</Text>
        </Container>
        <Container layout="vertical" gap="sm" padding="none">
          {accountSurfaceCopy.guardrails.map((sentence) => (
            <Container key={sentence} layout="horizontal" gap="sm" alignItems="center" padding="none">
              <Icon icon={ShieldCheck} size="xs" color="muted" />
              <Text variant="body-xs" color="secondary">{sentence}</Text>
            </Container>
          ))}
        </Container>
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// NOT-CONNECTED — only when there is genuinely no live cycle at all.
// ---------------------------------------------------------------------------

function NotConnectedCard() {
  const openConnections = React.useCallback(() => {
    emitPlaceableSurfaceIntent({
      id: accountSurfaceCopy.setupSurface.id,
      title: accountSurfaceCopy.setupSurface.title,
      materialTarget: accountSurfaceCopy.setupSurface.materialTarget,
      packageEntry: accountSurfaceCopy.setupSurface.packageEntry,
    });
  }, []);
  return (
    <Card variant="surface" padding="lg" layout="column">
      <Container layout="vertical" gap="lg" padding="none">
        <Container layout="horizontal" gap="sm" alignItems="center" padding="none">
          <Icon icon={Wallet} size="sm" color="muted" />
          <Text variant="heading-lg">{accountSurfaceCopy.notConnected.title}</Text>
        </Container>
        <Text variant="body-lg" color="secondary" leading="relaxed">{accountSurfaceCopy.notConnected.summary}</Text>
        <Container layout="horizontal" padding="none" minHeight="0">
          <Button variant="primary" size="lg" onClick={openConnections}>
            <Icon icon={Activity} size="sm" />
            {accountSurfaceCopy.notConnected.setupLabel}
          </Button>
        </Container>
      </Container>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel — reads the live cycle + descriptor DATA, renders generically.
// ---------------------------------------------------------------------------

export function PortfolioConnectorPanel() {
  const cycleEntry = useBitfieldData(accountCycleInput.inputName);
  const metricsData = useBitfieldData(accountMetricsInput.inputName);
  const fieldsData = useBitfieldData(accountFieldsInput.inputName);
  const viewsData = useBitfieldData(accountViewsInput.inputName);

  const cycle = React.useMemo(() => unwrapAccountCycle(cycleEntry), [cycleEntry]);
  const headline = React.useMemo(() => decodeAccountHeadline(cycle), [cycle]);

  // Balances: ONE account record + metric descriptors (DATA) → RecordMetricRow.
  const accountModel = React.useMemo(
    () => decodeVisualDatabaseModel({
      records: projectAccountRecord(cycle),
      fields: metricsData,
      views: null,
      actions: null,
    }),
    [cycle, metricsData],
  );
  const accountRecord = accountModel.records[0] ?? null;
  const metricDescriptors = React.useMemo(
    () => accountModel.fields.filter((field) => !STRUCTURAL_ROLES.has(field.role)),
    [accountModel],
  );

  // Holdings: position records + column descriptors (DATA) → visual-database table.
  const holdingsModel = React.useMemo(
    () => decodeVisualDatabaseModel({
      records: projectPositionRecords(cycle),
      fields: fieldsData,
      views: viewsData,
      actions: null,
    }),
    [cycle, fieldsData, viewsData],
  );

  const openOrders = Number(cycle?.open_orders ?? 0) || 0;

  // Genuinely no account at all (no live cycle to read).
  if (!headline.live && headline.value == null) {
    return (
      <ScrollableSurface>
        <Container layout="vertical" gap="lg">
          <NotConnectedCard />
          <GuardrailsSection />
        </Container>
      </ScrollableSurface>
    );
  }

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="lg" data-testid="portfolio-connector-surface">
        <AccountHero headline={headline} />
        {accountRecord && metricDescriptors.length > 0 && (
          <Card variant="surface" padding="lg" layout="column">
            <RecordMetricRow record={accountRecord} descriptors={metricDescriptors} formatValue={formatAccountMetric} />
          </Card>
        )}
        <HoldingsSection model={holdingsModel} hasCycle={headline.live} openOrders={openOrders} />
        <GuardrailsSection />
      </Container>
    </ScrollableSurface>
  );
}
