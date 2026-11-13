// tools/reply-by-keyword-rule/read-data/reply-rules.mjs
//
// The rules of an automatic reply to something a person received (a message, a comment) on one of their connected
// places, and the window each place allows a reply in. Pure: no network, no records. The records and the send live in
// do-work/. A place is a row of read-data/reply-places.json; nothing here names a place.
//
// Non-Negotiable Invariants
//   1. A reply is chosen only while its channel's window is open (a place row's `window_ms`, counted from the item's own
//      time; null means the place sets none), and the window is checked again at the moment of sending (checkSend).
//   2. For a channel that answers only the latest message of a thread (`which: latest`), only that message is answered,
//      and only when the other person wrote it: a thread the person already answered is left alone.
//   3. A reply key (message id and rule id) that was already sent is never chosen again.
//   4. The reply text is the rule's own template filled by tools/reply-templates; the rule decides nothing else.
//   5. Where an item's fields are, who a reply goes to and how it is sent are the place row's, read the same way for
//      every place. A place the code has never heard of is one more row.
//   6. Rules are data (the person's `reply-rule` records). A rule is used only when its `enabled` is 'on' (a list choice).
//      This file names no keyword, no customer, no account and no place.
import { expandReplyTemplate } from '../../reply-templates/read-data/expand.mjs';

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

const ms = iso => Date.parse(iso);

/** The value at a dotted path in an object, or undefined. */
export function pick(value, path) {
  let at = value;
  for (const step of String(path).split('.')) {
    if (at === null || typeof at !== 'object') return undefined;
    at = at[step];
  }
  return at;
}

/** A template filled from `vars`: a string that is exactly `{name}` becomes that value as it is (an object stays an
 *  object); a `{name}` inside a longer string becomes its text; arrays and objects are filled item by item. A name with
 *  no value throws, so a request is never sent with a blank in it. */
export function fill(template, vars) {
  if (typeof template === 'string') {
    const whole = /^\{(\w+)\}$/.exec(template);
    const value = name => {
      if (vars[name] === undefined || vars[name] === null) throw new Error(`no value for {${name}}`);
      return vars[name];
    };
    if (whole) return value(whole[1]);
    return template.replace(/\{(\w+)\}/g, (_, name) => String(value(name)));
  }
  if (Array.isArray(template)) return template.map(item => fill(item, vars));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, fill(item, vars)]));
  return template;
}

/** Whether a reply may still be sent: no window, or under `windowMs` since the item. */
export function windowOpen(windowMs, itemMs, nowMs) {
  return windowMs === null || windowMs === undefined || nowMs - itemMs < windowMs;
}

/**
 * The items of one channel as one shape: { thread_id, message_id, from_id, created_time, text }.
 *   sources: for a snapshot channel, the pulled threads [{ id, messages: [...] }]; for a handed-in channel, the pull
 *            tool's answers [{ <items_path>: [...] }]
 * A snapshot channel with `which: latest` gives each thread's newest message only.
 */
export function itemsOf(channel, sources) {
  const read = (item, thread) => ({
    thread_id: pick(thread ?? item, channel.fields.thread_id) ?? null,
    message_id: String(pick(item, channel.fields.message_id)),
    from_id: pick(item, channel.fields.from_id) === undefined ? null : String(pick(item, channel.fields.from_id)),
    created_time: pick(item, channel.fields.created_time),
    text: pick(item, channel.fields.text) ?? '',
  });
  if (channel.pull.handed_in) {
    return sources.flatMap(answer => (pick(answer, channel.pull.handed_in.items_path) ?? []).map(item => read(item, null)));
  }
  return sources.flatMap(thread => {
    const all = thread.messages ?? [];
    const chosen = channel.which === 'latest'
      ? [...all].sort((a, b) => ms(pick(b, channel.fields.created_time)) - ms(pick(a, channel.fields.created_time))).slice(0, 1)
      : all;
    return chosen.map(item => read(item, thread));
  });
}

/** One decision per item: send with its recipient and reply text, or skip with the reason in words. */
function decide(base, rules, text, sentKeys, open) {
  if (!open) return { ...base, action: 'skip', reason: 'window-closed' };
  const rule = rules.find(candidate => candidate.enabled === 'on' && ruleMatches(candidate, text));
  if (!rule) return { ...base, action: 'skip', reason: 'no-rule-matches' };
  const key = `${base.message_id}:${rule.id}`;
  if (sentKeys.has(key)) return { ...base, key, rule_id: rule.id, action: 'skip', reason: 'already-sent' };
  const reply_text = expandReplyTemplate({ template: rule.reply, caller_request: {} });
  return { ...base, key, rule_id: rule.id, action: 'send', reply_text };
}

/**
 * The replies to choose now, for one place.
 *   place:    one row of reply-places.json
 *   rules:    [{ id, enabled: 'on' | 'off', words, mode: 'any' | 'all', reply: template }], in the order they apply
 *   pulled:   { <channel id>: sources } as itemsOf reads them; a channel with no sources here is not decided
 *   selfId:   the person's own id at the place (their own words are not answered)
 *   sentKeys: Set of keys already sent (`${message id}:${rule id}`)
 */
export function chooseReplies({ place, rules, pulled, selfId, nowMs, sentKeys }) {
  return place.channels.flatMap(channel => {
    if (!pulled[channel.id]) return [];
    return itemsOf(channel, pulled[channel.id]).map(item => {
      const base = { place: place.id, kind: channel.id, thread_id: item.thread_id, message_id: item.message_id, created_time: item.created_time, window_ms: channel.window_ms ?? null };
      if (item.from_id !== null && item.from_id === selfId) return { ...base, action: 'skip', reason: channel.own_reason };
      let recipient;
      try { recipient = fill(channel.recipient, item); } catch { return { ...base, action: 'skip', reason: 'no-recipient' }; }
      return decide({ ...base, recipient }, rules, item.text, sentKeys, windowOpen(channel.window_ms, ms(item.created_time), nowMs));
    });
  });
}

/** Whether a chosen reply may still be sent at `nowMs`: its window is checked again here, at the moment of sending. */
export function checkSend(decision, nowMs) {
  if (!Number.isFinite(ms(decision.created_time))) return { ok: false, reason: 'unknown-time' };
  return windowOpen(decision.window_ms, ms(decision.created_time), nowMs) ? { ok: true } : { ok: false, reason: 'window-closed' };
}
