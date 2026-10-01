// tools/person-list/do-work/rank-people.mjs
//
// Ranks people by the points their activity earns (each kind of activity worth its weight), counted over windows such
// as all time and the last 7 days, and gives each person the level their points reach. Run by the Workshop tool
// `tool:rank-people-by-activity` in the tool container:
//
//   node do-work/rank-people.mjs < <the input as JSON>
//
// `activity` is [{ person, kind, at }]; `weights`, `metrics` ({ key, label, lookback_days: number or null }), `levels`
// ({ level, name, min_points }) and `rank_by` (a metric key) are the scoring. Prints { ranked } on its last line.
import { text } from 'node:stream/consumers';
import { decodeLeaderboardConfig, levelFor, metricValue, rankActors } from '../read-data/read-leaderboard.ts';

const input = JSON.parse((await text(process.stdin)) || '{}');
const config = decodeLeaderboardConfig({ weights: input.weights, levels: input.levels, metrics: input.metrics, sort_metric_key: input.rank_by });
if (!config) throw new Error('Scoring needs weights (a number per kind of activity), levels ({ level, name, min_points }) and metrics ({ key, label, lookback_days }).');
const rows = (input.activity ?? []).map(item => ({ subject: String(item?.person ?? ''), kind: String(item?.kind ?? ''), createdAt: String(item?.at ?? '') })).filter(row => row.subject && row.kind);
const now = input.now ? Date.parse(input.now) : Date.now();
const ranked = rankActors(rows, config.weights, config.metrics, now, config.sortMetricKey).map(row => {
  const points = metricValue(row, config.sortMetricKey);
  const level = levelFor(points, config.levels);
  return { person: row.actorRef, rank: row.rank, points, metrics: row.metricValues, level: { level: level.level, name: level.name } };
});
console.log(JSON.stringify({ ranked, rank_by: config.sortMetricKey }));
