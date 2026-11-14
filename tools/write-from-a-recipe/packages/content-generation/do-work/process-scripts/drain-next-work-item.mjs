/**
 * drain-next-work-item.mjs — GENERIC one-shot content-generation pump (Physics, zero Society).
 *
 * The blind queue pump. Fired per clock::tick (or on demand) via
 * trigger-rule -> execute_definition -> compute.process (one-shot, bounded, never a long-running
 * process that can silently die). Owns only pick, dispatch, and queue-state transition. It holds NO
 * domain vocabulary, NO AI/provider logic, NO output shape, NO fixed address — every one of those
 * is DATA supplied through the recipe's work selector and caller-selected owner delivery.
 *
 * WHAT IT DOES (one work item per tick, fully bounded):
 *   1. Read the work-item queue: published-records of kind = WORK_ITEM_KIND (DATA).
 *   2. Pick the next row whose STATUS_FIELD == PENDING_STATUS (DATA), deterministic order (sorted id).
 *   3. Atomically create a deterministic durable dispatch-request
 *      (create-only) and mark the row DONE_STATUS. The request is the
 *      idempotency claim: competing pumps propose the same address and exactly
 *      one batch can commit. A package-owned trigger later dispatches it to
 *      slot::workflow. The acknowledgement is decoupled from trigger delivery:
 *      no circular wait exists between the originating Workflow process and
 *      the later Workflow dispatch.
 *
 * The recipe object itself is NOT loaded here — the run action loads/receives it by RECIPE_REF.
 * This pump only moves the queue cursor and requests the run; the run owns compose, produce,
 * gate, and owner delivery.
 *
 * ANTI-HANG (non-negotiable): every carrier call is bounded by an AbortController timeout. A
 * failed/timed-out call returns null; main() reports and exits non-zero rather than hanging.
 *
 * Env (all DATA, no domain constant in code):
 *   BITFIELD_TARGET_CARRIER_URL, BITFIELD_DISPATCH_PARTITION,
 *   CONTENT_WORK_ITEM_KIND, CONTENT_STATUS_FIELD (default "status"),
 *   CONTENT_PENDING_STATUS (default "pending"), CONTENT_DONE_STATUS (default "queued"),
 *   CONTENT_RUN_DEFINITION_ID, CONTENT_RECIPE_REF, CONTENT_WORK_ITEM_FIELD (default "work_item"),
 *   CONTENT_GROUNDING_FIELD (default "grounding"),
 *   CONTENT_DISPATCH_REQUEST_KIND,
 *   CONTENT_DISPATCH_REQUEST_ADDRESS_TEMPLATE (with {request_id}).
 *
 * GROUNDING HOIST (mode:"provided" support): a recipe whose `context_retrieval.mode` is
 * "provided" (grounding supplied per work item, not corpus-retrieved) expects the run
 * action's TOP-LEVEL `input.grounding` to be populated -- that is what
 * compose-run-request.py's `--grounding-json` binds from (`input.grounding`, not
 * `work_item.grounding`), and what gate-and-build-owner-delivery.py's cite-or-reject check reads.
 * If the selected work-item row itself carries a non-empty CONTENT_GROUNDING_FIELD key
 * (e.g. `grounding: [{source_ref, text}, ...]`), this pump hoists it to `input.grounding`
 * alongside `input.work_item`. Still zero domain vocabulary: the field name is DATA
 * (defaulted, overridable via env), and a work item with no grounding key behaves exactly
 * as before (ungrounded run, unchanged).
 */
import { blake3 } from '@noble/hashes/blake3.js';
const CARRIER_URL = process.env.BITFIELD_TARGET_CARRIER_URL;
const PARTITION_LABEL = process.env.BITFIELD_DISPATCH_PARTITION;
const WORK_ITEM_KIND = process.env.CONTENT_WORK_ITEM_KIND;
const STATUS_FIELD = process.env.CONTENT_STATUS_FIELD || 'status';
const PENDING_STATUS = process.env.CONTENT_PENDING_STATUS || 'pending';
const DONE_STATUS = process.env.CONTENT_DONE_STATUS || 'queued';
const RUN_DEFINITION_ID = process.env.CONTENT_RUN_DEFINITION_ID;
const RECIPE_REF = process.env.CONTENT_RECIPE_REF || '';
const WORK_ITEM_FIELD = process.env.CONTENT_WORK_ITEM_FIELD || 'work_item';
const DISPATCH_REQUEST_KIND = process.env.CONTENT_DISPATCH_REQUEST_KIND || '';
const DISPATCH_REQUEST_ADDRESS_TEMPLATE = process.env.CONTENT_DISPATCH_REQUEST_ADDRESS_TEMPLATE || '';
// Produce-transport selection (DATA env, zero Society): content-generation.run's
// synchronous compose->produce->gate->owner-delivery requires a one-shot produce
// transport (a streaming agent returns items:[] -> gate reads null -> FE_CODEC_ERROR).
// The cadence sets CONTENT_AGENT_REF to a one-shot cli (e.g. claude-oneshot);
// empty falls back to the global selected-agent (unchanged legacy behavior).
const AGENT_REF = process.env.CONTENT_AGENT_REF || '';
const MODEL = process.env.CONTENT_MODEL || '';
const TIMEOUT_MS = 20000;

/** A reviewed item keeps its own DATA-selected recipe; cadence DATA is a fallback
 * for older queue rows that did not carry one. */
export function selectRecipeRef(workItem, cadenceRecipeRef = RECIPE_REF) {
  const itemRef = workItem?.recipe_ref;
  if (itemRef !== undefined && (typeof itemRef !== 'string' || !itemRef.trim())) {
    throw new Error('The selected work item has an invalid recipe_ref.');
  }
  return itemRef?.trim() || cadenceRecipeRef;
}

/** A grounded recipe cannot be dispatched with references but no actual excerpts. */
export function selectWorkItemGrounding(workItem, recipe, field = 'grounding') {
  const excerpts = workItem?.[field];
  const required = recipe?.gate_policy?.grounded === true
    || (typeof recipe?.context_retrieval?.input_refs_field === 'string'
      && recipe.context_retrieval.input_refs_field.trim() !== '');
  if (!required) return Array.isArray(excerpts) ? excerpts : [];
  const minimum = recipe?.gate_policy?.min_excerpts;
  const needed = Number.isSafeInteger(minimum) && minimum > 0 ? minimum : 1;
  const idField = recipe?.gate_policy?.grounding_id_field || 'source_ref';
  if (!Array.isArray(excerpts) || excerpts.length < needed
    || excerpts.some((row) => typeof row?.[idField] !== 'string' || !row[idField].trim()
      || typeof row?.text !== 'string' || !row.text.trim())
    || new Set(excerpts.map((row) => row[idField])).size !== excerpts.length) {
    throw new Error('Grounded recipe lacks valid source excerpts; pending work was not dispatched.');
  }
  return excerpts;
}

function finiteNonNegative(value, fallback = Number.POSITIVE_INFINITY) {
  if (value === '' || value === undefined || value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readQueuePolicy(env) {
  const fields = {
    maxInFlight: 'CONTENT_MAX_IN_FLIGHT',
    maxAssetsPerDay: 'CONTENT_MAX_ASSETS_PER_DAY',
    maxResourceUnitsPerDay: 'CONTENT_MAX_RESOURCE_UNITS_PER_DAY',
    maxCostMinorPerDay: 'CONTENT_MAX_COST_MINOR_PER_DAY',
  };
  return Object.fromEntries(Object.entries(fields).map(([field, name]) => {
    const value = env[name];
    if (value === undefined || value === null || value === '') return [field, Infinity];
    const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`The work limit ${name} must be a nonnegative finite number.`);
    }
    return [field, parsed];
  }));
}

/** Pure admission decision shared by the live pump and capacity tests. All limits are DATA.
 * A missing estimate fails closed only when that dimension has a finite configured limit. */
export function decideQueueAdmission({ workItem, dispatchRequests, nowMs, policy }) {
  const rows = Array.isArray(dispatchRequests) ? dispatchRequests : [];
  const inFlight = rows.filter((row) => row?.lifecycle?.terminal !== true).length;
  if (inFlight >= policy.maxInFlight) return { allowed: false, reason: 'max_in_flight', inFlight };

  const dayStartMs = nowMs - (nowMs % 86_400_000);
  const today = rows.filter((row) => {
    const queuedAtMs = Date.parse(row?.queued_at ?? row?.input?.queued_at ?? '');
    return Number.isFinite(queuedAtMs) && queuedAtMs >= dayStartMs && queuedAtMs <= nowMs;
  });
  const assetsToday = today.reduce((sum, row) => sum + finiteNonNegative(row?.expected_asset_count, 0), 0);
  const resourceToday = today.reduce((sum, row) => sum + finiteNonNegative(row?.estimated_resource_units, 0), 0);
  const costToday = today.reduce((sum, row) => sum + finiteNonNegative(row?.estimated_cost_minor, 0), 0);
  const estimate = (value, limit) => finiteNonNegative(value, Number.isFinite(limit) ? Number.POSITIVE_INFINITY : 0);
  const expectedAssets = estimate(workItem?.expected_asset_count, policy.maxAssetsPerDay);
  const estimatedResource = estimate(workItem?.estimated_resource_units, policy.maxResourceUnitsPerDay);
  const estimatedCost = estimate(workItem?.estimated_cost_minor, policy.maxCostMinorPerDay);

  if (assetsToday + expectedAssets > policy.maxAssetsPerDay) {
    return { allowed: false, reason: 'max_assets_per_day', assetsToday, expectedAssets };
  }
  if (resourceToday + estimatedResource > policy.maxResourceUnitsPerDay) {
    return { allowed: false, reason: 'max_resource_units_per_day', resourceToday, estimatedResource };
  }
  if (costToday + estimatedCost > policy.maxCostMinorPerDay) {
    return { allowed: false, reason: 'max_cost_minor_per_day', costToday, estimatedCost };
  }
  return { allowed: true, reason: 'admitted', inFlight, assetsToday, expectedAssets, resourceToday, estimatedResource, costToday, estimatedCost };
}

// Stable JSON is the idempotency primitive. Object keys are sorted recursively,
// so two callers observing the same queue row + configured action produce the
// same durable request address regardless of incidental JS key insertion order.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// A deterministic, portable string identity. We deliberately do not use wall
// clock time: retries and concurrent drains must converge on one claim.
export function deterministicRequestId({ workItemId, definitionId, recipeRef, input }) {
  const material = canonicalJson({ workItemId, definitionId, recipeRef, input });
  return `dispatch:1f:${Buffer.from(blake3(new Uint8Array(Buffer.from(material)))).toString('hex')}:${encodeURIComponent(String(workItemId))}`;
}

async function runningAppRequests() {
  // This helper is a separately declared immutable process mount. All npm
  // dependencies are bundled; do not fall back to host module resolution.
  return import(new URL('./send-requests-to-running-app.mjs', import.meta.url).href);
}

// PURE (exported for tests): deterministic pick order — sorted by id ascending, first pending wins.
export function selectNextPending(rows, statusField = STATUS_FIELD, pendingStatus = PENDING_STATUS) {
  const pending = (Array.isArray(rows) ? rows : []).filter((r) => r && r[statusField] === pendingStatus);
  if (!pending.length) return null;
  return pending.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

// A declined item remains pending. Other eligible work can proceed without
// replacing that item's outcome or weakening the same capacity checks.
export function selectNextAdmitted({ rows, dispatchRequests, nowMs, policy, statusField = STATUS_FIELD, pendingStatus = PENDING_STATUS }) {
  const pending = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row[statusField] === pendingStatus)
    .slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const workItem of pending) {
    const admission = decideQueueAdmission({ workItem, dispatchRequests, nowMs, policy });
    if (admission.allowed) return { workItem, admission };
    if (admission.reason === 'max_in_flight') break;
  }
  return null;
}

// PURE (exported for tests): one durable, opaque owner-action request. The record
// carries the definition and input as DATA; trigger-engine provides the generic
// record-delta -> Envelope dispatch after this pump releases Workflow.
export function buildDispatchRequest(kind, requestId, definitionId, input) {
  return {
    kind,
    id: requestId,
    request_id: requestId,
    definition_id: definitionId,
    input,
    lifecycle: {
      state: 'pending',
      attempt: 0,
      terminal: false,
    },
    idempotency_key: requestId,
  };
}

export function addressForRequest(template, requestId) {
  return String(template || '').replaceAll('{request_id}', requestId);
}

// The exact all-or-nothing mutation emitted by every drain attempt. Keeping the
// shape pure makes its single-flight contract executable without a Studio shell:
// a claim collision rejects the entire batch, including the cursor transition.
export function buildEnqueueWrites({
  partitionLabel,
  requestAddress,
  request,
  workItem,
  statusField,
  doneStatus,
  queuedAt,
}) {
  return [
    {
      partition_label: partitionLabel,
      address_label: requestAddress,
      address_mode: 'identity_text',
      path_labels: ['current-item', 'published-record'],
      payload: request,
      expected_current: { payload_hash_base64: null },
    },
    {
      partition_label: partitionLabel,
      address_label: workItem.id,
      address_mode: 'identity_text',
      path_labels: ['current-item', 'published-record'],
      payload: {
        ...workItem,
        [statusField]: doneStatus,
        dispatch_request_id: request.request_id,
        queued_at: queuedAt,
      },
    },
  ];
}

async function main() {
  // Validate configured ceilings before opening a session or reading any work.
  const policy = readQueuePolicy(process.env);
  const missing = [];
  if (!CARRIER_URL) missing.push('BITFIELD_TARGET_CARRIER_URL');
  if (!PARTITION_LABEL) missing.push('BITFIELD_DISPATCH_PARTITION');
  if (!WORK_ITEM_KIND) missing.push('CONTENT_WORK_ITEM_KIND');
  if (!RUN_DEFINITION_ID) missing.push('CONTENT_RUN_DEFINITION_ID');
  if (!DISPATCH_REQUEST_KIND) missing.push('CONTENT_DISPATCH_REQUEST_KIND');
  if (!DISPATCH_REQUEST_ADDRESS_TEMPLATE) missing.push('CONTENT_DISPATCH_REQUEST_ADDRESS_TEMPLATE');
  if (missing.length) {
    console.error('Missing required env: ' + missing.join(', '));
    process.exit(1);
  }
  const requests = await runningAppRequests();
  const session = await requests.startRunningAppSession({ url: CARRIER_URL, timeoutMs: TIMEOUT_MS });
  const rows = await requests.findCurrentRecords(session, WORK_ITEM_KIND, {
    limit: 10000,
    timeoutMs: TIMEOUT_MS,
  });
  if (!selectNextPending(rows)) {
    console.log(`[content-generation:drain] no pending ${WORK_ITEM_KIND} — queue drained`);
    return;
  }
  const dispatchRequests = await requests.findCurrentRecords(session, DISPATCH_REQUEST_KIND, {
    limit: 10000,
    timeoutMs: TIMEOUT_MS,
  });
  const selected = selectNextAdmitted({
    rows,
    dispatchRequests,
    nowMs: Date.now(),
    policy,
  });
  if (!selected) {
    console.log('Pending work remains open; none fits the current capacity limits.');
    return;
  }
  const { workItem: next, admission } = selected;
  const selectedRecipeRef = selectRecipeRef(next);
  // content-generation.run correlates produce -> read_result -> gate -> owner delivery
  // by request_id; without one the produced result is unfindable and no owner action
  // can be requested. Derive a deterministic identity from immutable queue/action
  // inputs (a work item may provide a durable request_id override). context
  // defaults to {}.
  // Build the action input before deriving its identity. The fixed-point is
  // intentionally avoided: the action input receives the derived id only after
  // its immutable queue/action material has selected the durable claim.
  const identityInput = { [WORK_ITEM_FIELD]: { ...next }, context: {} };
  const requestId = (typeof next.request_id === 'string' && next.request_id)
    || deterministicRequestId({
      workItemId: next.id,
      definitionId: RUN_DEFINITION_ID,
      recipeRef: selectedRecipeRef,
      input: identityInput,
    });
  const input = { ...identityInput, [WORK_ITEM_FIELD]: { ...identityInput[WORK_ITEM_FIELD], request_id: requestId }, request_id: requestId };
  if (selectedRecipeRef) {
    // action:content-generation.run requires a resolved `recipe` OBJECT (input_schema:
    // required ["recipe","work_item"]) -- it has no step of its own that turns a ref into
    // a record. This pump is the one place that already holds a live queue read, so it
    // resolves the selected item's recipe_ref (or cadence fallback) -> the full
    // content-generation.recipe row here, generically (by
    // kind + id, no domain field named). recipe_ref is still passed through for tracing.
    input.recipe_ref = selectedRecipeRef;
    const recipeRows = await requests.findCurrentRecords(session, 'content-generation.recipe', {
      limit: 10000,
      timeoutMs: TIMEOUT_MS,
    });
    const resolvedRecipe = recipeRows.find((r) => r && r.id === selectedRecipeRef) || null;
    if (resolvedRecipe) {
      input.recipe = resolvedRecipe;
    } else {
      throw new Error(`Selected recipe_ref=${selectedRecipeRef} is missing; pending work was not dispatched.`);
    }
  }
  // GROUNDING HOIST (mode:"provided"): if the work item carries grounding, hoist
  // it to top-level input so compose-run-request.py's --grounding-json and
  // gate-and-build-owner-delivery.py's cite-or-reject can find it (not buried in work_item).
  const groundingField = process.env.CONTENT_GROUNDING_FIELD || 'grounding';
  const selectedGrounding = selectWorkItemGrounding(next, input.recipe, groundingField);
  if (selectedGrounding.length) input.grounding = selectedGrounding;
  // Forward the DATA-selected produce transport (one-shot cli) so the cadence's
  // run resolves a compute.process cli, not a streaming one. A work-item row may
  // override per-item (next.agent_ref); else the env default.
  const itemAgentRef = typeof next.agent_ref === 'string' ? next.agent_ref : '';
  const itemModel = typeof next.model === 'string' ? next.model : '';
  if (itemAgentRef || AGENT_REF) input.agent_ref = itemAgentRef || AGENT_REF;
  if (itemModel || MODEL) input.model = itemModel || MODEL;
  const queuedAt = new Date().toISOString();
  const dispatchRequest = buildDispatchRequest(
    DISPATCH_REQUEST_KIND,
    requestId,
    RUN_DEFINITION_ID,
    input,
  );
  dispatchRequest.queued_at = queuedAt;
  dispatchRequest.expected_asset_count = admission.expectedAssets;
  dispatchRequest.estimated_resource_units = admission.estimatedResource;
  dispatchRequest.estimated_cost_minor = admission.estimatedCost;
  const writeReply = await requests.writeRecords(session, buildEnqueueWrites({
    partitionLabel: PARTITION_LABEL,
    requestAddress: addressForRequest(DISPATCH_REQUEST_ADDRESS_TEMPLATE, requestId),
    request: dispatchRequest,
    workItem: next,
    statusField: STATUS_FIELD,
    doneStatus: DONE_STATUS,
    queuedAt,
  }), { timeoutMs: TIMEOUT_MS });
  if (!writeReply) {
    console.error(`[content-generation:drain] durable dispatch handoff failed id=${next.id}`);
    process.exit(1);
  }
  console.log(`[content-generation:drain] queued id=${next.id} request=${requestId}`);
}

// Run only as the process entry (env set in prod); a test importing this module skips main().
if (process.env.BITFIELD_TARGET_CARRIER_URL) {
  main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
}
