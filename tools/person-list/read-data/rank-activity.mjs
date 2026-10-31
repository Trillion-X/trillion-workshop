// tools/person-list/read-data/rank-activity.mjs
//
// The scoring both ranking tools share: what people did ({ person, kind, at }) in, ranked people with points, every
// count and level out. Pure: the caller hands it the activity, whether from the input or from the person's records.
import { decodeLeaderboardConfig, levelFor, metricValue, rankActors } from './read-leaderboard.ts';

/** { activity, weights, metrics, levels, rank_by?, now? } -> { ranked, rank_by } */
export function rankActivity(input) {
  const config = decodeLeaderboardConfig({ weights: input.weights, levels: input.levels, metrics: input.metrics, sort_metric_key: input.rank_by });
  if (!config) throw new Error('Scoring needs weights (a number per kind of activity), levels ({ level, name, min_points }) and metrics ({ key, label, lookback_days }).');
  const rows = (input.activity ?? []).map(item => ({ subject: String(item?.person ?? ''), kind: String(item?.kind ?? ''), createdAt: String(item?.at ?? '') })).filter(row => row.subject && row.kind);
  const now = input.now ? Date.parse(input.now) : Date.now();
  const ranked = rankActors(rows, config.weights, config.metrics, now, config.sortMetricKey).map(row => {
    const points = metricValue(row, config.sortMetricKey);
    const level = levelFor(points, config.levels);
    return { person: row.actorRef, rank: row.rank, points, metrics: row.metricValues, level: { level: level.level, name: level.name } };
  });
  return { ranked, rank_by: config.sortMetricKey };
}
