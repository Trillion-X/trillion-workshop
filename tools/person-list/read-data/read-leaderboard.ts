// package://packages/person-list/read-data/read-leaderboard.ts
//
// Generic metric aggregation over effect rows. Metric windows, labels, and
// ordering are descriptor data; this code only applies weighted events to
// configured metric descriptors.

export interface EffectRow {
  subject: string;
  kind: string;
  createdAt: string;
}

export interface MetricDescriptor {
  key: string;
  label: string;
  lookbackDays: number | null;
  order?: number;
}

export interface LeaderboardConfig {
  weights: Record<string, number>;
  levels: LevelThreshold[];
  metrics: MetricDescriptor[];
  sortMetricKey: string;
}

export interface LevelThreshold {
  level: number;
  name: string;
  min_points: number;
}

export interface RankedActor {
  actorRef: string;
  metricValues: Record<string, number>;
  rank: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function decodeEffectRows(raw: unknown): EffectRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: EffectRow[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const subject = textValue(item.subject);
    const kind = textValue(item.kind);
    const material = isRecord(item.material) ? item.material : {};
    const createdAt = textValue(material.created_at);
    if (!subject || !kind) continue;
    rows.push({ subject, kind, createdAt });
  }
  return rows;
}

export function decodeMetricDescriptors(raw: unknown): MetricDescriptor[] {
  const source = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.metrics)
      ? raw.metrics
      : [];
  return source
    .filter(isRecord)
    .map((row) => ({
      key: textValue(row.key),
      label: textValue(row.label),
      lookbackDays: row.lookback_days === null || row.lookbackDays === null
        ? null
        : numberValue(row.lookback_days) ?? numberValue(row.lookbackDays),
      order: numberValue(row.order) ?? undefined,
    }))
    .filter((row): row is MetricDescriptor => (
      row.key.length > 0
      && row.label.length > 0
      && (row.lookbackDays === null || typeof row.lookbackDays === 'number')
    ))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key));
}

export function decodeLeaderboardConfig(raw: unknown): LeaderboardConfig | null {
  if (!isRecord(raw)) return null;
  const weights = isRecord(raw.weights) ? raw.weights : null;
  const levels = Array.isArray(raw.levels) ? raw.levels : null;
  if (!weights || !levels) return null;
  const cleanWeights: Record<string, number> = {};
  for (const [key, value] of Object.entries(weights)) {
    if (typeof value === 'number' && Number.isFinite(value)) cleanWeights[key] = value;
  }
  const cleanLevels: LevelThreshold[] = levels
    .filter(isRecord)
    .map((row) => ({
      level: numberValue(row.level) ?? 0,
      name: textValue(row.name),
      min_points: numberValue(row.min_points) ?? 0,
    }))
    .filter((row) => row.level > 0 && row.name.length > 0)
    .sort((a, b) => a.min_points - b.min_points);
  const metrics = decodeMetricDescriptors(raw);
  if (Object.keys(cleanWeights).length === 0 || cleanLevels.length === 0 || metrics.length === 0) {
    return null;
  }
  const sortMetricKey = textValue(raw.sort_metric_key) || textValue(raw.sortMetricKey) || metrics[0].key;
  return { weights: cleanWeights, levels: cleanLevels, metrics, sortMetricKey };
}

export function rankActors(
  rows: readonly EffectRow[],
  weights: Record<string, number>,
  metrics: readonly MetricDescriptor[],
  now: number,
  sortMetricKey = metrics[0]?.key ?? '',
): RankedActor[] {
  const orderedMetrics = [...metrics].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key));
  const byActor = new Map<string, Record<string, number>>();

  for (const row of rows) {
    const weight = weights[row.kind];
    if (typeof weight !== 'number' || weight === 0) continue;
    const at = Date.parse(row.createdAt);
    const values = byActor.get(row.subject) ?? {};
    for (const metric of orderedMetrics) {
      const insideWindow = metric.lookbackDays === null
        || (Number.isFinite(at) && at >= now - metric.lookbackDays * DAY_MS);
      if (!insideWindow) continue;
      values[metric.key] = (values[metric.key] ?? 0) + weight;
    }
    byActor.set(row.subject, values);
  }

  return [...byActor.entries()]
    .map(([actorRef, metricValues]) => ({ actorRef, metricValues, rank: 0 }))
    .sort((a, b) => (
      (b.metricValues[sortMetricKey] ?? 0)
      - (a.metricValues[sortMetricKey] ?? 0)
      || a.actorRef.localeCompare(b.actorRef)
    ))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export function metricValue(row: RankedActor | undefined, key: string): number {
  return row?.metricValues[key] ?? 0;
}

export function levelFor(points: number, levels: readonly LevelThreshold[]): LevelThreshold {
  let current = levels[0];
  for (const level of levels) {
    if (points >= level.min_points) current = level;
  }
  return current;
}
