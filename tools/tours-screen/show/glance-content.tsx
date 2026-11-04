// parts/guided-overlay/show/glance-content.tsx
//
// The `glance` step content: one card at a glance (the shared listing card: the thing's icon on a toned tile, its
// title, when, the one key value, icon-led facts, chips, a badge or a signal), and optionally a small chart under it
// (`bars`: one bar per point, `split`: shares of a whole), instead of a heading and a paragraph. An AI writing a tour
// fills these fields (src/tours.json card_kinds); nothing here names a field's meaning.
//
// Each point's tone (good, attention, bad, info, quiet) picks a bar colour through guided-overlay-defaults.json
// (`glance.chart_tones` for bars drawn by the shared chart, `glance.tone_variants` for the split bar), so the words of a
// tone are DATA.

import type { ReactElement } from 'react';
import { ListingCard, type Listing } from '../../ui/show/listing-card';
import { Chart } from '../../ui/show/chart/Chart';
import { Bar, type BarSegment } from '../../ui/show/bar/Bar';
import { Container } from '../../ui/show/container/container';
import type { StepContentProps } from '../../ui/show/step-content-renderer/StepContent';
import defaults from '../guided-overlay-defaults.json';

type Point = { label: string; value: number; tone?: string };
type Variant = BarSegment['variant'];

const variantOf = (tone: unknown): Variant => {
  const map = defaults.glance.tone_variants as Record<string, Variant>;
  return map[typeof tone === 'string' ? tone : ''] ?? map.quiet ?? 'neutral';
};

function pointsOf(chart: unknown): Point[] {
  const raw = chart && typeof chart === 'object' ? (chart as { points?: unknown }).points : null;
  return (Array.isArray(raw) ? raw : []).flatMap((point) => {
    const row = point && typeof point === 'object' ? (point as Record<string, unknown>) : {};
    const value = Number(row.value);
    if (!Number.isFinite(value) || value < 0) return [];
    return [{ label: typeof row.label === 'string' ? row.label : '', value, ...(typeof row.tone === 'string' ? { tone: row.tone } : {}) }];
  }).slice(0, defaults.glance.chart_points_max);
}

function GlanceChart({ chart }: { chart: unknown }): ReactElement | null {
  const points = pointsOf(chart);
  if (!points.length) return null;
  const kind = (chart as { kind?: unknown }).kind;
  if (kind === 'split') {
    const total = points.reduce((sum, point) => sum + point.value, 0) || 1;
    return (
      <Bar
        data-walkthrough-chart="split"
        height="sm"
        segments={points.map((point) => ({ percent: (point.value / total) * 100, variant: variantOf(point.tone), title: `${point.label} ${point.value}` }))}
      />
    );
  }
  const tones = defaults.glance.chart_tones as Record<string, string>;
  return (
    <Container data-walkthrough-chart="bars">
      <Chart
        mark="bar"
        bare
        height={48}
        label={points.map((point) => `${point.label} ${point.value}`).join(', ')}
        data={{
          slots: points.map((point, index) => ({ key: String(index), label: point.label })),
          series: [{ id: 'points', label: '', values: points.map((point) => point.value), tones: points.map((point) => tones[point.tone ?? ''] ?? tones.quiet) }],
          value_kind: 'number',
        }}
      />
    </Container>
  );
}

/** One glance card, plus its chart when it has one. The tour's own buttons answer it, so a card's actions are not drawn. */
export function GlanceContent({ payload }: StepContentProps): ReactElement {
  const { chart, actions: _actions, ...fields } = payload as Record<string, unknown>;
  const listing = { ...fields, id: typeof fields.id === 'string' ? fields.id : 'step', title: typeof fields.title === 'string' ? fields.title : '' } as Listing;
  return (
    <Container layout="vertical" gap="sm" data-walkthrough-glance="">
      <ListingCard listing={listing} className="border-0 bg-transparent p-0 shadow-none" />
      {chart ? <GlanceChart chart={chart} /> : null}
    </Container>
  );
}
