// tools/reply-by-keyword-rule/do-work/send-a-reply.mjs
//
// tool:send-a-reply-on-<place>. Sends one chosen reply (`input.decision`, from tool:decide-the-replies) the way its place
// row says (read-data/reply-places.json: the channel's request, the hosts the held token may go to), with the account's
// held access token placed only on that request. One send row per place, because each place's connection holds its own
// values; every row runs this one export.
//
// Non-negotiable invariants
//   1. The place's window is checked again here, at the moment of sending. A closed window sends nothing.
//   2. One record per reply key, written before the request leaves (`sending`). A key that has any record is never sent
//      again by this row. A reply whose outcome is not known is kept as `not-known` and waits for a person to look.
//   3. The only hosts reached are the place row's. The token never enters a record, a log or an answer.
//   4. Nothing here names a place.
import { readFileSync } from 'node:fs';
import { checkSend, fill, pick } from '../read-data/reply-rules.mjs';
import { REPLY_TYPE, placeOf } from './decide-the-replies.mjs';
import { segment } from '../../pull-from-connected-accounts/read-data/snapshot.mjs';

const recordIdOf = (place, key) => `${REPLY_TYPE}:${segment(place)}:${segment(key)}`;

/**
 * A chosen reply sent once. `deps` is for tests: `read` gives the held token from its descriptor, `send` is fetch,
 * `nowMs` is the time of the send, `places` the place rows.
 */
export async function sendAReply(input, { door }, deps = {}) {
  const read = deps.read ?? (fd => readFileSync(fd, 'utf8').trim());
  const send = deps.send ?? fetch;
  const nowMs = deps.nowMs ?? Date.now();
  const decision = input.decision;
  if (decision?.action !== 'send') throw new Error('only a decision whose action is send can be sent');
  const place = placeOf(decision.place, deps.places);
  const channel = place.channels.find(item => item.id === decision.kind);
  if (!channel) return { status: 'refused', reason: 'unknown-kind', key: decision.key };
  const id = recordIdOf(place.id, decision.key);
  if (await door.readRecord(REPLY_TYPE, id)) return { status: 'already-sent', key: decision.key };
  const window = checkSend({ ...decision, window_ms: channel.window_ms ?? null }, nowMs);
  if (!window.ok) return { status: 'refused', reason: window.reason, key: decision.key };
  const url = new URL(fill(channel.request.url, decision));
  if (!place.send.hosts.includes(url.hostname)) return { status: 'refused', reason: 'host-not-allowed', key: decision.key };
  const body = JSON.stringify(fill(channel.request.body, decision));
  const keep = async value => door.write([{ id, type: REPLY_TYPE, value: { key: decision.key, place: place.id, account_id: input.account_id, ...value } }], { key: `${id}:${value.state}` });
  await keep({ state: 'sending', started_at: new Date(nowMs).toISOString() });
  let response;
  try {
    response = await send(url.href, {
      method: channel.request.method,
      headers: fill(place.send.headers, { token: read(place.send.token_descriptor) }),
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(place.send.timeout_ms),
    });
  } catch {
    await keep({ state: 'not-known', message: `the request did not get an answer; look on ${place.label} before sending again` });
    return { status: 'not-known', key: decision.key };
  }
  const payload = await response.json().catch(() => null);
  const sentId = pick(payload, channel.request.id_path);
  if (!response.ok || !sentId) {
    const said = pick(payload, channel.request.error_path);
    const reason = typeof said === 'string' ? said : `${place.label} answered ${response.status}`;
    await keep({ state: 'failed', message: reason });
    return { status: 'failed', key: decision.key, said: reason };
  }
  await keep({ state: 'sent', message_id: String(sentId), sent_at: new Date(nowMs).toISOString() });
  return { status: 'sent', key: decision.key, message_id: String(sentId) };
}
