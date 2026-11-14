//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The `view_kind: 'metric'` RENDERER for visual-database, and the last third of
// the L088 metric decomposition:
//   - packages/ui/show owns the pixels (StatStrip / ScoreRing / MetricRow),
//   - read-data/metric-aggregation.ts owns the value/delta/tone math
//     (computeMetricValues over the SAME extractFieldValue the table/list use),
//   - THIS file owns only the thin wiring: for each `VisualDatabaseMetric
//     Descriptor` DATA card it reduces the view's records through the math owner
//     and feeds the result into the atom the card names.
//
// It re-implements NO aggregation and NO formatting. Every number comes from
// computeMetricValues, so a metric over a derived cell-expression field reuses
// that computed value with zero special casing, exactly like the other views.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The atom is chosen by the card's DATA key through an INJECTED capability
//    map (METRIC_ATOM_RENDERERS). Adding an atom = one map entry; a card whose
//    key the map lacks falls back to the metric-row atom (the descriptor's
//    documented default), never a crash. The deletion test (inject a different
//    atom map, render a card keyed to it) must pass.
// 2. A count over zero records is a valid reading (0), so the empty state fires
//    only when the view configures no metric cards, never on an empty set.
// 3. Typography + surfaces via ui/show atoms + Container/Text only; zero raw
//    HTML, zero inline className (L065).
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Container, Text } from '../../ui';
import { later } from '../../ui/show/load-later/later';
// A metric's trend line is fetched the first time a metric draws one, never with the list.
const Chart = later(() => import('../../ui/show/chart/Chart'), module => module.Chart);
import { chartOfPoints } from '../../ui/show/chart/chart-from-records';
import { StatStrip } from '../../ui/show/stat-strip/StatStrip';
import { ScoreRing } from '../../ui/show/score-ring/ScoreRing';
import { MetricRow } from '../../ui/show/metric-row/MetricRow';
import {
  computeMetricValues,
  metricRowTone,
  type MetricComputation,
} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/metric-aggregation.ts';
import type {
  VisualDatabaseMetricDescriptor,
  VisualDatabaseModel,
  VisualDatabaseRecord,
} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/visual-database.ts';

// ---------------------------------------------------------------------------
// Atom capability map (L090: DATA key selects renderer; injected, not an enum)
// ---------------------------------------------------------------------------

/** Everything an atom renderer needs: the card DATA + its computed readings. */
export interface MetricAtomContext {
  metric: VisualDatabaseMetricDescriptor;
  /** Reductions from computeMetricValues, index-aligned with `metric.values`. */
  computations: readonly MetricComputation[];
}

export type MetricAtomRenderer = (ctx: MetricAtomContext) => React.ReactElement | null;

/** The card DATA `atom` key selects one of these. A key the map lacks resolves
 *  to the metric-row atom (the descriptor default), so the set stays open. */
export const METRIC_ATOM_RENDERERS: Readonly<Record<string, MetricAtomRenderer>> = {
  'stat-strip': ({ metric, computations }) => (
    <StatStrip
      stats={metric.values.map((value, index) => ({
        label: value.label,
        value: computations[index]?.displayValue ?? '',
      }))}
    />
  ),
  'metric-row': ({ metric, computations }) => (
    <MetricRow
      cells={metric.values.map((value, index) => {
        const computation = computations[index];
        return {
          label: value.label,
          value: computation?.displayValue ?? '',
          tone: metricRowTone(computation?.tone ?? 'neutral'),
          ...(value.mono !== undefined ? { mono: value.mono } : {}),
        };
      })}
    />
  ),
  'score-ring': ({ metric, computations }) => {
    const computation = computations[0];
    const primary = metric.values[0];
    if (!computation || computation.value === null) return null;
    return (
      <ScoreRing
        value={computation.value}
        max={metric.max}
        displayValue={computation.displayValue}
        tone={computation.tone}
        label={metric.label ?? primary?.label}
        band={metric.band}
        caption={metric.caption}
        {...(primary?.unit !== undefined ? { unit: primary.unit } : {})}
      />
    );
  },
  'snapshot-card': ({ metric, computations }) => {
    const primary = computations[0];
    const presentation = metric.presentation;
    const trendIndex = presentation?.trendValueId
      ? metric.values.findIndex((value) => value.id === presentation.trendValueId)
      : 1;
    const trend = trendIndex >= 0 ? computations[trendIndex] : undefined;
    const dominant = presentation?.emphasis === 'dominant';
    return (
      <Container
        role="group"
        aria-label={`${metric.label ?? metric.values[0]?.label ?? 'Metric'} ${primary?.displayValue ?? ''}`.trim()}
        layout="vertical"
        gap="sm"
        justifyContent="between"
        minHeight={dominant ? '14rem' : '7rem'}
        padding="md"
        border="all"
        background="primary"
        className={dominant ? 'md:col-span-2 md:row-span-2' : 'md:col-span-1'}
      >
        <Container layout="horizontal" gap="sm" alignItems="start" justifyContent="between">
          <Text variant="label" color="faint">{metric.label ?? metric.values[0]?.label}</Text>
          {trend ? (
            <Text
              variant={dominant ? 'body-lg' : 'body-xs'}
              weight="semibold"
              color={trend.tone === 'critical' ? 'error' : trend.tone === 'caution' ? 'warning' : trend.tone === 'positive' ? 'success' : 'strong'}
              aria-label={presentation?.trendLabel}
            >
              {trend.displayValue}
            </Text>
          ) : null}
        </Container>
        <Text
          variant={dominant ? 'display' : 'heading-2xl'}
          weight="bold"
          color="strong"
          mono
          tabular
        >
          {primary?.displayValue ?? String.fromCharCode(0x2014)}
        </Text>
        {presentation?.sparkline && presentation.sparkline.length > 1 ? (
          <Chart mark="sparkline" height={48} label="Metric trend" data={chartOfPoints([...presentation.sparkline], { label: metric.label ?? 'Trend', tone: 'good' })} />
        ) : null}
        <Container layout="vertical" gap="xs">
          {presentation?.asOf ? (
            <Text variant="caption" color="faint" mono tabular>{presentation.asOf}</Text>
          ) : null}
          {dominant && presentation?.comparison ? (
            <Text variant="caption" color="faint" mono>{presentation.comparison}</Text>
          ) : null}
        </Container>
      </Container>
    );
  },
};

const FALLBACK_ATOM = 'metric-row';

// ---------------------------------------------------------------------------
// The view renderer
// ---------------------------------------------------------------------------

export interface MetricViewProps {
  /** The metric cards from the view descriptor (`view.metrics`). */
  metrics: readonly VisualDatabaseMetricDescriptor[];
  /** The view's scoped record-set (already filtered/searched by the surface). */
  records: readonly VisualDatabaseRecord[];
  /** The model, for field lookup inside the aggregation owner. */
  model: VisualDatabaseModel;
  /** Loading gate: show the loading state instead of computing. */
  loading?: boolean;
  /** Error message: show the error state instead of computing. */
  error?: string | null;
  /**
   * Override or extend the atom capability map. Merged over the built-ins, so a
   * caller can add a brand-new atom kind with zero edits here (deletion test).
   */
  atomRenderers?: Readonly<Record<string, MetricAtomRenderer>>;
}

export function MetricView({
  metrics,
  records,
  model,
  loading = false,
  error = null,
  atomRenderers,
}: MetricViewProps): React.ReactElement {
  const renderers = atomRenderers
    ? { ...METRIC_ATOM_RENDERERS, ...atomRenderers }
    : METRIC_ATOM_RENDERERS;
  const snapshotLayout = metrics.some((metric) => metric.atom === 'snapshot-card');

  if (error) {
    return (
      <Container role="alert" data-testid="metric-view-error" padding="md">
        <Text variant="body-xs" color="muted">{error}</Text>
      </Container>
    );
  }
  if (loading) {
    return (
      <Container role="status" aria-busy="true" data-testid="metric-view-loading" padding="md">
        <Text variant="body-xs" color="faint">Loading metrics</Text>
      </Container>
    );
  }
  if (metrics.length === 0) {
    return (
      <Container role="status" data-testid="metric-view-empty" padding="md">
        <Text variant="body-xs" color="faint">No metrics configured yet</Text>
      </Container>
    );
  }

  return (
    <Container
      role="group"
      aria-label="Metrics"
      data-testid="metric-view"
      layout={snapshotLayout ? 'grid' : 'vertical'}
      gridCols={snapshotLayout ? 2 : undefined}
      gap="md"
      padding="md"
      className={snapshotLayout ? 'md:grid-cols-6' : undefined}
    >
      {metrics.map((metric) => {
        const computations = computeMetricValues(metric, records, model);
        const renderer = renderers[metric.atom] ?? renderers[FALLBACK_ATOM];
        return (
          <Container key={metric.id} layout="vertical" gap="xs" data-testid={`metric-block-${metric.atom}`} className={metric.atom === 'snapshot-card' ? 'contents' : undefined}>
            {metric.label && metric.atom !== 'snapshot-card' ? (
              <Text variant="caption" color="faint">{metric.label}</Text>
            ) : null}
            {renderer ? renderer({ metric, computations }) : null}
          </Container>
        );
      })}
    </Container>
  );
}
