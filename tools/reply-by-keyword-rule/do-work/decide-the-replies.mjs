// tools/reply-by-keyword-rule/do-work/decide-the-replies.mjs
//
// tool:decide-the-instagram-replies. Reads the person's reply rules (`reply-rule` records, in their `order`), the pulled
// Instagram direct-message conversations and the pulled Instagram comments of one account (the `instagram-messages` and
// `instagram-comments` pulls), and the replies already kept (`instagram-reply` records), then says which reply to send
// now and which to leave, each with its reason. Sends nothing and keeps nothing.
import { chooseReplies } from '../read-data/reply-rules.mjs';
import { readParts } from '../../pull-from-connected-accounts/read-data/snapshot.mjs';

export const RULE_TYPE = 'reply-rule';
export const REPLY_TYPE = 'instagram-reply';
export const SOURCE = 'instagram-messages';
export const COMMENTS_SOURCE = 'instagram-comments';

/** A pulled comment as the decision reads it: the post it is on, its author, its time and its words. */
const commentOf = (post, comment) => ({
  id: String(comment.id),
  media_id: String(post.id),
  from: comment.from?.id === undefined ? null : { id: String(comment.from.id) },
  created_time: comment.timestamp,
  text: comment.text ?? '',
});

/** The decisions for one account, from what the pulls held. A source never pulled is named under not_pulled. */
export async function decideTheReplies(input, { door }) {
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new Error('now must be an ISO time');
  const rules = [];
  for await (const record of door.list({ type: RULE_TYPE })) if (record.value) rules.push(record.value);
  rules.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const parts = await readParts(door, SOURCE, input.account_id);
  const selfId = parts.state?.self_id;
  if (!selfId) throw new Error('this account has no pulled state yet: pull its messages first');
  const commentParts = await readParts(door, COMMENTS_SOURCE, input.account_id);
  const not_pulled = commentParts.state ? [] : [COMMENTS_SOURCE];
  const comments = [...commentParts.threads.values()].flatMap(part => part.thread.messages.map(comment => commentOf(part.thread, comment)));
  const sentKeys = new Set();
  for await (const record of door.list({ type: REPLY_TYPE })) if (record.value?.key) sentKeys.add(record.value.key);
  const decisions = chooseReplies({
    rules,
    threads: [...parts.threads.values()].map(part => part.thread),
    comments,
    selfId: String(selfId),
    nowMs,
    sentKeys,
  });
  return { account_id: input.account_id, decisions, not_pulled };
}
