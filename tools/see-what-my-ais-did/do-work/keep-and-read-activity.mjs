// tools/see-what-my-ais-did/do-work/keep-and-read-activity.mjs
//
// What each AI did, as the AI activity screen lists it: the tool calls handed in become activity rows through
// activity.mjs's own activityRow (or unmarkedActivityRow for a call whose tool has no mark, which leaves a row only
// with an execution receipt or work it was done for), read through recordableActivityRow and keptActivityRow, kept
// with keepActivity in an in-memory SQLite database (node:sqlite) laid out by activityTable, and read back newest first
// with readActivity, narrowed by app or to the calls that failed. Which calls leave a row and how each reads is the
// DATA in activity-marks.json. Nothing is kept after the run, no file is written and nothing is sent.
//
// Input:
//   calls  [{ tool, at, input?, result?, error?, app?, description? }]: one tool call each, in the order they happened;
//          `at` is when (ISO text), `error` the words it threw with, `app` the AI app that made it
//   access [string]: the access the person holds (access:decision-kept and the like); an id whose place needs one they
//          do not hold is dropped, as their store drops it. Leave out for none.
//   read   { limit?, app?, failed? }: what to read back (newest first, at most 500)
// Answers { kept: n, left: [{ index, tool, marked, why }], items, next_before, coverage }.
// Refuses no calls, more calls than activity-marks.json's kept_at_once, and a call without a tool or an at.
import { DatabaseSync } from 'node:sqlite';
import marks from '../activity-marks.json' with { type: 'json' };
import { activityRow, keepActivity, keptActivityRow, readActivity, recordableActivityRow, unmarkedActivityRow } from '../activity.mjs';

// The node:sqlite handle in the shape the store's code takes: exec(query, ...params), spread or toArray().
function sqlOver(db) {
  return {
    exec(query, ...params) {
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...params).map(row => ({ ...row })) : (statement.run(...params), []);
      return Object.assign(rows, { toArray: () => rows });
    },
  };
}

export function keepAndReadActivity({ calls, access = [], read = {} } = {}) {
  if (!Array.isArray(calls) || calls.length === 0) throw new Error('Give calls: a list of { tool, at, input?, result?, error?, app? }, one tool call each.');
  if (calls.length > marks.kept_at_once) throw new Error(`At most ${marks.kept_at_once} calls are kept at once; give fewer.`);
  if (!Array.isArray(access) || access.some(item => typeof item !== 'string')) throw new Error('Give access as a list of access names, such as ["access:decision-kept"], or leave it out.');
  const sql = sqlOver(new DatabaseSync(':memory:'));
  const left = [];
  let kept = 0;
  calls.forEach((call, index) => {
    if (!call || typeof call.tool !== 'string' || !call.tool) throw new Error(`Call ${index} needs tool: the tool's name, such as "hand_off".`);
    if (typeof call.at !== 'string' || !call.at) throw new Error(`Call ${index} (${call.tool}) needs at: when it happened, as ISO text.`);
    const made = activityRow(call) ?? unmarkedActivityRow(call);
    const row = keptActivityRow(recordableActivityRow(made), access);
    if (!row) {
      const marked = marks.marks.some(mark => mark.tool === call.tool);
      const why = !made ? 'it made or touched nothing'
        : !recordableActivityRow(made) ? 'its tool has no mark, and it carries no execution receipt and no work it was done for'
          : 'its row needs an access the person does not hold';
      left.push({ index, tool: call.tool, marked, why });
      return;
    }
    keepActivity(sql, row);
    kept += 1;
  });
  return { kept, left, ...readActivity(sql, read ?? {}) };
}
