// tools/what-would-it-do-for-a-pursuit/read-data/closest-tools.mjs
//
// What the platform would do for a pursuit: the pursuit's words checked, and the tools and workflows closest to it picked from the
// moves table, ported from the old src/pursuit-plan.mjs at b6ae0ebf815f (pursuitWords: the limits in handlePursuitPlanRequest;
// answerFromMoves). Pure: the caller hands in the vector of the pursuit, the moves table and the rows; nothing here reads a
// store or calls a model.
import { PURSUIT_PLAN_RULES } from './pursuit-plan-rules.mjs';

const { limits, moves: moveRules } = PURSUIT_PLAN_RULES;
const dot = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; };
const rounded = value => Math.round(value * 100) / 100;

/** The pursuit in the person's own words, 3 to 300 characters. */
export function pursuitWords(value) {
  const words = typeof value === 'string' ? value.trim() : '';
  if (words.length < limits.pursuit_min_chars || words.length > limits.pursuit_max_chars) {
    throw new Error(`Describe the pursuit in ${limits.pursuit_min_chars} to ${limits.pursuit_max_chars} characters.`);
  }
  return words;
}

const recordingFor = (list, id) => list.find(recording => (recording.shows ?? []).includes(id)) ?? null;

/** The answer for one pursuit: first_moves (one row for each of the first `count` picked moves), then workflows, tools and screens. */
export function answerFromMoves(table, vector, rowsById, list = []) {
  const scored = table.moves.map(move => ({ move, closeness: dot(vector, move.vector) })).sort((a, b) => b.closeness - a.closeness);
  // A grown move's words are a listing's own words, so the pursuit must come as close to it as to a row it would show directly.
  const line = move => (move.grown_from ? Math.max(moveRules.pick_min, moveRules.direct_min) : moveRules.pick_min);
  const picked = scored.filter(({ move, closeness }) => closeness >= line(move) && closeness >= (scored[0]?.closeness ?? 0) * moveRules.pick_ratio);
  const withRecording = (row, closeness) => ({ ...row, closeness, recording: row.recording ?? recordingFor(list, row.id) });
  // A move's rows are those at least row_ratio as close to it as its closest row.
  const rowsOf = move => move.rows.filter(row => rowsById.get(row.id) && row.closeness >= (move.rows[0]?.closeness ?? 0) * moveRules.row_ratio);
  const used = new Set();
  const firstMoves = [];
  for (const { move } of picked) {
    if (firstMoves.length >= moveRules.count) break;
    const choice = rowsOf(move).find(row => !used.has(row.id) && rowsById.get(row.id).kind !== 'recording');
    if (!choice) continue;
    used.add(choice.id);
    firstMoves.push({ id: move.id, label: move.label ?? move.id, row: withRecording(rowsById.get(choice.id), choice.closeness) });
  }
  const lists = { workflow: [], tool: [], recording: [] };
  const room = { workflow: limits.workflows, tool: limits.tools, recording: limits.screens };
  // A row whose own words are at least direct_min close to the pursuit shows too, ahead of the rest.
  const direct = [];
  for (let at = 0; at < (table.rows?.length ?? 0); at++) {
    const closeness = dot(vector, table.vectors.subarray(at * table.dimensions, (at + 1) * table.dimensions));
    if (closeness >= moveRules.direct_min && rowsById.get(table.rows[at])) direct.push({ row: { id: table.rows[at], closeness: rounded(closeness) }, strength: 1 + closeness });
  }
  const candidates = [...direct, ...picked.flatMap(({ move, closeness }) => rowsOf(move).map(row => ({ row, strength: closeness * row.closeness })))].sort((a, b) => b.strength - a.strength);
  for (const { row: choice } of candidates) {
    const row = rowsById.get(choice.id);
    if (used.has(row.id) || lists[row.kind].length >= room[row.kind]) continue;
    used.add(row.id);
    lists[row.kind].push(withRecording(row, choice.closeness));
  }
  return { first_moves: firstMoves, workflows: lists.workflow, tools: lists.tool, screens: lists.recording };
}
