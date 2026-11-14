// package-set://bitfield-studio/packages/investment-command/show/InvestmentCommandPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Trading Center cockpit — built ON the visual-database generic primitive, NOT a
// bespoke schema. The agent's live status fact is projected into visual-database
// record ROWS (read-trading-agent-cycle), then decoded into a VisualDatabaseModel
// against field/view descriptor DATA (authored at `agent:cockpit-board.*`). This
// file renders that model generically, in fey anatomy:
//
//   - HERO: the headline figure + signed delta come from the field descriptors
//     tagged role:'headline'/'delta' (DATA), read off the one hero record. The
//     stat strip is `RecordMetricRow` over the role:'metric' descriptors —
//     rendered by COUNT, never a fixed list. A thin `LineChart` whose timeframe
//     RANGES come from an OptionSpec descriptor (DATA), never literals.
//   - WATCHLIST: a visual-database kind:'table' view — COLUMNS are field descriptors,
//     each cell renders through visual-database's generic FieldControl, so the
//     status OPTIONS + tones + the leading status dot all come from descriptor
//     DATA. Mirrors the Order surface's history table.
//
// THE GENERIC TEST: point this exact file at a different agent/venue (Schwab
// options, a Polymarket market, an x402 wallet) by authoring different descriptor
// DATA — ZERO change here. No equity/momentum/buy vocabulary, no fixed field set,
// no fixed columns, no domain branch. The only non-data branch is the surface
// render-mode (overview vs the tiled workspace).
//
// fey-grade via @/packages/ui + visual-database; ZERO inline style / raw HTML.
// =============================================================================

import React from 'react';
import { Radar, SendHorizontal } from 'lucide-react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  Button,
  Container,
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
  extractFieldValue,
  recordsForView,
  type VisualDatabaseFieldDescriptor,
  type VisualDatabaseModel,
  type VisualDatabaseRecord,
} from '@/packages/visual-database/read-data/visual-database';
import { RecordMetricRow, type RecordMetricFormat } from '@/packages/visual-database/show/RecordMetricRow';
import { FieldControl, displayTitle, statusTone } from '@/packages/visual-database/show/field-editors';
import { EmbeddedScreenArrangement } from '@/packages/screen-arrangement/show/EmbeddedScreenArrangement';
import { runInvestmentCommandAction } from '@/packages/investment-command/do-work/run-investment-command-action';
import {
  decodeInvestmentCommandSurfaceRecipe,
  decodeInvestmentMarketBars,
  investmentCommandSurface,
  summarizeInvestmentMarketBars,
  type InvestmentCommandSurfaceRecipe,
} from '@/packages/investment-command/read-data/investment-command-surface';
import {
  projectCockpit,
  TRADING_AGENT_CYCLE_INPUT,
} from '@/packages/investment-command/read-data/read-trading-agent-cycle';
import {
  COCKPIT_FIELDS_INPUT,
  COCKPIT_VIEWS_INPUT,
  COCKPIT_RANGES_INPUT,
  buildHeroRecord,
  decodeCockpitFields,
  decodeRangeOptions,
  decodeViewSource,
  type CockpitRange,
} from '@/packages/investment-command/read-data/cockpit-board';
import {
  acceptsTradingWorkspaceLayoutState,
  TRADING_WORKSPACE_LAYOUT_STATE,
  TRADING_WORKSPACE_LAYOUT_STATE_ADDRESS_LABEL,
  TRADING_WORKSPACE_LAYOUT_STATE_INPUT,
  TRADING_WORKSPACE_PLACEABLE_SURFACE_LIST_ADDRESS_LABEL,
} from '@/packages/investment-command/read-data/read-trading-workspace-layout-state';

type InvestmentCommandPanelProps = {
  surface?: InvestmentCommandSurfaceRecipe;
  surfaceInput?: Record<string, unknown>;
};

function readSurfacePart(surfaceInput: Record<string, unknown> | undefined): 'workspace' | 'overview' {
  const raw = surfaceInput?.trading_surface ?? surfaceInput?.tradingSurface ?? surfaceInput?.part;
  return raw === 'overview' ? 'overview' : 'workspace';
}

// ---------------------------------------------------------------------------
// VALUE PRESENTATION — the ONE place a raw field value becomes a display string +
// tone. The format is data-owned (the descriptor's domain `format`, else its
// `shape`); gain/loss tone is the sign of a signed-number field. No metric ids,
// no domain literals — this works for ANY descriptor a board declares.
// ---------------------------------------------------------------------------

function descriptorFormat(descriptor: VisualDatabaseFieldDescriptor): string {
  const fromDomain = (descriptor.domain as { format?: string } | undefined)?.format;
  return fromDomain ?? descriptor.shape ?? 'text';
}

function signTone(value: unknown): RecordMetricFormat['tone'] {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n === 0) return 'neutral';
  return n > 0 ? 'success' : 'error';
}

function asMoney(n: number, decimals: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: decimals });
}

function formatValueForDescriptor(value: unknown, descriptor: VisualDatabaseFieldDescriptor): RecordMetricFormat {
  if (value === null || value === undefined || value === '') return { value: '—', tone: 'neutral' };
  const format = descriptorFormat(descriptor);
  const n = typeof value === 'number' ? value : Number(value);
  const finite = Number.isFinite(n);
  switch (format) {
    case 'money':
      return { value: finite ? asMoney(n, 0) : String(value), tone: 'neutral' };
    case 'money2':
      return { value: finite ? asMoney(n, 2) : String(value), tone: signTone(value) };
    case 'percent':
    case 'signed-percent':
      return { value: finite ? `${n > 0 ? '+' : ''}${n.toFixed(2)}%` : String(value), tone: signTone(value) };
    case 'count':
    case 'integer':
      return { value: finite ? n.toLocaleString('en-US') : String(value), tone: 'neutral' };
    default:
      return { value: String(value), tone: 'neutral' };
  }
}

function fieldByRole(fields: readonly VisualDatabaseFieldDescriptor[], role: string): VisualDatabaseFieldDescriptor | null {
  return fields.find((field) => field.role === role) ?? null;
}

const METRIC_ROLE = 'metric';

// ---------------------------------------------------------------------------
// HERO — headline figure + signed delta (fields tagged role:'headline'/'delta'),
// the metric strip (role:'metric' descriptors via RecordMetricRow), and the trend
// line (ranges = OptionSpec DATA). Everything is read off the ONE hero record by
// descriptor; no field name appears in this code. The hero record is built
// directly (it is a single status record, not a human-authored board row), so the
// descriptors come straight from the fields DATA.
// ---------------------------------------------------------------------------

function CockpitHero({ fields, record, priceSeries, ranges, holdLine }: {
  fields: readonly VisualDatabaseFieldDescriptor[];
  record: VisualDatabaseRecord;
  priceSeries: readonly number[];
  ranges: readonly CockpitRange[];
  holdLine: string | null;
}) {
  const [range, setRange] = React.useState(ranges[0]?.id ?? '');
  const headlineField = fieldByRole(fields, 'headline');
  const deltaField = fieldByRole(fields, 'delta');
  const metricDescriptors = fields.filter((field) => field.role === METRIC_ROLE);

  const headline = headlineField ? formatValueForDescriptor(extractFieldValue(record, headlineField), headlineField) : null;
  const delta = deltaField ? formatValueForDescriptor(extractFieldValue(record, deltaField), deltaField) : null;
  const deltaColor = delta?.tone === 'success' ? 'success' : delta?.tone === 'error' ? 'error' : 'strong';
  const lineTone: LineChartTone = delta?.tone === 'success' ? 'success' : delta?.tone === 'error' ? 'error' : 'neutral';

  return (
    <Container layout="vertical" gap="md" padding="none">
      <Container layout="horizontal" gap="sm" alignItems="center" justifyContent="between" padding="none">
        <Text variant="overline" color="faint">{headlineField?.label ?? 'Account'}</Text>
        <Container layout="horizontal" gap="xs" alignItems="center" padding="none">
          <StatusDot status="success" size="sm" pulse />
          <Text variant="caption" color="success">Agent live</Text>
        </Container>
      </Container>

      <Container layout="horizontal" gap="md" alignItems="end" wrap padding="none">
        <Text variant="display" color="strong" mono tabular leading="tight">{headline?.value ?? '—'}</Text>
        {delta ? (
          <Container layout="vertical" gap="none" padding="none">
            <Text variant="heading-lg" color={deltaColor} mono tabular>{delta.value}</Text>
            <Text variant="caption" color="faint">{deltaField?.label ?? 'today'}</Text>
          </Container>
        ) : null}
      </Container>

      <LineChart points={priceSeries} tone={lineTone} height="md" ranges={ranges} activeRange={range} onRangeChange={setRange} />

      {holdLine ? <Text variant="caption" color="faint">{holdLine}</Text> : null}

      {metricDescriptors.length > 0 ? (
        <RecordMetricRow record={record} descriptors={metricDescriptors} formatValue={formatValueForDescriptor} />
      ) : null}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// TABLE — a visual-database kind:'table' view rendered as a fey table. COLUMNS are
// the field descriptors (minus structural id/sort); each cell renders via
// visual-database's generic FieldControl (read-only), so options/tones/the status
// dot all come from DATA. Mirrors the Order surface's history table.
// ---------------------------------------------------------------------------

const STRUCTURAL_ROLES: ReadonlySet<string> = new Set(['id', 'sort']);

function columnDescriptors(model: VisualDatabaseModel): readonly VisualDatabaseFieldDescriptor[] {
  return model.fields.filter((field) => !STRUCTURAL_ROLES.has(field.role));
}

function BoardCell({ descriptor, record, model }: {
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

function BoardTable({ model, title, emptyMessage }: {
  model: VisualDatabaseModel;
  title: string;
  emptyMessage: string;
}) {
  const view = model.views[0];
  const rows = view ? recordsForView(view, model.records, model.fields) : model.records;
  const columns = columnDescriptors(model);
  return (
    <Container layout="vertical" gap="sm" padding="none">
      <Container layout="horizontal" gap="sm" alignItems="baseline" justifyContent="between" padding="none" border="bottom">
        <Text variant="overline" color="faint">{view?.label ?? title}</Text>
        {rows.length > 0 ? <Text variant="caption" color="faint">{rows.length}</Text> : null}
      </Container>
      {rows.length > 0 && columns.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => <TableHead key={column.id}>{column.label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((record) => (
              <TableRow key={record.id}>
                {columns.map((column) => (
                  <TableCell key={column.id}><BoardCell descriptor={column} record={record} model={model} /></TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Text variant="body-xs" color="faint" leading="relaxed">{emptyMessage}</Text>
      )}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// MARKET — the fey stock-chart: a thin price line over real bars + a plain-text
// timeframe row, ranges from the same OptionSpec DATA. Generic over the bar series.
// ---------------------------------------------------------------------------

function MarketSection({ bars, ranges, liveTitle, emptyTitle }: {
  bars: readonly { close: number; timestamp: number }[];
  ranges: readonly CockpitRange[];
  liveTitle: string;
  emptyTitle: string;
}) {
  const summary = summarizeInvestmentMarketBars(bars as never);
  const has = bars.length > 0;
  const [range, setRange] = React.useState(ranges[0]?.id ?? '');
  const points = React.useMemo(() => bars.map((bar) => ({ value: bar.close, t: bar.timestamp })), [bars]);
  const latest = summary.latest === null ? '—' : asMoney(summary.latest, 2);
  return (
    <Container layout="vertical" gap="sm" padding="none">
      <Container layout="horizontal" gap="sm" alignItems="baseline" justifyContent="between" padding="none" border="bottom">
        <Text variant="overline" color="faint">{has ? `${summary.symbol ?? 'Market'} · ${liveTitle}` : emptyTitle}</Text>
        <Text variant="caption" color="faint">{has ? `${latest} latest · ${bars.length} bars` : 'No live bars'}</Text>
      </Container>
      {has ? (
        <LineChart
          points={points}
          height="xl"
          showAxis
          formatValue={(value) => asMoney(value, 2)}
          ranges={ranges}
          activeRange={range}
          onRangeChange={setRange}
        />
      ) : (
        <Text variant="body-xs" color="faint" leading="relaxed">No fake candles. Connect market data and the price line appears here.</Text>
      )}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// EMPTY HERO — the agent has not reported yet. fey empty-state: icon, headline,
// one line, one action. Shares the flat black surface.
// ---------------------------------------------------------------------------

function EmptyHero({ onConnect, setupLabel, emptyTitle, emptyCopy }: {
  onConnect: () => void;
  setupLabel: string;
  emptyTitle: string;
  emptyCopy: string;
}) {
  return (
    <Container layout="vertical" gap="md" padding="none">
      <Text variant="overline" color="faint">Awaiting first cycle</Text>
      <LineChart points={[]} tone="neutral" height="md" />
      <Container layout="vertical" gap="sm" padding="none">
        <Text variant="heading-lg" color="strong">{emptyTitle}</Text>
        <Text variant="body-xs" color="faint" leading="relaxed">{emptyCopy}</Text>
        <Container layout="horizontal" padding="none" minHeight="0">
          <Button variant="primary" size="sm" onClick={onConnect}>
            <Icon icon={Radar} size="xs" />
            {setupLabel}
          </Button>
        </Container>
      </Container>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// PANEL — reads the live fact + descriptor DATA, builds visual-database models,
// renders generically. Thin: zero domain vocabulary.
// ---------------------------------------------------------------------------

export function InvestmentCommandPanel({ surface = investmentCommandSurface, surfaceInput }: InvestmentCommandPanelProps) {
  const surfacePart = React.useMemo(() => readSurfacePart(surfaceInput), [surfaceInput]);
  const cycleEntry = useBitfieldData(TRADING_AGENT_CYCLE_INPUT);
  const marketBarsEntry = useBitfieldData(surface.marketBarsInput);
  const fieldsData = useBitfieldData(COCKPIT_FIELDS_INPUT);
  const viewsData = useBitfieldData(COCKPIT_VIEWS_INPUT);
  const rangesData = useBitfieldData(COCKPIT_RANGES_INPUT);

  const liveSurface = decodeInvestmentCommandSurfaceRecipe(surface);
  const projection = React.useMemo(() => projectCockpit(cycleEntry), [cycleEntry]);
  const marketBars = React.useMemo(() => decodeInvestmentMarketBars(marketBarsEntry), [marketBarsEntry]);
  const ranges = React.useMemo(() => decodeRangeOptions(rangesData), [rangesData]);

  // The hero is ONE status record (not a human board row), so it is built
  // directly and read against the hero field descriptors (DATA). Routing it
  // through decodeVisualDatabaseModel would gate it out (no authored title/body).
  const heroFields = React.useMemo(() => decodeCockpitFields(fieldsData), [fieldsData]);
  const heroRecord = React.useMemo(() => buildHeroRecord(projection.heroRecord), [projection.heroRecord]);
  // The watchlist is a visual-database table over the row group named by the views
  // DATA (`source`) — so a different agent surfaces its own array (signals,
  // markets, positions…) by authoring a different source, ZERO code change here.
  const viewSource = React.useMemo(() => decodeViewSource(viewsData), [viewsData]);
  const tableRows = React.useMemo(
    () => (viewSource ? projection.rowGroups[viewSource] ?? [] : []),
    [viewSource, projection.rowGroups],
  );
  const signalModel = React.useMemo(
    () => decodeVisualDatabaseModel({
      records: tableRows as unknown,
      fields: viewsData,
      views: viewsData,
      actions: null,
    }),
    [tableRows, viewsData],
  );

  const [running, setRunning] = React.useState(false);
  const [status, setStatus] = React.useState<'idle' | 'submitted' | 'failed'>('idle');

  function openConnections() {
    emitPlaceableSurfaceIntent({
      id: liveSurface.setupSurface.id,
      title: liveSurface.setupSurface.title,
      materialTarget: liveSurface.setupSurface.materialTarget,
      packageEntry: liveSurface.setupSurface.packageEntry,
    });
  }

  async function submitPrimaryAction() {
    setRunning(true);
    setStatus('idle');
    try {
      await runInvestmentCommandAction(liveSurface.primaryAction);
      setStatus('submitted');
    } catch {
      setStatus('failed');
    } finally {
      setRunning(false);
    }
  }

  if (surfacePart === 'workspace') {
    return (
      <EmbeddedScreenArrangement
        initialState={TRADING_WORKSPACE_LAYOUT_STATE}
        layoutEntryInput={TRADING_WORKSPACE_LAYOUT_STATE_INPUT}
        placeableSurfaceListAddressLabel={TRADING_WORKSPACE_PLACEABLE_SURFACE_LIST_ADDRESS_LABEL}
        persistence={{ valueAddressLabel: TRADING_WORKSPACE_LAYOUT_STATE_ADDRESS_LABEL }}
        acceptPersistedState={acceptsTradingWorkspaceLayoutState}
        chrome={{ 'header.actions': false, 'header.new-tab': false }}
      />
    );
  }

  const statusColor = status === 'failed' ? 'error' : status === 'submitted' ? 'success' : 'faint';
  const statusText = status === 'submitted'
    ? 'Trading cycle started'
    : status === 'failed'
      ? 'Could not start the trading cycle'
      : projection.reported ? 'Cycle reported' : 'Run a cycle to begin';

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="xl" padding="none" data-testid="investment-command-surface">
        {projection.reported && heroRecord ? (
          <CockpitHero fields={heroFields} record={heroRecord} priceSeries={projection.priceSeries} ranges={ranges} holdLine={projection.holdLine} />
        ) : (
          <EmptyHero
            onConnect={openConnections}
            setupLabel={liveSurface.setupLabel}
            emptyTitle={liveSurface.emptyTitle}
            emptyCopy={liveSurface.emptyCopy}
          />
        )}

        <Container layout="horizontal" gap="sm" alignItems="center" wrap padding="none">
          <Button variant="success" size="sm" loading={running} disabled={running} onClick={submitPrimaryAction} data-testid="investment-primary-action">
            <Icon icon={SendHorizontal} size="xs" />
            {liveSurface.primaryAction.label}
          </Button>
          <Button variant="secondary" size="sm" onClick={openConnections} data-testid="investment-open-connections">
            {liveSurface.setupLabel}
          </Button>
          <Text variant="caption" color={statusColor}>{statusText}</Text>
        </Container>

        {projection.reported ? (
          <BoardTable model={signalModel} title="What the agent is watching" emptyMessage="The agent has not reported a watchlist evaluation yet." />
        ) : null}

        <MarketSection bars={marketBars} ranges={ranges} liveTitle={liveSurface.liveTitle} emptyTitle={liveSurface.emptyTitle} />
      </Container>
    </ScrollableSurface>
  );
}
