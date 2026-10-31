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
import { rankActivity } from '../read-data/rank-activity.mjs';

console.log(JSON.stringify(rankActivity(JSON.parse((await text(process.stdin)) || '{}'))));
