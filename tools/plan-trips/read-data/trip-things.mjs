// tools/plan-trips/read-data/trip-things.mjs
//
// What is still open on a trip, in the order to deal with it. The trip is a list of lanes (what the person plans in:
// a schedule, a packing list, bookings, anything), each lane a list of rows. The person's policy says how urgent each
// status is; the code knows no status, no lane and no urgency of its own.
//
//   request: { policy, lanes: [{ id, label?, rows: [row] }], trip_name? }
//   row:     { id, title?, status?, group?, kind?, day_order?, day_date?, starts_at?, ends_at? }
//   policy:  { priority_order: ["most urgent", ..., "closed"],
//              lanes: { <lane id>: { default_status?, default_priority, priority_by_status?, sort_by? } } }
//
// priority_order runs from the most urgent name to the one that means "nothing left to do"; a row whose priority is
// the last name is closed. A status the lane's priority_by_status does not list takes default_priority.

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : '');
const words = value => value.replace(/[-_:.]+/g, ' ').replace(/\s+/g, ' ').trim();

export function readPolicy(policy) {
  if (!isObject(policy)) throw new Error('policy must be an object with priority_order and lanes: the person says how urgent each status is.');
  const order = policy.priority_order;
  if (!Array.isArray(order) || order.length < 2 || order.some(name => typeof name !== 'string' || !name) || new Set(order).size !== order.length) {
    throw new Error('policy.priority_order must list at least two different names, the most urgent first and the one that means closed last.');
  }
  if (!isObject(policy.lanes) || Object.keys(policy.lanes).length === 0) throw new Error('policy.lanes must give each lane its default_priority and optional priority_by_status.');
  const lanes = {};
  for (const [id, lane] of Object.entries(policy.lanes)) {
    if (!isObject(lane) || !order.includes(lane.default_priority)) throw new Error(`policy.lanes.${id}.default_priority must be one of ${order.join(', ')}.`);
    const byStatus = lane.priority_by_status ?? {};
    if (!isObject(byStatus)) throw new Error(`policy.lanes.${id}.priority_by_status must map a status to a priority name.`);
    for (const [status, priority] of Object.entries(byStatus)) {
      if (!order.includes(priority)) throw new Error(`policy.lanes.${id}.priority_by_status.${status} is ${JSON.stringify(priority)}, which is not in priority_order.`);
    }
    const sortBy = lane.sort_by ?? [];
    if (!Array.isArray(sortBy) || sortBy.some(name => typeof name !== 'string' || !name)) throw new Error(`policy.lanes.${id}.sort_by must list row field names.`);
    lanes[id] = { defaultStatus: text(lane.default_status), defaultPriority: lane.default_priority, byStatus, sortBy };
  }
  return { order, closed: order[order.length - 1], lanes };
}

// Rows are compared one named field at a time: numbers as numbers, text by locale, a missing value after every present one.
function compareField(a, b) {
  const missing = value => value === undefined || value === null || value === '';
  if (missing(a) || missing(b)) return Number(missing(a)) - Number(missing(b));
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function readRow(row, laneId, policy) {
  if (!isObject(row)) return { why: 'the row is not an object' };
  const id = text(row.id);
  if (!id) return { why: 'the row has no id' };
  const status = text(row.status) || policy.defaultStatus;
  const priority = policy.byStatus[status] ?? policy.defaultPriority;
  const start = text(row.starts_at);
  const end = text(row.ends_at);
  return {
    row: {
      id: `${laneId}:${id}`,
      source_id: id,
      lane: laneId,
      title: text(row.title) || id,
      status,
      priority,
      detail: [words(text(row.kind)), words(text(row.group)), text(row.day_date), start && end ? `${start} - ${end}` : start].filter(Boolean),
      ...(start ? { time_label: start } : {}),
    },
    sort: policy.sortBy.map(field => row[field]),
  };
}

export function rankOpenTripThings(request) {
  if (!isObject(request)) throw new Error('The request must be an object with policy and lanes.');
  const policy = readPolicy(request.policy);
  if (!Array.isArray(request.lanes) || request.lanes.length === 0) throw new Error('lanes must list the trip\'s lanes, each { id, rows }.');
  const rank = new Map(policy.order.map((name, index) => [name, index]));
  const laneIds = new Set();
  const skipped = [];
  const entries = [];
  const lanes = request.lanes.map((lane, laneIndex) => {
    const id = isObject(lane) ? text(lane.id) : '';
    if (!id || laneIds.has(id)) throw new Error(`lanes[${laneIndex}] needs an id of its own.`);
    laneIds.add(id);
    const laneRule = policy.lanes[id];
    if (!laneRule) throw new Error(`The policy has no rule for lane ${id}: it says how urgent each status is, so without it the lane is not ranked.`);
    if (!Array.isArray(lane.rows)) throw new Error(`lanes[${laneIndex}].rows must be a list.`);
    const read = lane.rows.map((row, rowIndex) => {
      const item = readRow(row, id, laneRule);
      if (item.why) skipped.push({ lane: id, index: rowIndex, why: item.why });
      return item.row ? { ...item, laneIndex } : null;
    }).filter(Boolean);
    entries.push(...read);
    return { id, label: text(lane.label) || id, count: read.length, open_count: read.filter(item => item.row.priority !== policy.closed).length };
  });
  entries.sort((a, b) => rank.get(a.row.priority) - rank.get(b.row.priority)
    || a.laneIndex - b.laneIndex
    || a.sort.reduce((found, value, index) => found || compareField(value, b.sort[index]), 0)
    || a.row.source_id.localeCompare(b.row.source_id));
  const items = entries.map(entry => entry.row);
  const open = items.filter(item => item.priority !== policy.closed);
  return {
    trip_name: text(request.trip_name) || null,
    items,
    focus: open[0] ?? null,
    later: open.slice(1),
    lanes,
    skipped,
  };
}
