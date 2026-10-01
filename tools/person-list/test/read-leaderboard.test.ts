// Vendored unchanged except for import paths from bitfield-packages/packages/person-list/read-data/read-leaderboard.test.ts.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  decodeEffectRows,
  decodeLeaderboardConfig,
  decodeMetricDescriptors,
  levelFor,
  metricValue,
  rankActors,
  type EffectRow,
  type MetricDescriptor,
} from '../read-data/read-leaderboard.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-10T12:00:00Z');

function row(subject: string, kind: string, daysAgo: number): EffectRow {
  return { subject, kind, createdAt: new Date(NOW - daysAgo * DAY_MS).toISOString() };
}

const WEIGHTS = { post_created: 5, comment_added: 3, like_given: 1 };
const LEVELS = [
  { level: 1, name: 'Member', min_points: 0 },
  { level: 2, name: 'Contributor', min_points: 10 },
  { level: 3, name: 'Regular', min_points: 30 },
];
const METRICS: MetricDescriptor[] = [
  { key: 'recent', label: 'Recent', lookbackDays: 7, order: 1 },
  { key: 'month', label: 'Month', lookbackDays: 30, order: 2 },
  { key: 'total', label: 'Total', lookbackDays: null, order: 3 },
];

describe('decodeEffectRows', () => {
  it('keeps well-formed rows and drops junk', () => {
    expect(decodeEffectRows([
      { subject: 'actor:a', kind: 'post_created', material: { created_at: '2026-06-01T00:00:00Z' } },
      { subject: '', kind: 'post_created', material: {} },
      null,
    ])).toEqual([
      { subject: 'actor:a', kind: 'post_created', createdAt: '2026-06-01T00:00:00Z' },
    ]);
  });
});

describe('decodeMetricDescriptors', () => {
  it('decodes arbitrary metric windows from data', () => {
    expect(decodeMetricDescriptors({
      metrics: [
        { key: 'total', label: 'Total', lookback_days: null, order: 2 },
        { key: 'recent', label: 'Recent', lookback_days: 3, order: 1 },
      ],
    })).toEqual([
      { key: 'recent', label: 'Recent', lookbackDays: 3, order: 1 },
      { key: 'total', label: 'Total', lookbackDays: null, order: 2 },
    ]);
  });
});

describe('decodeLeaderboardConfig', () => {
  it('decodes weights, levels, metrics, and sort key', () => {
    const config = decodeLeaderboardConfig({
      weights: { post_created: 5, junk: 'x' },
      levels: [
        { level: 2, name: 'Contributor', min_points: 10 },
        { level: 1, name: 'Member', min_points: 0 },
      ],
      metrics: [{ key: 'total', label: 'Total', lookback_days: null }],
      sort_metric_key: 'total',
    });
    expect(config).not.toBeNull();
    expect(config?.weights).toEqual({ post_created: 5 });
    expect(config?.levels.map((level) => level.name)).toEqual(['Member', 'Contributor']);
    expect(config?.metrics.map((metric) => metric.key)).toEqual(['total']);
    expect(config?.sortMetricKey).toBe('total');
  });

  it('rejects malformed payloads', () => {
    expect(decodeLeaderboardConfig(null)).toBeNull();
    expect(decodeLeaderboardConfig({ weights: { a: 1 }, levels: LEVELS })).toBeNull();
  });
});

describe('rankActors', () => {
  it('applies weights and orders by configured sort metric', () => {
    const ranked = rankActors(
      [row('actor:a', 'post_created', 1), row('actor:b', 'like_given', 1), row('actor:b', 'comment_added', 1)],
      WEIGHTS,
      METRICS,
      NOW,
      'total',
    );
    expect(ranked.map((item) => [item.actorRef, metricValue(item, 'total'), item.rank])).toEqual([
      ['actor:a', 5, 1],
      ['actor:b', 4, 2],
    ]);
  });

  it('buckets every configured metric without code-defined field names', () => {
    const ranked = rankActors(
      [row('actor:a', 'post_created', 1), row('actor:a', 'post_created', 10), row('actor:a', 'post_created', 40)],
      WEIGHTS,
      METRICS,
      NOW,
      'total',
    );
    expect(ranked[0]?.metricValues).toEqual({ recent: 5, month: 10, total: 15 });
  });

  it('supports a non-score aggregation label by changing only descriptor data', () => {
    const metrics = [{ key: 'responses', label: 'Responses', lookbackDays: null }];
    const ranked = rankActors([row('record:a', 'comment_added', 1)], WEIGHTS, metrics, NOW, 'responses');
    expect(metricValue(ranked[0], 'responses')).toBe(3);
  });
});

describe('levelFor', () => {
  it('resolves the highest reached threshold', () => {
    expect(levelFor(0, LEVELS).name).toBe('Member');
    expect(levelFor(10, LEVELS).name).toBe('Contributor');
    expect(levelFor(31, LEVELS).name).toBe('Regular');
  });
});
