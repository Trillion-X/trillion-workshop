// tools/reply-by-keyword-rule/read-data/reply-rules.mjs
//
// The rules of an automatic reply to a message the person received on Instagram or Messenger, and the two Meta windows
// a reply must sit inside. Pure: no network, no records. The records and the send live in do-work/.
//
// Non-negotiable invariants
//   1. A direct message is answered only while less than 24 hours have passed since the last message from the other
//      person (Meta's messaging window). A private reply to a comment is sent only within 7 days of the comment, and
//      only once per comment (its recipient is the comment id, never a person id).
//   2. Only the latest message of a thread is answered, and only when the other person wrote it: a thread the person
//      already answered is left alone.
//   3. A reply key (message id and rule id) that was already sent is never chosen again.
//   4. The reply text is the rule's own template filled by tools/reply-templates; the rule decides nothing else.
//   5. The window is checked again at the moment of sending (checkSend), not only when the reply is chosen.
//   6. Rules are data (the person's `reply-rule` records). A rule is used only when its `enabled` is 'on' (a list choice).
//      This file names no keyword, no customer and no account.
import { expandReplyTemplate } from '../../reply-templates/read-data/expand.mjs';

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const PRIVATE_REPLY_MS = 7 * 24 * 60 * 60 * 1000;

/** Lower case, accents removed, punctuation and symbols (emoji included) turned into spaces, words joined by one space. */
export function normalise(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether a rule's words appear in the text as whole words: `any` one of them, or `all` of them. */
export function ruleMatches(rule, text) {
  const padded = ` ${normalise(text)} `;
  const hits = rule.words.map(word => padded.includes(` ${normalise(word)} `));
  return rule.mode === 'all' ? hits.every(Boolean) : hits.some(Boolean);
}

/** Whether a direct message may be answered: under 24 hours since the other person's last message. */
export function dmWindowOpen(lastInboundMs, nowMs) {
  return nowMs - lastInboundMs < WINDOW_MS;
}

/** Whether a private reply to a comment may be sent: under 7 days since the comment. */
export function privateReplyOpen(commentMs, nowMs) {
  return nowMs - commentMs < PRIVATE_REPLY_MS;
}

const ms = iso => Date.parse(iso);

/** One decision per candidate: send with its recipient and reply text, or skip with the reason in words. */
function decide(base, rules, text, sentKeys, nowMs, openAt) {
  if (!openAt(nowMs)) return { ...base, action: 'skip', reason: 'window-closed' };
  const rule = rules.find(candidate => candidate.enabled === 'on' && ruleMatches(candidate, text));
  if (!rule) return { ...base, action: 'skip', reason: 'no-rule-matches' };
  const key = `${base.message_id}:${rule.id}`;
  if (sentKeys.has(key)) return { ...base, key, rule_id: rule.id, action: 'skip', reason: 'already-sent' };
  const reply_text = expandReplyTemplate({ template: rule.reply, caller_request: base.caller ?? {} });
  return { ...base, key, rule_id: rule.id, action: 'send', reply_text };
}

/**
 * The replies to choose now.
 *   rules:     [{ id, enabled: 'on' | 'off', words, mode: 'any' | 'all', reply: template }], in the order they apply
 *   threads:   [{ id, messages: [{ id, from: { id }, created_time, message }] }] (the pulled Instagram conversations)
 *   comments:  [{ id, media_id, from: { id }, created_time, text }]
 *   selfId:    the person's own account id (their messages are not answered)
 *   sentKeys:  Set of keys already sent (`${message id}:${rule id}`)
 */
export function chooseReplies({ rules, threads, comments, selfId, nowMs, sentKeys }) {
  const dms = threads.flatMap(thread => {
    const latest = [...thread.messages].sort((a, b) => ms(b.created_time) - ms(a.created_time))[0];
    if (!latest) return [];
    const base = {
      thread_id: thread.id, message_id: latest.id, recipient_id: latest.from?.id ?? null, kind: 'dm',
      last_inbound_at: latest.created_time,
    };
    if (latest.from?.id === selfId) return [{ ...base, action: 'skip', reason: 'latest-message-is-ours' }];
    return [decide(base, rules, latest.message, sentKeys, nowMs, now => dmWindowOpen(ms(latest.created_time), now))];
  });
  const replies = comments.map(comment => {
    if (comment.from?.id === selfId) return { thread_id: null, message_id: comment.id, kind: 'private-reply', action: 'skip', reason: 'comment-is-ours' };
    const base = {
      thread_id: null, message_id: comment.id, recipient: { comment_id: comment.id }, kind: 'private-reply',
      created_time: comment.created_time,
    };
    return decide(base, rules, comment.text, sentKeys, nowMs, now => privateReplyOpen(ms(comment.created_time), now));
  });
  return [...dms, ...replies];
}

/** Whether a chosen reply may still be sent at `nowMs`: its window is checked again here, at the moment of sending. */
export function checkSend(decision, nowMs) {
  if (decision.kind === 'dm') {
    return dmWindowOpen(ms(decision.last_inbound_at), nowMs) ? { ok: true } : { ok: false, reason: 'window-closed' };
  }
  if (decision.kind === 'private-reply') {
    return privateReplyOpen(ms(decision.created_time), nowMs) ? { ok: true } : { ok: false, reason: 'window-closed' };
  }
  return { ok: false, reason: 'unknown-kind' };
}
