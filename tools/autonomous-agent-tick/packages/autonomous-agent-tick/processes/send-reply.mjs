/**
 * send-reply.mjs — ENGINE-NATIVE reply SEND stage (one-shot, compute.process-driven).
 *
 * Second half of the produce/send split (mirrors the operator's produce→publish decouple). Dispatched
 * by the trigger `send-reply-on-chat-reply-result` when an `ai-records-producer.result`
 * (output_kind=chat-reply) lands. Resolves the reply, then hands the SEND to content-distribution.
 *
 * WHY a separate compute.process (not a workflow step): the egress front door is itself a slot::workflow
 * action; a `send-reply` workflow that dispatched it inline would nest slot::workflow→slot::workflow and
 * re-deadlock. So send-reply is a compute.process that FIRE-AND-FORGETS the front door from THIS OS
 * process (include_output:false, no poll) → no command-lane contention. No god package: content-distribution
 * owns the send; ai-records-producer owns the AI turn; this only wires DATA (L136/L098-compliant).
 *
 * THE FRONT DOOR, not the transport. This dispatches `action:submit-message-egress`, which folds
 * write_intent → find_consent → find_destination → create-only CAS claim → run-routed-egress →
 * run-publish-intent. It used to dispatch `action:run-publish-intent` DIRECTLY, which is the transport
 * SSOT and carries NO consent gate (content-distribution's own description says the scheduled path shares
 * it and it "must not carry a consent gate"). So every reply to a real person skipped the consent record
 * that action:record-send-consent exists to enforce, while the comment here claimed "consent-gated".
 * Going through the front door also DELETED three things this file used to hand-roll: the destination
 * record read (find_destination owns it, keyed by destination_id), the duplicate-send guard (the
 * create-only CAS claim is the structural version of it), and the destination ADDRESS literal.
 *
 * THE CHANNEL IS DATA. destination_id + channel arrive as inputs. Nothing here names a channel, so a
 * reply on gmail, the Trillion mobile chat, whatsapp, discord or anything added later is a different
 * DATA value, never an edit to this file. Absent => fail closed and say so; never default to a channel,
 * because a defaulted channel silently sends a private reply to the wrong place.
 *
 * Env (bound by the send-reply action's compute.process step from the trigger change):
 *   BITFIELD_TARGET_CARRIER_URL, BITFIELD_DISPATCH_PARTITION   (required)
 *   BITFIELD_TARGET_CARRIER_URL_FILE  the path the runtime publishes that address into,
 *                                     for a supervisor that cannot be handed the address
 *   ANSWER_REQUEST_ID     the ai-records-producer request_id
 *   SEND_TO_DESTINATION_ID the destination to reply on (required, no default)
 *   SEND_ON_CHANNEL        the channel that destination speaks (required, no default)
 */

// Ambient resolution (mirrors the working operator .mjs — produce-grounded/materialize/evaluate):
// on Fly the engine sets PORT to its own port, so a missing explicit carrier falls back to the
// local engine. NEVER hardcode :8080 (that is a :8080-only literal that breaks on Fly — L136).
// A supervisor entry is written once and frozen; a runtime that picks its port at startup has an
// address that changes every time it starts. So the supervisor is given the PATH of the file the
// runtime publishes its address into, which does not change, rather than the address, which does.
// Nothing is searched for: the path arrives as DATA exactly as the URL does. The chain lives in
// ./lib/carrier.mjs, mounted beside this file by this action's manifest entry.
import { resolveCarrier, resolvePartition, CARRIER_AND_PARTITION_REQUIRED } from './lib/carrier.mjs';
import { chooseRoute } from './lib/reply-route.mjs';

const CARRIER_URL = resolveCarrier();
const PARTITION_LABEL = resolvePartition();
const REQUEST_ID = String(process.env.ANSWER_REQUEST_ID || '');
const RESULT_PREFIX = 'package::ai-records-producer::result::';
// The reply channel, as DATA. No fallback: see the header.
const DESTINATION_ID = String(process.env.SEND_TO_DESTINATION_ID || '');
const CHANNEL = String(process.env.SEND_ON_CHANNEL || '');

async function basis() { const r = await fetch(new URL('/boot', CARRIER_URL), { headers: { 'Cache-Control': 'no-cache' } }); return (await r.json())[0].running_command_list_basis; }
// 30s cap is LOAD-BEARING for the fire-and-forget: the posted egress cannot execute until THIS
// process exits and the parent send-reply workflow completes (nested slot::workflow contention,
// see header). The abort returns null (breadcrumb reads dispatched:false), the process exits, the
// parent wf completes, and the queued egress then runs, so the ::published::/::failed:: event is
// the delivery truth, not the null return. Do NOT raise this.
async function postTarget(target, body, b, ms = 30000) {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(new URL('/target/' + encodeURIComponent(target), CARRIER_URL), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bitfield-Running-Command-List-Basis': b },
      body: JSON.stringify(body), signal: ac.signal,
    });
    const x = await r.text(); try { return JSON.parse(x); } catch { return null; }
  } catch { return null; } finally { clearTimeout(to); }
}
async function readCurrent(addr, mode, b) {
  const j = await postTarget('engine.operation.label-addressed', { operation_label: 'engine.operation.read-current', partition_label: PARTITION_LABEL, address_label: addr, address_mode: mode }, b);
  if (!j || j.found === false) { return null; }
  return j.payload ?? j.value ?? j.ok?.payload ?? j.ok?.value ?? j.ok ?? null;
}
function replyText(payload) {
  const items = payload && (payload.items || (payload.result_payload && payload.result_payload.items));
  const t = Array.isArray(items) && items[0] && items[0].text;
  return typeof t === 'string' ? t.trim() : '';
}
async function writeTurn(chatId, role, text, b) {
  const at = new Date().toISOString();
  const tail = `${at}-${role}`;
  const payload = { kind: 'chief-of-staff-conversation-turn', id: tail, chat_id: chatId, role, text: String(text || ''), at };
  return !!(await postTarget('engine.operation.label-addressed', {
    operation_label: 'engine.operation.write-batch',
    writes: [{ partition_label: PARTITION_LABEL, address_label: `package::autonomous-chief-of-staff::conversation::${chatId}::${tail}`, address_mode: 'identity_text', path_labels: ['current-item', 'published-record'], payload }],
  }, b));
}
// Unconditional execution breadcrumb (D-dimension observability): the reply SEND path records
// its own outcome for EVERY dispatch, whether or not a message was actually delivered. This is
// the fire-trace the trigger→send link needs — send success is conditional (consent-gated), but
// the fact that send-reply RAN is not. One record per request_id, overwritten idempotently.
async function writeOutcome(fields, b) {
  const at = new Date().toISOString();
  const payload = { kind: 'chief-of-staff-reply-dispatch', id: REQUEST_ID, request_id: REQUEST_ID, at, ...fields };
  return !!(await postTarget('engine.operation.label-addressed', {
    operation_label: 'engine.operation.write-batch',
    writes: [{ partition_label: PARTITION_LABEL, address_label: `package::autonomous-chief-of-staff::reply-dispatch::${REQUEST_ID}`, address_mode: 'identity_text', path_labels: ['current-item', 'published-record'], payload }],
  }, b));
}

async function main() {
  if (!CARRIER_URL || !PARTITION_LABEL) { console.error(CARRIER_AND_PARTITION_REQUIRED); process.exit(1); }
  if (!REQUEST_ID) { console.log(JSON.stringify({ tag: 'send-reply', skipped: 'missing request_id' })); return; }
  const b = await basis();
  const result = await readCurrent(RESULT_PREFIX + REQUEST_ID, 'label-hash', b);
  // chat_id rides on the result itself: reply-producer passes it as target_group_ref and the
  // producer copies it onto the result record — no side-channel mapping record needed.
  const chatId = result && String(result.target_group_ref || (result.result_payload && result.result_payload.target_group_ref) || '');
  const text = replyText(result);
  if (!chatId || !text) { await writeOutcome({ chat_id: chatId || null, chars: text.length, dispatched: false, reason: `chat_id=${!!chatId} text=${!!text}` }, b); console.log(JSON.stringify({ tag: 'send-reply', request_id: REQUEST_ID, sent: false, reason: `chat_id=${!!chatId} text=${!!text}` })); return; }
  // Fail closed on an unrouted reply. A missing channel is not a reason to guess one: guessing sends a
  // private message to whichever channel happened to be hardcoded, which is the defect this replaced.
  // The rule lives in ./lib/reply-route.mjs, stated once for the three processes that needed it and
  // pinned by reply-route.test.mjs, which was checked by reintroducing the telegram default and
  // watching 8 assertions fail rather than by trusting a first green run.
  const route = chooseRoute(result, DESTINATION_ID, CHANNEL);
  if (!route.ok) {
    await writeOutcome({ chat_id: chatId, chars: text.length, dispatched: false, reason: route.reason }, b);
    console.log(JSON.stringify({ tag: 'send-reply', request_id: REQUEST_ID, sent: false, reason: route.reason }));
    return;
  }

  const intentId = `cos-reply-${REQUEST_ID}`;
  // FIRE-AND-FORGET the egress FRONT DOOR (not the transport). submit-message-egress owns, in order:
  // the durable egress-intent ledger record, the fail-closed per-recipient consent gate, the destination
  // lookup by destination_id, and a create-only CAS claim at routed-egress-claim::<intent_id> that makes
  // a double-send structurally impossible (a claim collision Skips dispatch). That CAS claim REPLACED the
  // read-two-action-state-events loop this file used to run: a guard built from reads is a guard with a
  // race, and the claim is the same intent expressed as an engine invariant instead.
  const dispatched = !!(await postTarget('slot::workflow', {
    operation: 'execute_definition', definition_id: 'action:submit-message-egress', include_output: false, include_steps: false,
    input: {
      intent_id: intentId,
      destination_id: route.destination_id,
      channel: route.channel,
      recipient: chatId,
      body: text.slice(0, 3900),
      reply_to_thread_ref: chatId,
      requested_at: new Date().toISOString(),
    },
  }, b) !== null);
  if (dispatched) { await writeTurn(chatId, 'assistant', text, b); }
  await writeOutcome({ chat_id: chatId, channel: route.channel, destination_id: route.destination_id, chars: text.length, dispatched, reason: dispatched ? 'submit-message-egress dispatched' : 'submit-message-egress returned null (no consent on file, claim collision, or transport error)' }, b);
  console.log(JSON.stringify({ tag: 'send-reply', request_id: REQUEST_ID, chat_id: chatId, channel: route.channel, destination_id: route.destination_id, chars: text.length, dispatched }));
}

if (import.meta.url === `file://${process.argv[1]}`) { main().catch((e) => { console.error('send-reply fatal:', e.message); process.exitCode = 1; }); }

export { replyText };
