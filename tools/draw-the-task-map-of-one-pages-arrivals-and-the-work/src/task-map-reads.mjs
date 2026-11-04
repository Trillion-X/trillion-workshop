// src/task-map-reads.mjs
//
// What the Task map (src/workspace/message-task-canvas-screen.tsx) draws of one page's arrivals and work, read for
// both stores that answer it (src/person-store.mjs and src/native-resource-screen-behavior.mjs messageTaskCanvas).
// The map walks messageTaskGraph (src/message-task-canvas.mjs) from each message to the files and decisions its
// arrivals and work lead to; it shows no arrival's or job's own words, title, results or other input. Those words are most of what
// an arrival or job keeps (100 jobs and their arrivals read whole were about 3 MB of the map's first read, 2026-10-16),
// so they are never read: an index entry that carries the drawn fields answers alone (src/record-indexes.json arrival
// message_id, agent-handoff newest), and a record kept before its entry carried them is read by those fields.
//
//   drawnArrivals(records, messageIds) -> [{ id, message_id, files? }] in the messages' order, each
//     message's arrivals in id order (as arrivalsOf finds them); absent and null fields are left out.
//   drawnWork(claims, messageIds, { first }) -> each job once (src/handoff-projection.mjs taskMapHandoff): the work of
//     these messages and the work handed on from it, and on the first page the newest 100 jobs, which no message may own.
import { TASK_MAP_ARRIVAL_FIELDS } from '../../shared-code/src/handoff-projection.mjs';

const drawn = (id, value) => {
  const out = { id };
  for (const field of TASK_MAP_ARRIVAL_FIELDS) if (value?.[field] !== undefined && value[field] !== null) out[field] = value[field];
  return out;
};

export function drawnArrivals(records, messageIds) {
  const entries = messageIds.flatMap(message_id => records.scan('arrival', 'message_id', { equal: [message_id], all: true, carried: true }));
  if (!entries.length) return [];
  const covered = records.indexCovered('arrival', 'message_id', entries.map(entry => entry.id));
  const missing = entries.filter(entry => !covered.has(entry.id)).map(entry => entry.id);
  const own = missing.length ? records.fields.projectOf('arrival', missing, { fields: TASK_MAP_ARRIVAL_FIELDS }) : new Map();
  return entries.flatMap(({ id, values: [message_id], carried }) => covered.has(id) ? [drawn(id, { ...carried, message_id })]
    : own.has(id) ? [drawn(id, own.get(id).fields)] : []);
}

export function drawnWork(claims, messageIds, { first }) {
  const ofMessages = messageIds.flatMap(id => claims.fromMessage(id, { taskMap: true }));
  const parts = ofMessages.length ? [...claims.handedOnFromMany(ofMessages.map(item => item.handoff_id), { taskMap: true }).values()].flat() : [];
  return [...new Map([...(first ? claims.newestHandoffs(100, { taskMap: true }) : []), ...ofMessages, ...parts].map(item => [item.handoff_id, item])).values()];
}
