/**
 * send-poll.mjs — CLOCK-TICK-driven RELIABLE send poll (self-healing vs live-delta drops).
 *
 * Mirror of reply-poll for the SEND half. The live-delta `send-reply-on-chat-reply-result` trigger
 * drops under Fly operator load (same root: subscriber queue overflow + no scan-on-gap). This poll
 * runs every clock-tick and SCANS ALL message-results, dispatching send-reply for any that lack a
 * `chief-of-staff-reply-dispatch` breadcrumb (send-reply writes that breadcrumb on every run, so it
 * IS the idempotency marker — a delivered result is never re-sent). Self-healing: a dropped tick just
 * means the next tick catches up. No god package: content-distribution owns the send; this only scans
 * + dispatches DATA. Mirrors timed-action.evaluate-due-on-tick.
 *
 * THE REPLY ROUTE is carried, never assumed. This is the BACKSTOP dispatcher, so it must hand
 * send-reply the same destination_id + channel the live trigger would have, or a result rescued here
 * would go out on a different channel than the one it arrived on. Each result's own fields win; the
 * action's DATA-declared route is the fallback. Nothing here names a channel.
 *
 * Env: BITFIELD_DISPATCH_PARTITION. Carrier resolves ambient (PORT on Fly), so NEVER hardcode :8080 (L136).
 *      SEND_TO_DESTINATION_ID, SEND_ON_CHANNEL  the fallback route, from this action's DATA.
 */

// A supervisor entry is written once and frozen; a runtime that picks its port at startup has an
// address that changes every time it starts. So the supervisor is given the PATH of the file the
// runtime publishes its address into, which does not change, rather than the address, which does.
// Nothing is searched for: the path arrives as DATA exactly as the URL does. The chain lives in
// ./lib/carrier.mjs, mounted beside this file by this action's manifest entry.
import { resolveCarrier, resolvePartition, CARRIER_AND_PARTITION_REQUIRED } from './lib/carrier.mjs';
import { chooseRoute } from './lib/reply-route.mjs';

const CARRIER_URL = resolveCarrier();
const PARTITION_LABEL = resolvePartition();
const MAX_PER_TICK = Math.max(1, Number(process.env.BITFIELD_SEND_POLL_MAX || '8'));
// Fallback reply route, declared as DATA on this action. Empty is legal here: send-reply is the one
// that fails closed on an unrouted reply, so this never invents a channel to keep a send alive.
const DESTINATION_ID = String(process.env.SEND_TO_DESTINATION_ID || '');
const CHANNEL = String(process.env.SEND_ON_CHANNEL || '');
/**
 * Is this AI result a reply that has NOT been sent yet?
 *
 * This is the anti-duplicate rule for the backstop, so both directions cost something real and they
 * cost different things: too loose and a person receives the same reply twice, too tight and a reply
 * is never sent and the loop looks healthy while going silent. The breadcrumb set is the memory,
 * written by send-reply on EVERY run whether or not delivery succeeded, so its presence means
 * "handled", never "delivered".
 *
 * `!p.status` is deliberate and load-bearing: an older result record carries no status field at all,
 * and treating a missing status as not-completed would strand every one of them permanently.
 */
export function isUnsentReply(result, sentRequestIds) {
  const p = result || {};
  const sent = sentRequestIds instanceof Set ? sentRequestIds : new Set(sentRequestIds || []);
  if (p.output_kind !== 'message') return false;          // not a conversational reply
  if (p.status && p.status !== 'completed') return false; // still running, or failed
  if (!p.target_group_ref) return false;                  // nobody to send it to
  return !sent.has(String(p.request_id || ''));
}

// The result's own route wins over this action's declared fallback. Passed through even when
// unresolved, so the single fail-closed check in send-reply is what records the refusal.
function routeInput(result) {
  const route = chooseRoute(result, DESTINATION_ID, CHANNEL);
  return { destination_id: route.destination_id, channel: route.channel };
}

async function basis() { const r = await fetch(new URL('/boot', CARRIER_URL), { headers: { 'Cache-Control': 'no-cache' } }); return (await r.json())[0].running_command_list_basis; }
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
async function find(kind, b) {
  for (let k = 0; k < 5; k++) {
    const f = await postTarget('slot::find-current-items', { operation: 'find-current-items', in: 'published-record', where: { all: [{ field: 'kind', in: [kind] }] }, include: ['payload'] }, b);
    if (f) { const body = f.body ?? f; const arr = Array.isArray(body) ? body : (body && (body.items || body.results) || []); return arr.map((o) => o.payload || o); }
    b = await basis();
  }
  return null;
}

async function main() {
  if (!CARRIER_URL || !PARTITION_LABEL) { console.error(CARRIER_AND_PARTITION_REQUIRED); process.exit(1); }
  const b = await basis();
  const results = await find('ai-records-producer.result', b);
  if (!results) { console.log(JSON.stringify({ tag: 'send-poll', skipped: 'result query failed' })); return; }
  const breadcrumbs = await find('chief-of-staff-reply-dispatch', b);
  if (!breadcrumbs) { console.log(JSON.stringify({ tag: 'send-poll', skipped: 'breadcrumb query failed' })); return; }
  const sent = new Set(breadcrumbs.map((p) => String(p.request_id || p.id || '')));
  // reply outputs only: output_kind=message, completed, has a recipient, not yet sent.
  const pending = results.filter((p) => isUnsentReply(p, sent));
  let dispatched = 0;
  for (const p of pending) {
    if (dispatched >= MAX_PER_TICK) { break; }
    await postTarget('slot::workflow', {
      operation: 'execute_definition', definition_id: 'action:autonomous-agent-tick:send-reply', include_output: false, include_steps: false,
      // Same routing rule as the live trigger and the per-item send, stated once in
      // ./lib/reply-route.mjs. An unrouted result is still dispatched: send-reply is the one that
      // fails closed, so the refusal is recorded in ONE place with its reason rather than silently
      // dropped here where nothing would show why a reply never went out.
      input: { request_id: String(p.request_id), ...routeInput(p) },
    }, b);
    dispatched += 1;
  }
  console.log(JSON.stringify({ tag: 'send-poll', message_results: results.filter((p) => p.output_kind === 'message').length, pending: pending.length, dispatched }));
}

if (import.meta.url === `file://${process.argv[1]}`) { main().catch((e) => { console.error('send-poll fatal:', e.message); process.exitCode = 1; }); }
