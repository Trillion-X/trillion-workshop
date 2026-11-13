// tools/reply-by-keyword-rule/do-work/decide-the-replies.mjs
//
// tool:decide-the-replies. Reads the person's reply rules (`reply-rule` records, in their `order`), the pulled items of
// one place (the threads its pulls kept, or the answers of its pull tools handed in as `pulled`), and the replies already
// kept (`reply-kept` records), then says which reply to send now and which to leave, each with its reason. The place
// is a row of read-data/reply-places.json; nothing here names one. Sends nothing and keeps nothing.
import { chooseReplies, fill } from '../read-data/reply-rules.mjs';
import places from '../read-data/reply-places.json' with { type: 'json' };
import { readParts } from '../../pull-from-connected-accounts/read-data/snapshot.mjs';

export const RULE_TYPE = 'reply-rule';
export const REPLY_TYPE = 'reply-kept';
export const CONNECTION_TYPE = 'connection';
export const CONNECTION_PREFIX = 'connection:';

export const placeOf = (id, rows = places.places) => {
  const place = rows.find(row => row.id === id);
  if (!place) throw new Error(`${id} is not a place replies go to. Known: ${rows.map(row => row.id).join(', ')}`);
  return place;
};

/** The decisions for one place, from what its pulls held. A source never pulled is named under not_pulled. */
export async function decideTheReplies(input, { door }, deps = {}) {
  const place = placeOf(input.place, deps.places);
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new Error('now must be an ISO time');
  const account = input.account ?? 'default';
  const rules = [];
  for await (const record of door.list({ type: RULE_TYPE })) if (record.value) rules.push(record.value);
  rules.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const pulled = {};
  const not_pulled = [];
  let selfId = null;
  for (const channel of place.channels) {
    if (channel.pull.snapshot) {
      const parts = await readParts(door, channel.pull.snapshot, account);
      if (!parts.state) { not_pulled.push(channel.pull.snapshot); continue; }
      if (place.self_id.snapshot_state && selfId === null) selfId = parts.state.self_id ?? null;
      pulled[channel.id] = [...parts.threads.values()].map(part => part.thread);
    } else if (Array.isArray(input.pulled?.[channel.id])) {
      pulled[channel.id] = input.pulled[channel.id];
    } else {
      not_pulled.push(channel.pull.handed_in.tool);
    }
  }
  if (place.self_id.plain) {
    if (!input.account_id) throw new Error(`give account_id: ${place.label} names the person's own id in their connection`);
    const connection = await door.read(CONNECTION_TYPE, `${CONNECTION_PREFIX}${encodeURIComponent(input.account_id)}`);
    selfId = connection?.plain?.[place.self_id.plain] ?? null;
    if (!selfId) throw new Error(`${input.account_id} does not say its ${place.self_id.plain.replace(/_/g, ' ')}: connect it again`);
  } else if (place.self_id.snapshot_state && !selfId) {
    throw new Error('this account has no pulled state yet: pull it first');
  }
  const sentKeys = new Set();
  for await (const record of door.list({ type: REPLY_TYPE })) if (record.value?.key && record.value.place === place.id) sentKeys.add(record.value.key);
  const decisions = chooseReplies({ place, rules, pulled, selfId: selfId === null ? null : String(selfId), nowMs, sentKeys });
  return { place: place.id, account, decisions, not_pulled };
}
