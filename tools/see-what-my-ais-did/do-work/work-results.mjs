// src/work-results.mjs
//
// What an AI finished comes back as new input.
//
// Purpose
//   Work about something that arrived (a note, a memo, a message) ends with a result. The result is kept as a message
//   beside the words it answers, so every one of the person's AIs reads what was done (read_messages), and each piece
//   of work the AI left to do next (`result.next`: ["...", ...]) arrives as an input of its own, which the person's
//   rules hand on like anything else that arrives (src/inbound.mjs followUp). So the work keeps going with nobody in
//   the loop, and stays bounded.
//
// Non-negotiable invariants
//   1. Only finished work about an arrived message comes back; work closed as a duplicate or as a correction does not.
//   2. Once per handoff: the result message and each follow-up are named by the handoff (source_ref, source_id), so a
//      repeated finish, or the same result seen twice, keeps nothing twice.
//   3. A result is the AI's words, kept under the AI's name, never as the person's: it starts no decision of the
//      person's and no rule about the person's messages. A follow-up is an arrival from that AI, one level deeper
//      (`depth`), and nothing comes back past max_depth, so a chain of work cannot feed itself forever.
//   4. Nothing here names an app, a carrier or a kind of work.
//

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
// Results that only close work, never answer it.
const CLOSING = new Set(['duplicate', 'source_provenance_correction']);

// The words a result says: its outcome or summary, else the whole result as it was given.
export function workResultWords(handoff) {
  const result = handoff.result;
  if (typeof result === 'string') return result;
  for (const field of ['outcome', 'summary', 'text', 'answer']) if (nonempty(result?.[field])) return result[field];
  return nonempty(handoff.summary) ? handoff.summary : JSON.stringify(result);
}

/**
 * kept:     messages(...) from src/messages.mjs
 * read:     (message_id) → the kept message or null
 * followUp: (arrival) → src/inbound.mjs followUp
 * settings: { max_depth, follow_ups_per_job, app }
 */
export function workResults({ kept, read, followUp, settings }) {
  return {
    finished(handoff) {
      if (handoff?.withdrawal || handoff?.status === 'withdrawn' || handoff?.result?.state === 'withdrawn') return null;
      const arrived = handoff?.input?.arrived;
      const message = nonempty(arrived?.message_id) ? read(arrived.message_id) : null;
      if (!message || handoff.result === null || handoff.result === undefined || CLOSING.has(handoff.result?.kind)) return null;
      const by = nonempty(handoff.taken_by) ? handoff.taken_by : 'ai';
      const at = handoff.finished_at ?? new Date().toISOString();
      const answer = kept.record({ messages: [{
        conversation_id: message.conversation_id, app: settings.app, speaker: by, text: workResultWords(handoff).slice(0, 100_000), at,
        source_ref: `handoff:${handoff.handoff_id}`, about: [{ kind: 'message', id: arrived.message_id }],
      }] });
      const depth = (Number.isInteger(arrived.depth) ? arrived.depth : 0) + 1;
      const next = depth > settings.max_depth || !Array.isArray(handoff.result?.next) ? [] : handoff.result.next.filter(nonempty).slice(0, settings.follow_ups_per_job);
      const follow_ups = next.map((text, index) => followUp({
        route: nonempty(arrived.route) ? arrived.route : settings.app, source_id: `${handoff.handoff_id}:next:${index}`, text, at,
        from_person: false, from: by, follows: handoff.handoff_id, depth, chat_first_minutes: 0,
      }));
      return { result_message_id: answer.ids[0], follow_ups };
    },
  };
}
