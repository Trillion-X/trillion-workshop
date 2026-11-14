/**
 * reconcile-dispatch-requests.mjs — GENERIC one-shot request→run reconciler (Physics, zero Society).
 *
 * The healing twin of the drain pump. A durable owner-action request (dispatch-request) can be
 * created and acknowledged while its later Workflow dispatch is lost (trigger delivery gap, engine
 * restart, transient run failure). This reconciler makes that loss self-healing: each invocation
 * enumerates request records, checks each for a correlated completion record, and re-dispatches
 * the FIRST request that has none. Bounded to one dispatch per invocation (the tick cadence is the
 * throttle), idempotent under retries (a completed run leaves a completion record, so the next
 * sweep skips it). It holds NO domain vocabulary — request kind, completion kind, correlation
 * fields, and the workflow carrier are all DATA via env.
 *
 * WHAT IT DOES (one request per invocation, fully bounded):
 *   1. find-current-items of REQUEST_KIND; sort by id ascending (deterministic).
 *   2. find-current-items of COMPLETION_KIND; collect the set of correlation values
 *      (COMPLETION_CORRELATION_FIELD, default "request_id").
 *   3. The first request whose correlation value (REQUEST_CORRELATION_FIELD, default
 *      "request_id") is NOT in that set and whose lifecycle is not terminal gets
 *      re-dispatched: execute_definition(request.definition_id, request.input) to
 *      slot::workflow, bounded by RUN_TIMEOUT_MS.
 *   4. Success/failure is reported on stdout; the run itself writes the completion record
 *      (that is the run action's job, not this script's) — so a successful re-run is
 *      invisible to the NEXT sweep, which is the idempotency contract.
 *
 * ANTI-HANG: every carrier call is bounded by an AbortController timeout; null → fail closed.
 *
 * Env (all DATA):
 *   BITFIELD_TARGET_CARRIER_URL, BITFIELD_DISPATCH_PARTITION,
 *   RECONCILE_REQUEST_KIND, RECONCILE_COMPLETION_KIND,
 *   RECONCILE_REQUEST_CORRELATION_FIELD (default "request_id"),
 *   RECONCILE_COMPLETION_CORRELATION_FIELD (default "request_id"),
 *   RECONCILE_RUN_TIMEOUT_MS (default 600000).
 */

const CARRIER_URL = process.env.BITFIELD_TARGET_CARRIER_URL || '';
const PARTITION_LABEL = process.env.BITFIELD_DISPATCH_PARTITION || '';
const REQUEST_KIND = process.env.RECONCILE_REQUEST_KIND || '';
const COMPLETION_KIND = process.env.RECONCILE_COMPLETION_KIND || '';
const REQ_FIELD = process.env.RECONCILE_REQUEST_CORRELATION_FIELD || 'request_id';
const DONE_FIELD = process.env.RECONCILE_COMPLETION_CORRELATION_FIELD || 'request_id';
const RUN_TIMEOUT_MS = Number(process.env.RECONCILE_RUN_TIMEOUT_MS || 600000);
const CALL_TIMEOUT_MS = 20000;

async function runningAppRequests() {
  return import('./send-requests-to-running-app.mjs');
}

async function findKind(requests, session, kind) {
  return requests.findCurrentRecords(session, kind, {
    limit: 10000,
    timeoutMs: CALL_TIMEOUT_MS,
  });
}

// PURE (exported for tests): the first request lacking a correlated completion, id-ascending.
export function selectUnreconciled(requests, completions, reqField = 'request_id', doneField = 'request_id') {
  const done = new Set(completions.map((c) => c && c[doneField]).filter(Boolean));
  return (Array.isArray(requests) ? requests : [])
    .filter((r) => r && r.definition_id && r.input)
    .filter((r) => !(r.lifecycle && r.lifecycle.terminal === true))
    .filter((r) => {
      const key = r[reqField] || r.id;
      return key && !done.has(key) && !(r.input && done.has(r.input[reqField]));
    })
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))[0] || null;
}

async function main() {
  const missing = [];
  if (!CARRIER_URL) missing.push('BITFIELD_TARGET_CARRIER_URL');
  if (!PARTITION_LABEL) missing.push('BITFIELD_DISPATCH_PARTITION');
  if (!REQUEST_KIND) missing.push('RECONCILE_REQUEST_KIND');
  if (!COMPLETION_KIND) missing.push('RECONCILE_COMPLETION_KIND');
  if (missing.length) { console.error('missing env: ' + missing.join(',')); process.exit(2); }

  const result = await reconcileDispatchRequests({
    requests: await runningAppRequests(), url: CARRIER_URL,
    requestKind: REQUEST_KIND, completionKind: COMPLETION_KIND,
    requestField: REQ_FIELD, completionField: DONE_FIELD, runTimeoutMs: RUN_TIMEOUT_MS,
  });
  console.log(JSON.stringify(result));
  if (result.status === 'run-failed') process.exitCode = 3;
}

export async function reconcileDispatchRequests({ requests, url, requestKind, completionKind,
  requestField = 'request_id', completionField = 'request_id', runTimeoutMs = 600000 }) {
  const session = await requests.startRunningAppSession({
    url,
    timeoutMs: CALL_TIMEOUT_MS,
  });
  const [requestRows, completionRows] = await Promise.all([
    findKind(requests, session, requestKind),
    findKind(requests, session, completionKind),
  ]);
  const next = selectUnreconciled(requestRows, completionRows, requestField, completionField);
  if (!next) {
    return { status: 'reconciled', requests: requestRows.length, completions: completionRows.length };
  }
  const reply = await requests.sendRequestToRunningApp(session, 'slot::workflow', {
    operation: 'execute_definition',
    definition_id: next.definition_id,
    include_steps: false,
    include_output: false,
    input: next.input,
  }, { timeoutMs: runTimeoutMs });
  if (reply?.status !== 'completed') {
    return { status: 'run-failed', id: next.id, result: reply?.status ?? null };
  }
  return { status: 'ran', id: next.id, result: reply.status };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  main().catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
}
