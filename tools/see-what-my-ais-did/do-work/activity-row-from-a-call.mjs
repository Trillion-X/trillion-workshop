// tools/see-what-my-ais-did/do-work/activity-row-from-a-call.mjs
//
// The step that turns one tool call an AI made into the activity row the person keeps, ported from the old command
// keep-and-read-activity.mjs, removed in 3c0fc7198; tool:keep-an-ai-activity-row calls it through do-work/activity-in-database.mjs. Which calls leave a row and how each reads is the DATA in
// tools/shared-code/src/activity-marks.json; the rules are activityRow, unmarkedActivityRow, recordableActivityRow and
// keptActivityRow in tools/shared-code/src/activity.mjs. This file only shapes one call and says why a call left no row.
import { activityRow, keptActivityRow, recordableActivityRow, unmarkedActivityRow } from '../../shared-code/src/activity.mjs';
import marks from '../../shared-code/src/activity-marks.json' with { type: 'json' };

export class CallError extends Error {}

/**
 * The row one call leaves for the person holding `access` (a list of access names), or { left } saying why it left none:
 * { row, marked } when it leaves one, { left: { tool, marked, why } } when it does not.
 */
export function rowFromCall(call, access = []) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) throw new CallError('Give call: one tool call { tool, at, input?, result?, error?, app? }.');
  if (typeof call.tool !== 'string' || !call.tool) throw new CallError('call.tool must name the tool the AI called, such as "hand_off".');
  if (typeof call.at !== 'string' || !call.at) throw new CallError('call.at must say when it happened, as ISO text.');
  if (!Array.isArray(access) || access.some(item => typeof item !== 'string')) {
    throw new CallError('Give access as a list of access names, such as ["access:decision-kept"], or leave it out.');
  }
  const made = activityRow(call) ?? unmarkedActivityRow(call);
  const row = keptActivityRow(recordableActivityRow(made), access);
  if (row) return { row, marked: marks.marks.some(mark => mark.tool === call.tool) };
  const why = !made ? 'it made or touched nothing'
    : !recordableActivityRow(made) ? 'its tool has no mark, and it carries no execution receipt and no work it was done for'
      : 'its row needs an access the person does not hold';
  return { left: { tool: call.tool, marked: marks.marks.some(mark => mark.tool === call.tool), why } };
}
