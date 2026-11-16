// tools/reply-by-keyword-rule/do-work/decide-the-replies.mjs
//
// tool:decide-the-replies. Says which reply to send now and which to leave, each with its reason, from what the request
// holds: the person's reply rules (`reply-rule` rows, applied in their `order`), the pulled items of one place (the
// threads its pulls kept, or the answers of its pull tools, by channel id in `pulled`), the person's own id at the place
// (`self_id`) and the replies already kept (`reply-kept` rows in `kept`). The person's AI reads those rows from their
// store and gives them here. The place is a row of read-data/reply-places.json; nothing here names one. Reads nothing,
// sends nothing and keeps nothing.
import { chooseReplies } from '../read-data/reply-rules.mjs';
import places from '../read-data/reply-places.json' with { type: 'json' };

export const REPLY_TYPE = 'reply-kept';

export const placeOf = (id, rows = places.places) => {
  const place = rows.find(row => row.id === id);
  if (!place) throw new Error(`${id} is not a place replies go to. Known: ${rows.map(row => row.id).join(', ')}`);
  return place;
};

const rowsOf = (value, name) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) throw new Error(`${name} must be a list of rows, each { id?, value }.`);
  return value;
};

/** The decisions for one place, from what the request holds. A channel with nothing handed in is named under not_pulled. */
export function decideTheReplies(input, _context, deps = {}) {
  const place = placeOf(input.place, deps.places);
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new Error('now must be an ISO time');
  const rules = rowsOf(input.rules, 'rules').map(row => row.value).filter(Boolean).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const pulled = {};
  const not_pulled = [];
  for (const channel of place.channels) {
    if (Array.isArray(input.pulled?.[channel.id])) pulled[channel.id] = input.pulled[channel.id];
    else not_pulled.push(channel.pull.snapshot ?? channel.pull.handed_in.tool);
  }
  if (input.self_id === undefined || input.self_id === null || input.self_id === '') throw new Error(`give self_id: ${place.label} never answers the person's own words, so it needs the person's own id there`);
  const sentKeys = new Set(rowsOf(input.kept, 'kept').filter(row => row.value?.key && row.value.place === place.id).map(row => row.value.key));
  const decisions = chooseReplies({ place, rules, pulled, selfId: String(input.self_id), nowMs, sentKeys });
  return { place: place.id, decisions, not_pulled };
}
