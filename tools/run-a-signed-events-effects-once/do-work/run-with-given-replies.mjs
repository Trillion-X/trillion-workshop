// tools/run-a-signed-events-effects-once/do-work/run-with-given-replies.mjs
//
// One run of the signed-event-effects targets (signed-event-effects-targets.js) with no transport: every call the
// targets would send to a verifier, writer or reader is answered from `replies`, which the caller gives in the input,
// and every call is written down in `sent`. Nothing leaves the run; a caller that wants real answers runs the targets
// with its own `send`.
//
// Input:
//   op              'admit' (admitSignedEventEffects) or 'list' (listSignedEventEffects)
//   descriptor_ref  an installed descriptor id (../records.json): for admit an admission descriptor, for list a list
//                   descriptor
//   events          admit: the signed events, each { payload: { event_id, namespace, occurred_at, idempotency_key,
//                   facts: [{ fact_id, subject, relation, object, attributes }] }, proof: { signer_id, signature_hex } }
//   subject         list: whose effects to list
//   request_id      admit: echoed back
//   replies         { <target>: reply | [reply, ...] }: what each target answers. A list is answered in order, one per
//                   call; a single reply answers every call to that target. The verifier's reply is
//                   { evaluation: { event_hashes: { <event_id>: <hash> } } }.
// Answers what the target answered, plus sent: [{ target, payload }] in the order the calls were made.
// Refuses an op it does not know, a call to a target `replies` gives no answer for, and a list that ran out; the
// targets themselves refuse a caller-given descriptor, a descriptor that is not installed and an undeclared write path.
import { admitSignedEventEffects, listSignedEventEffects } from './signed-event-effects-targets.js';

const OPS = { admit: admitSignedEventEffects, list: listSignedEventEffects };

export async function runSignedEventEffectsWithGivenReplies({ op, replies, ...input } = {}) {
  const target = OPS[op];
  if (!target) throw new Error(`op is ${JSON.stringify(op)}; use one of ${Object.keys(OPS).join(', ')}.`);
  if (!replies || typeof replies !== 'object' || Array.isArray(replies)) {
    throw new Error('Give replies: { <target>: reply | [reply, ...] }, what each verifier, writer or reader answers.');
  }
  const sent = [];
  const used = {};
  const send = async ({ target: name, payload }) => {
    sent.push({ target: name, payload });
    if (!Object.prototype.hasOwnProperty.call(replies, name)) {
      throw new Error(`The run sent to ${name}, and replies gives no answer for it: add replies[${JSON.stringify(name)}].`);
    }
    const given = replies[name];
    if (!Array.isArray(given)) return given;
    const at = used[name] ?? 0;
    if (at >= given.length) throw new Error(`The run sent to ${name} ${at + 1} times, and replies[${JSON.stringify(name)}] gives ${given.length} answers: add one more.`);
    used[name] = at + 1;
    return given[at];
  };
  const answer = await target({ ...input, send });
  return { ...answer, sent };
}
