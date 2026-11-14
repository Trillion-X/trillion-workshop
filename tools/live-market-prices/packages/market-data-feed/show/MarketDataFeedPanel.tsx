// package-set://bitfield-studio/packages/market-data-feed/show/MarketDataFeedPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Market surface for the trading cockpit — a fey.com stock-detail clone in
// STYLE, and a fully GENERIC, data-driven renderer in STRUCTURE. It renders a
// self-describing `InstrumentBoard` (built in read-data/market-board.ts):
//
//   1. HEADLINE — the board's series identity + a large mono value + signed
//      delta (e.g. a ticker + last price). All from `board.series` DATA.
//   2. PRICE CHART — the shared fey LineChart over `board.series.points`, with
//      the timeframe row driven by `board.ranges` DATA.
//   3. METRIC STRIP — `board.metrics` rendered through the fey MetricRow.
//   4. INSTRUMENT TABLE — a COLUMN-DEFINED table: columns come from
//      `board.columns` DATA, each row renders its `cells` keyed to those
//      columns. There is NO hardcoded column, NO instrument-type branch.
//
// THE GENERIC GUARANTEE (mandate): this file names NO domain field — not
// "momentum", not "buy", not "stock"/"option"/"crypto". Point the same TSX at
// an option chain, a Polymarket Yes/No market, or a new column by changing only
// DATA (the board descriptor). Enum-dissolution + Physics-vs-Society + L090:
// the TSX is a dumb generic renderer over self-describing data.
//
// Reference anatomy: Desktop/fey.com UI/fey-stock-chart-…dark-grid-axis-labels
// -time-range.png (the chart), fey-stock-detail-metric-cards-…-dividers.png
// (the metric strip + column table).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. REAL DATA ONLY. The headline/chart/table render the agent's real board.
//    Absent data yields honest empty states — never a fabricated curve, price,
//    column, or row.
// 2. NO BARCODE. The chart is the shared LineChart (line + gradient).
// 3. NO DOMAIN VOCABULARY. Zero hardcoded column sets, zero instrument-type
//    branches. Columns/cells/metrics/series/ranges all come from the board DATA.
// 4. ALL styling via @/packages/ui primitives (L065/L066) — zero raw HTML,
//    zero className in this feature file.
//
// =============================================================================
// AUTHORING NOTE
// =============================================================================
//
// The documentation in this file is a design feature. Do not remove it.
// =============================================================================

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ArrowDownRight, ArrowUpRight, Radar } from 'lucide-react';
import {
  Badge,
  Card,
  Container,
  Divider,
  Icon,
  LineChart,
  MetricRow,
  ScrollableSurface,
  Text,
} from '@/packages/ui';
import type { LineChartTone, MetricCell } from '@/packages/ui';
import {
  decodeMarketDataFeedBars,
  marketDataFeedSurface,
} from '@/packages/market-data-feed/read-data/market-data-feed-surface';
import {
  agentCycleSurface,
  decodeAgentCycle,
} from '@/packages/market-data-feed/read-data/agent-cycle-surface';
import { buildMarketBoard } from '@/packages/market-data-feed/read-data/market-board';
import type {
  BoardColumn,
  BoardRow,
  BoardSeries,
  CellTone,
  InstrumentBoard,
} from '@/packages/market-data-feed/read-data/instrument-board';

// ---------------------------------------------------------------------------
// TONE MAPPING (generic — tone is data, not domain)
// ---------------------------------------------------------------------------

const TEXT_TONE: Record<CellTone, 'strong' | 'success' | 'error'> = {
  neutral: 'strong',
  success: 'success',
  error: 'error',
};

// ---------------------------------------------------------------------------
// HEADLINE (renders board.series — generic identity + value + delta)
// ---------------------------------------------------------------------------

function BoardHeadline({ series, eyebrow }: { series: BoardSeries; eyebrow: string }) {
  const positive = series.tone !== 'error';
  return (
    <Container layout="vertical" gap="sm">
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Text variant="heading-lg" weight="semibold">{series.title ?? 'Market'}</Text>
        <Text variant="caption" color="faint">{eyebrow}</Text>
      </Container>

      {series.headlineValue ? (
        <Container layout="horizontal" gap="md" alignItems="baseline" wrap>
          <Text variant="display" leading="tight" mono tabular>{series.headlineValue}</Text>
          {series.deltaText ? (
            <Container layout="horizontal" gap="xs" alignItems="center">
              {series.tone !== 'neutral' ? (
                <Icon
                  icon={positive ? ArrowUpRight : ArrowDownRight}
                  size="sm"
                  color={positive ? 'success' : 'error'}
                />
              ) : null}
              <Text variant="body" weight="semibold" color={TEXT_TONE[series.tone]} mono tabular>
                {series.deltaText}
              </Text>
            </Container>
          ) : null}
        </Container>
      ) : (
        <Text variant="body" color="faint">Awaiting live data</Text>
      )}
    </Container>
  );
}

// ---------------------------------------------------------------------------
// INSTRUMENT ROW (column-defined — renders whatever cells the data provides)
// ---------------------------------------------------------------------------

function InstrumentRow({ row, columns }: { row: BoardRow; columns: readonly BoardColumn[] }) {
  return (
    <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between" padding="sm">
      <Container layout="vertical" gap="none" flex="1" minWidth="0">
        <Container layout="horizontal" gap="sm" alignItems="center" minWidth="0">
          <Text variant="body" weight="semibold" color="strong" truncate>{row.label}</Text>
          {row.marker ? (
            <Badge variant={row.marker.tone === 'success' ? 'success' : row.marker.tone === 'error' ? 'error' : 'neutral'} size="sm" weight="bold">
              {row.marker.label}
            </Badge>
          ) : row.state ? (
            <Text variant="caption" color="subtle">{row.state}</Text>
          ) : null}
        </Container>
        {row.sublabel ? <Text variant="caption" color="faint" truncate>{row.sublabel}</Text> : null}
      </Container>

      {/* Each declared column renders its cell — generic, never a fixed set. */}
      <Container layout="horizontal" gap="lg" alignItems="center" justifyContent="end">
        {columns.map((column) => {
          const cell = row.cells.find((c) => c.columnId === column.id);
          const text = cell?.text ?? '—';
          const tone = cell?.tone ?? 'neutral';
          const positive = tone === 'success';
          return (
            <Container key={column.id} layout="horizontal" gap="xs" alignItems="center" justifyContent="end" minWidth="4.5rem">
              {column.signed && tone !== 'neutral' ? (
                <Icon icon={positive ? ArrowUpRight : ArrowDownRight} size="xs" color={positive ? 'success' : 'error'} />
              ) : null}
              <Text variant="body" weight="semibold" color={TEXT_TONE[tone]} mono tabular>{text}</Text>
            </Container>
          );
        })}
      </Container>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// PANEL
// ---------------------------------------------------------------------------

export function MarketDataFeedPanel() {
  const cycleInput = useBitfieldData(agentCycleSurface.inputName);
  const cycle = decodeAgentCycle(cycleInput);

  const barsInput = useBitfieldData(marketDataFeedSurface.inputName);
  const bars = decodeMarketDataFeedBars(barsInput);

  const board: InstrumentBoard = React.useMemo(
    () => buildMarketBoard(cycleInput, cycle, bars, agentCycleSurface.moversTitle),
    [cycleInput, cycle, bars],
  );

  const [activeRange, setActiveRange] = React.useState<string>('');
  const ranges = board.ranges;
  const resolvedRange = activeRange || ranges[0]?.id || '';

  const chartTone: LineChartTone = board.series.tone;
  const hasRows = board.rows.length > 0;
  const hasAgent = cycle !== null;

  // Metric strip cells — straight from the board (generic).
  const metricCells: MetricCell[] = board.metrics.map((metric) => ({
    label: metric.label,
    value: metric.value,
    tone: metric.tone,
  }));

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="xl">
        {/* Price hero — generic headline + thin fey line chart over board.series */}
        <Card variant="surface" padding="lg" layout="stack">
          <BoardHeadline series={board.series} eyebrow={marketDataFeedSurface.eyebrow} />

          <LineChart
            points={board.series.points}
            tone={chartTone}
            height="xl"
            showAxis
            formatValue={(v) => `${board.series.valuePrefix}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            ranges={ranges.length > 0 ? ranges : undefined}
            activeRange={resolvedRange}
            onRangeChange={setActiveRange}
            emptyTitle="No price data yet"
            emptyDescription="A price line appears here once the data feed returns data. Nothing is fabricated."
          />
        </Card>

        {/* Instrument board — generic column-defined table */}
        <Card variant="surface" padding="lg" layout="stack">
          <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" wrap>
            <Container layout="horizontal" gap="sm" alignItems="center">
              <Icon icon={Radar} size="sm" color="info" />
              <Text variant="heading-lg" weight="semibold">{board.title}</Text>
            </Container>
            {hasAgent ? (
              <Badge variant={hasRows ? 'success' : 'neutral'} size="lg">
                {hasRows ? `${board.rows.length} evaluated` : 'No picks this cycle'}
              </Badge>
            ) : null}
          </Container>

          {metricCells.length > 0 ? <MetricRow cells={metricCells} /> : null}

          {/* Column header row — labels come from the board's column descriptor */}
          {hasRows && board.columns.length > 0 ? (
            <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between" padding="sm">
              <Container layout="horizontal" flex="1" minWidth="0">
                <Text variant="caption" color="faint">Instrument</Text>
              </Container>
              <Container layout="horizontal" gap="lg" alignItems="center" justifyContent="end">
                {board.columns.map((column) => (
                  <Container key={column.id} layout="horizontal" justifyContent="end" minWidth="4.5rem">
                    <Text variant="caption" color="faint">{column.label}</Text>
                  </Container>
                ))}
              </Container>
            </Container>
          ) : null}

          {hasRows ? (
            <Container layout="vertical" gap="none">
              {board.rows.map((row, index) => (
                <React.Fragment key={row.id}>
                  {index > 0 ? <Divider orientation="horizontal" /> : null}
                  <InstrumentRow row={row} columns={board.columns} />
                </React.Fragment>
              ))}
            </Container>
          ) : (
            <Container layout="vertical" gap="xs" alignItems="center" padding="lg">
              <Text variant="heading-xs" color="muted">
                {!hasAgent
                  ? agentCycleSurface.noCycleTitle
                  : board.note
                    ? 'No instrument cleared the gate this cycle'
                    : agentCycleSurface.evaluatingTitle}
              </Text>
              <Text variant="body-xs" color="faint" align="center">
                {!hasAgent
                  ? agentCycleSurface.noCycleCopy
                  : board.note
                    ? 'The agent evaluated the candidates and held.'
                    : agentCycleSurface.evaluatingCopy}
              </Text>
            </Container>
          )}

          {/* A human note the data carried (e.g. why the agent held) */}
          {board.note ? (
            <Card variant="nested" padding="md" layout="row">
              <Text variant="body" color="subtle">{board.note}</Text>
            </Card>
          ) : null}
        </Card>
      </Container>
    </ScrollableSurface>
  );
}
