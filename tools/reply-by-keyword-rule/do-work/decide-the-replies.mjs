// tools/reply-by-keyword-rule/do-work/decide-the-replies.mjs
//
// tool:decide-the-instagram-replies. Reads the person's reply rules (`reply-rule` records, in their `order`), the pulled
// Instagram conversations of one account and the replies already kept (`instagram-reply` records), then says which
// reply to send now and which to leave, each with its reason. Sends nothing and keeps nothing.
import { chooseReplies } from '../read-data/reply-rules.mjs';
import { readParts } from '../../pull-from-connected-accounts/read-data/snapshot.mjs';

export const RULE_TYPE = 'reply-rule';
export const REPLY_TYPE = 'instagram-reply';
export const SOURCE = 'instagram-messages';

/** The decisions for one account. `comments` is the comment list the caller pulled (comments are not pulled here yet). */
export async function decideTheReplies(input, { door }) {
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new Error('now must be an ISO time');
  const rules = [];
  for await (const record of door.list({ type: RULE_TYPE })) if (record.value) rules.push(record.value);
  rules.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const parts = await readParts(door, SOURCE, input.account_id);
  const selfId = parts.state?.self_id;
  if (!selfId) throw new Error('this account has no pulled state yet: pull its messages first');
  const sentKeys = new Set();
  for await (const record of door.list({ type: REPLY_TYPE })) if (record.value?.key) sentKeys.add(record.value.key);
  const decisions = chooseReplies({
    rules,
    threads: [...parts.threads.values()].map(part => part.thread),
    comments: input.comments ?? [],
    selfId: String(selfId),
    nowMs,
    sentKeys,
  });
  return { account_id: input.account_id, decisions };
}
