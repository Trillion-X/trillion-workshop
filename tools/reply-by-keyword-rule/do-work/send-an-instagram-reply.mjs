// tools/reply-by-keyword-rule/do-work/send-an-instagram-reply.mjs
//
// tool:send-an-instagram-reply. Sends one chosen reply to one person (a direct message) or one comment (a private
// reply) through the Instagram messaging API, with the account's held access token placed only on that request.
//
// Non-negotiable invariants
//   1. The Meta window is checked again here, at the moment of sending. A closed window sends nothing.
//   2. One record per reply key, written before the request leaves (`sending`). A key that has any record is never sent
//      again by this row. A reply whose outcome is not known is kept as `not-known` and waits for a person to look.
//   3. The only host reached is graph.instagram.com. The token never enters a record, a log or an answer.
import { readFileSync } from 'node:fs';
import { checkSend } from '../read-data/reply-rules.mjs';
import { REPLY_TYPE } from './decide-the-replies.mjs';
import { segment } from '../../pull-from-connected-accounts/read-data/snapshot.mjs';

export const MESSAGES_URL = 'https://graph.instagram.com/v21.0/me/messages';
const TOKEN_DESCRIPTOR = 4;
const TIMEOUT_MS = 20000;

const recordIdOf = key => `${REPLY_TYPE}:${segment(key)}`;

/**
 * A chosen reply (`input.decision`, from tool:decide-the-instagram-replies) sent once. `deps` is for tests: `read` gives
 * the held token from its descriptor, `send` is fetch, `nowMs` is the time of the send.
 */
export async function sendAnInstagramReply(input, { door }, deps = {}) {
  const read = deps.read ?? (fd => readFileSync(fd, 'utf8').trim());
  const send = deps.send ?? fetch;
  const nowMs = deps.nowMs ?? Date.now();
  const decision = input.decision;
  if (decision?.action !== 'send') throw new Error('only a decision whose action is send can be sent');
  const id = recordIdOf(decision.key);
  if (await door.readRecord(REPLY_TYPE, id)) return { status: 'already-sent', key: decision.key };
  const window = checkSend(decision, nowMs);
  if (!window.ok) return { status: 'refused', reason: window.reason, key: decision.key };
  const keep = async value => door.write([{ id, type: REPLY_TYPE, value: { key: decision.key, account_id: input.account_id, ...value } }], { key: `${id}:${value.state}` });
  await keep({ state: 'sending', started_at: new Date(nowMs).toISOString() });
  const recipient = decision.kind === 'private-reply' ? { comment_id: decision.recipient.comment_id } : { id: decision.recipient_id };
  let response;
  try {
    response = await send(MESSAGES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${read(TOKEN_DESCRIPTOR)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient, message: { text: decision.reply_text } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    await keep({ state: 'not-known', message: 'the request did not get an answer; look on Instagram before sending again' });
    return { status: 'not-known', key: decision.key };
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.message_id) {
    const reason = typeof payload?.error?.message === 'string' ? payload.error.message : `Instagram answered ${response.status}`;
    await keep({ state: 'failed', message: reason });
    return { status: 'failed', key: decision.key, said: reason };
  }
  await keep({ state: 'sent', message_id: payload.message_id, sent_at: new Date(nowMs).toISOString() });
  return { status: 'sent', key: decision.key, message_id: payload.message_id };
}
