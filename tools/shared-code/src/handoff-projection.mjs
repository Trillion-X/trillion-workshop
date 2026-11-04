// Request-bound handoff projection; the default remains the complete record.
// Selection, filtering and card identity fields survive every projection. Presence
// is exact !== undefined, including null, false, objects and arrays as present.
const REQUIRED = ['handoff_id', 'handed_at', 'state', 'from_agent', 'to_agent', 'taken_by', 'preferred_agent', 'in_the_way_by'];
export function handoffProjection(projection) {
  if (projection === null || projection === undefined) return null;
  if (!projection || !Array.isArray(projection.fields) || projection.fields.some(field => typeof field !== 'string' || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(field) || field === 'field_presence')) throw new Error('Projection fields must be top-level field names.');
  const presence = projection.presence ?? [];
  if (!Array.isArray(presence) || presence.some(path => !Array.isArray(path) || !path.length || path.some(field => typeof field !== 'string' || !field))) throw new Error('Projection presence must name nonempty field paths.');
  return { fields: [...new Set([...REQUIRED, ...projection.fields])], presence: presence.map(path => [...path]) };
}
export function pathPresent(value, path) {
  for (const field of path) { if (value === null || value === undefined) return false; value = value[field]; }
  return value !== undefined;
}
export function projectHandoff(item, projection) {
  if (!item || !projection) return item;
  const out = {};
  for (const field of projection.fields) if (item[field] !== undefined) out[field] = item[field];
  // Owners that already projected carry their exact presence answer; fallback
  // owners compute it before dropping the original result or other path parents.
  out.field_presence = item.field_presence ?? projection.presence.map(path => pathPresent(item, path));
  return out;
}
// What the task map draws of a job (src/message-task-canvas.mjs messageTaskGraph, as the Task map screen walks it from a
// message to the files and decisions its work leads to): the links from its message, follow-up, parent and decision, and
// its state and time. Never its words, title, results or other input: the screen shows none of a job's own, and they are
// most of what a job keeps. Absent and null are left out.
export const TASK_MAP_FIELDS = ['handoff_id', 'parent_handoff_id', 'case_id', 'state', 'handed_at'];
export const TASK_MAP_ARRIVED = ['message_id', 'asked_id'];
// And of an arrival: which message it came from and the files it brought, which the map opens by name.
export const TASK_MAP_ARRIVAL_FIELDS = ['message_id', 'files'];
export function taskMapHandoff(item) {
  if (!item) return item;
  const out = {};
  for (const field of TASK_MAP_FIELDS) if (item[field] !== undefined && item[field] !== null) out[field] = item[field];
  const arrived = {};
  for (const field of TASK_MAP_ARRIVED) {
    const value = item.input?.arrived?.[field];
    if (value !== undefined && value !== null) arrived[field] = value;
  }
  if (Object.keys(arrived).length) out.input = { arrived };
  return out;
}
