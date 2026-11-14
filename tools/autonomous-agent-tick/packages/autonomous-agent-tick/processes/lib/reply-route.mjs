/**
 * lib/reply-route.mjs: WHERE a message goes, decided once, as pure data in and data out.
 *
 * Three processes needed the same two answers on 2026-09-04 and each grew its own copy:
 * send-reply (per-item send), send-poll (backstop dispatcher) and surface-human-work-once
 * (per-tick surfacing, itself deleted later the same day with the rest of its loop). A rule copied
 * three times is a rule that will diverge three ways, and the send path had already been fixed
 * twice that day for exactly this shape of duplication.
 *
 * NAMES NO CHANNEL. Every value here arrives as DATA. Telegram, gmail, the Trillion mobile chat,
 * whatsapp and anything added later are values, never branches, so nothing in this file changes
 * when a channel is added. That is the whole point: the file that decides routing must not know
 * what it routes to.
 *
 * NO IO. Pure so the decisions can be tested without an engine, matching the sibling shape in
 * spawn-check.mjs (mutateDecision / spawnDecision).
 */

/**
 * Decide the destination for one message. An item's own DATA wins; the caller's DATA-declared
 * route is the fallback; absent both, REFUSE.
 *
 * Refusing is the whole value. A defaulted channel does not fail loudly, it delivers a private
 * message to whoever happens to be on the hardcoded channel, which is the defect this replaced.
 * So "unrouted" is a first-class outcome with a reason, never an exception and never a guess.
 *
 * @returns {{ok: boolean, destination_id: string, channel: string, reason: string}}
 */
export function chooseRoute(item, fallbackDestinationId, fallbackChannel) {
  const source = item || {};
  const destinationId = String(source.destination_id || fallbackDestinationId || '');
  const channel = String(source.channel || fallbackChannel || '');
  if (!destinationId || !channel) {
    return {
      ok: false,
      destination_id: destinationId,
      channel,
      reason: `unrouted: destination_id=${destinationId || 'MISSING'} channel=${channel || 'MISSING'}`,
    };
  }
  return { ok: true, destination_id: destinationId, channel, reason: 'routed' };
}

/**
 * Is this inbound atom one we answer?
 *
 * NOT an open filter. These atoms include feeds and bookmarks, not only people talking to us, so
 * answering everything observed would start an AI conversation with a bookmark. The answerable set
 * is DATA, and an empty or unparseable set answers NOTHING, because the safe direction for a rule
 * about messaging real people is silence.
 */
export function isAnswerableSource(atom, answerSourceRefs) {
  const source = atom || {};
  const allowed = Array.isArray(answerSourceRefs) ? answerSourceRefs : [];
  return allowed.includes(String(source.source_ref || '')) && !!source.thread_ref && !!source.text;
}

/**
 * Parse the answerable-source DATA list. A JSON array so each entry is its own value and nothing
 * has to be split out of a delimited string.
 *
 * Unparseable returns EMPTY, not a throw and not a default set: a malformed config must not be
 * able to widen who gets messaged.
 */
export function parseAnswerSourceRefs(raw, onError) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (e) {
    if (typeof onError === 'function') { onError(e); }
    return [];
  }
}
