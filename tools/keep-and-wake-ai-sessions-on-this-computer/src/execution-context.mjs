import { readBoundedJson } from './read-bounded-json.mjs';
import { answerWithin } from './connecting-without-the-store.mjs';
import { CONTENT_IDENTITY } from './namespace-preview.mjs';
import { inspectionRecordId, nativeInspectionAddress } from './record-model-tools.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Source receipts for actions, kept by the existing EEAF record owner. The activity feed is a bounded projection;
// this record and its ordinary EEAF history retain the source and references after a feed generation expires.
// A receipt says what was captured, by whom, and when. A provider response is not an independent outcome check.
// No input, output, authorization token, header collection, transcript text or secret is copied into a receipt.
// Client claims are never promoted to authenticated identity. Corrections make a new attributed record.

export const EXECUTION_TYPE = 'execution';
export const EXECUTION_HEADER = 'x-trillion-execution';
export const SOURCE_CAPTURE_HEADER = 'x-trillion-source-capture';
// A Lists mutation owns at most 200 rows plus its list record. Keep every exact target, with a separate byte
// ceiling so admitting that existing operation never admits an unbounded receipt or silently truncates an id.
export const EXECUTION_LIMITS = Object.freeze({ id_chars: 8192, label_chars: 512, links: 201, link_bytes: 524288, page: 100 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const SOURCE_FIELDS = ['source_ref', 'conversation_id', 'parent_call_id', 'agent_id', 'agent_name', 'model', 'handoff_id', 'case_id', 'work_ref', 'proof_ref'];
const LINK_FIELDS = ['task_id', 'effect_ref', 'sent_ref', 'record_ref', 'source_ref', 'conversation_id', 'handoff_id', 'case_id', 'work_ref', 'proof_ref', 'parent_call_id'];
const PROVIDER_FIELDS = ['provider', 'account', 'connection_id', 'provider_origin', 'dispatch_route', 'response_ref', 'object_id', 'route', 'source_ref'];
const ORIGINS = ['real', 'synthetic', 'unknown'];
const CAPTURES = ['managed_dispatch', 'internal_dispatch', 'host_transcript', 'explicit_recording'];
const PHASES = ['dispatching', 'returned', 'failed', 'unknown', 'recorded'];

// These are the query routes of the shipped readOnlyHint tools, plus the existing Workshop screen and record
// queries. The transport verb alone cannot classify them: each accepts a POST body without performing the
// requested mutation. A regression walks the shipped tools' actual mocked calls so this boundary stays aligned.
const POST_READS = new Set([
  '/cases/one-pass/questions', '/tools/list', '/tools/screens', '/tools/describe', '/tools/find', '/records/find', '/records/as-of', '/records/erasure-check', '/read-link',
  '/marketplace/for-you', '/network/find', '/agents/find', '/agents/events/read', '/handoffs/read', '/handoffs/open-page',
  '/carried/status', '/carried/read-incoming', '/carried/read', '/shared-with-me/read', '/content-formats/shape',
  '/content-formats/follow', '/score', '/local-choices/coverage', '/workflows/find', '/workflows/describe', '/workflows/snapshot',
  '/shared-library/search', '/posts/connect', '/posts/check', '/posts/read', '/posts/voice/read', '/posts/snippet/list', '/posts/summary/read', '/looks/read', '/mcp-events/list',
  '/work-for-ais/read', '/activation/waiting', '/controls/read', '/controls/inspect', '/layouts/history', '/show-rules/accounts',
  '/namespace/files/lookup', '/namespace/contents/read', '/namespace/listing', '/namespace/folders-under', '/namespace/names-starting', '/namespace/tags/read',
]);
// Synchronization retains the original records' actors; adding receipts for its own empty pulls would change
// the root being synchronized forever. Notification/brief cursors likewise keep their existing owner/history.
// The operator's one-time raw export of a retiring store is proved by the export's own manifest (each part read back
// by its BLAKE3); a receipt in the operator's own store would block it once that store's own records are fenced.
// Its one-time import into a named account (src/operator-import.mjs) is likewise proved by its own audit lines and the
// receiving book's own command receipts, not by a receipt in the operator's store.
const POST_MAINTENANCE = new Set(['/records/settle', '/notices/unseen', '/spaces/briefs', '/activation/bind', '/storage/export', '/storage/export-store', '/storage/export-readback', '/storage/export-erasure-source', '/storage/policy-source-exit', '/storage/erasure-state', '/storage/erasure-redrive', '/storage/store-ids', '/storage/written-since', '/storage/fence', '/storage/retire', '/storage/carry-out', '/storage/import']);
// These doors retain the original source with its authenticated recorder before opening any work. A second
// dispatch receipt for recording that source duplicates it on every retry; actual actions still capture at dispatch.
const POST_SOURCE_CAPTURES = new Set(['/messages', '/inbound']);
const POST_READ_FAMILIES = [
  /^\/spaces\/[^/]+\/workshop\/(?:find|describe|read|snapshot)$/,
  /^\/spaces\/[^/]+\/(?:agents\/find|handoffs\/read)$/,
  /^\/source-projects\/[^/]+\/(?:resolve|verify)$/,
  /^\/community\/[^/]+\/free-times$/,
  /^\/lists\/[^/]+\/(?:rows\/preview|aggregate)$/,
  /^\/lists\/[^/]+\/settlement\/(?:propose|position|balance|totals|basis)$/,
  /^\/community\/[^/]+\/quiet-hours$/,
];

/** Server-owned request semantics only. Unrecognized verbs, paths and mixed-operation bodies remain mutations. */
export function executionRequestKind(method, path, body = null) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'read';
  if (method !== 'POST') return 'mutation';
  if (path === '/executions' || POST_SOURCE_CAPTURES.has(path)) return 'explicit_capture';
  if (POST_MAINTENANCE.has(path)) return 'maintenance';
  if (POST_READS.has(path) || POST_READ_FAMILIES.some(pattern => pattern.test(path))) return 'read';
  if (path === '/databases' && object(body) && (['read', 'search', 'resolve', 'view'].includes(body.action) || body.action === 'records' && ['read', 'rows', 'schema', 'schema-history', 'history', 'model', 'find', 'export'].includes(body.record_action))) return 'read';
  if (path === '/database-provider' && object(body) && body.action === 'current') return 'read';
  if (path === '/capabilities' && object(body) && ['read', 'describe', 'resolve', 'readBinding', 'resolveBinding'].includes(body.action)) return 'read';
  if (path === '/saved-logins' && object(body) && Object.keys(body).length === 1 && typeof body.read === 'string' && body.read) return 'read';
  return 'mutation';
}

// The operations whose every effect is inside the person's own store (their lists): a receipt of one is kept
// started-and-returned in the same write as the data it changed, not as a start before and a finish after (two more
// rows for each). Anything else may leave the store (a send, a payment, a call out), so its start is durable before
// dispatch and a crash leaves it "started, outcome unknown". MCP tools by name, store routes as `METHOD path`.
const INTERNAL_ONLY = Object.freeze({ tools: ['put_list_rows', 'save_list'], routes: [/^POST \/lists(?:\/[^/]+(?:\/rows)?)?$/] });
export const internalOnlyOperation = operation => typeof operation === 'string'
  && (INTERNAL_ONLY.tools.includes(operation) || INTERNAL_ONLY.routes.some(pattern => pattern.test(operation)));

export async function needsExecutionCapture(request, path = new URL(request.url).pathname) {
  let body = null;
  // Mixed query routes classify only an admitted body. Malformed or oversized input stays a mutation.
  if (request.method === 'POST' && (path === '/databases' || path === '/database-provider' || path === '/capabilities')) body = await readBoundedJson(request.clone(), 2_000_000, new Error('Request is too large.')).catch(() => null);
  else if (request.method === 'POST' && path === '/saved-logins') body = await request.clone().json().catch(() => null);
  return executionRequestKind(request.method, path, body) === 'mutation';
}

/** A returned action and a failed receipt finalization are different facts. This helper never dispatches an action. */
export async function completeExecutionCapture(ref, update, finish, options = {}) {
  const incomplete = reason => ({ execution: null, source_capture: { state: 'incomplete', execution_ref: ref,
    reason, recovery: 'reconcile_receipt_only', dispatch_retry: 'do_not_repeat' } });
  // Dispatch has already returned. A remote receipt write must not turn its known answer into an unknown
  // action timeout. The same write continues with the host; neither this helper nor late recovery dispatches.
  // In-store callers omit waitUntil and still finish inside their existing write boundary.
  const finishing = Promise.resolve().then(async () => ({
    execution: await finish(ref, typeof update === 'function' ? await update() : update), source_capture: null,
  })).catch(() => incomplete('receipt_finalization_failed'));
  if (typeof options.waitUntil !== 'function') return finishing;
  return await answerWithin(finishing, options) ?? incomplete('receipt_finalization_pending');
}

export const withSourceCapture = (result, source_capture) => !source_capture ? result
  : object(result) ? { ...result, source_capture } : { result, source_capture };

/** Keep the HTTP status and body intact; internal MCP transport projects this explicit metadata beside its result. */
export function responseWithSourceCapture(response, source_capture) {
  if (!source_capture) return response;
  const headers = new Headers(response.headers);
  headers.set(SOURCE_CAPTURE_HEADER, JSON.stringify(source_capture));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Identifiers are kept exactly or rejected with an explicit limit; truncating one could join unrelated actions. */
export function executionText(value, field, limit = EXECUTION_LIMITS.id_chars) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${field} must be text.`);
  const text = String(value);
  if (text.length > limit) throw new Error(`${field} exceeds the ${limit} character capture limit; it was not truncated.`);
  return text || null;
}
const fieldsOf = (value, fields) => Object.fromEntries(fields.flatMap(field => {
  const text = executionText(value?.[field], field, ['agent_name', 'model', 'app', 'operation'].includes(field) ? EXECUTION_LIMITS.label_chars : EXECUTION_LIMITS.id_chars);
  return text === null ? [] : [[field, text]];
}));
const timeOf = (value, fallback) => {
  const text = value ?? fallback;
  if (typeof text !== 'string' || !Number.isFinite(Date.parse(text))) throw new Error('A captured or observed time must be a date and time.');
  return new Date(text).toISOString();
};
export const executionRef = value => {
  const text = executionText(value, 'execution_ref');
  return text ? executionText(text.startsWith('execution:') ? text : `execution:${text}`, 'execution_ref') : null;
};
export const executionRecorder = value => ({
  ...fieldsOf(value, ['reader', 'app']),
  basis: value?.reader ? 'authenticated' : 'server',
  app_basis: ['authenticated', 'client_declared', 'unknown'].includes(value?.app_basis) ? value.app_basis : 'unknown',
});

/** Source fields supplied by a client stay in claimed; a card is an identity snapshot validated by its owner. */
export function executionContext(value = {}, { recorder = {}, card = null, cardSelection = null, now = new Date().toISOString(), managed = false } = {}) {
  const call_id = executionText(value.call_id, 'call_id') ?? (value.execution_ref ? executionRef(value.execution_ref).slice('execution:'.length) : crypto.randomUUID());
  const capture_kind = managed ? (value.capture_kind === 'internal_dispatch' ? 'internal_dispatch' : 'managed_dispatch')
    : CAPTURES.includes(value.capture_kind) && !['managed_dispatch', 'internal_dispatch'].includes(value.capture_kind) ? value.capture_kind : 'explicit_recording';
  const claimed = fieldsOf({ ...value, ...(object(value.claimed) ? value.claimed : {}) }, [...SOURCE_FIELDS, 'app', 'tool_call_id']);
  const snapshot = card ? fieldsOf({ agent_id: card.agent_id, agent_name: card.name, model: card.model, conversation_id: card.source_id }, SOURCE_FIELDS) : {};
  return {
    execution_ref: executionRef(value.execution_ref ?? call_id), call_id,
    ...fieldsOf(value, ['operation']),
    ...(value.request_id !== undefined ? { request_id: executionText(value.request_id, 'request_id') } : {}),
    ...(Number.isInteger(value.batch_index) && value.batch_index >= 0 ? { batch_index: value.batch_index } : {}),
    capture_kind, origin: ORIGINS.includes(value.origin) ? value.origin : managed ? 'real' : 'unknown',
    captured_at: timeOf(value.captured_at, now),
    recorder: executionRecorder(recorder),
    actor: { ...snapshot, basis: card ? 'registered_agent_snapshot' : 'unknown',
      ...(card && cardSelection === 'caller_named_reader_bound_card' ? { selection_basis: cardSelection } : {}) },
    ...(managed ? fieldsOf(value, ['parent_call_id', 'work_ref', 'handoff_id', 'case_id', 'source_ref']) : {}),
    ...(Object.keys(claimed).length ? { claimed } : {}),
  };
}

export function executionLinks(value = {}) {
  const links = fieldsOf(value, LINK_FIELDS);
  const refs = value.record_refs ?? [];
  if (!Array.isArray(refs) || refs.length > EXECUTION_LIMITS.links) throw new Error(`record_refs accepts at most ${EXECUTION_LIMITS.links} references.`);
  if (refs.length) {
    links.record_refs = [...new Set(refs.map(ref => executionText(ref, 'record_refs')).filter(Boolean))];
    if (new TextEncoder().encode(JSON.stringify(links.record_refs)).byteLength > EXECUTION_LIMITS.link_bytes) throw new Error(`Execution record references exceed the ${EXECUTION_LIMITS.link_bytes} byte capture limit; they were not truncated.`);
  }
  return links;
}

/** Ordered, bounded references named at an observed boundary. A field's presence is not proof of consumption. */
export function executionReferences(value = [], { claimed = false } = {}) {
  if (!Array.isArray(value) || value.length > EXECUTION_LIMITS.links) throw new Error(`Execution references accept at most ${EXECUTION_LIMITS.links} entries; they were not truncated.`);
  const seen = new Set();
  const references = value.map(entry => {
    if (!object(entry)) throw new Error('An execution reference must be an object.');
    const ref = executionText(entry.ref, 'execution reference');
    const role = executionText(entry.role, 'execution reference role', 80);
    if (!ref || !role || /[\u0000-\u001f]/.test(role)) throw new Error('An execution reference needs its exact ref and role.');
    const basis = claimed ? 'claimed' : entry.basis;
    if (!['explicit_input', 'tool_result', 'claimed'].includes(basis)) throw new Error('Unknown execution reference basis.');
    const path = entry.path ?? [];
    if (!Array.isArray(path) || path.length > 32 || path.some(part => !(typeof part === 'string' && part.length <= EXECUTION_LIMITS.label_chars || Number.isInteger(part) && part >= 0))) throw new Error('An execution reference path must be a bounded field path.');
    if (entry.ordinal !== undefined && (!Number.isInteger(entry.ordinal) || entry.ordinal < 0)) throw new Error('An execution reference ordinal must be a nonnegative integer.');
    return { ref, role, basis, path, ...(entry.ordinal === undefined ? {} : { ordinal: entry.ordinal }) };
  }).filter(entry => { const key = JSON.stringify(entry); if (seen.has(key)) return false; seen.add(key); return true; });
  if (new TextEncoder().encode(JSON.stringify(references)).byteLength > EXECUTION_LIMITS.link_bytes) throw new Error(`Execution references exceed the ${EXECUTION_LIMITS.link_bytes} byte capture limit; they were not truncated.`);
  return references;
}

// The existing scope projection reads record_refs participation. Keep native/explicit reference metadata
// reachable there in the SAME receipt write, using the existing model address resolver. Only lookup keys are
// normalized; the original identities, roles, paths and ordinals remain in references. No alias is duplicated.
function referenceLookupLinks(eeaf, value, references = []) {
  const links = executionLinks(value), declarations = new Map();
  const records = { read(id) { if (!declarations.has(id)) declarations.set(id, eeaf.read(id)); return declarations.get(id); } };
  const record_refs = [...new Set([...(links.record_refs ?? []), ...references.map(reference => reference.ref)]
    .map(ref => inspectionRecordId(records, ref).id))];
  return executionLinks({ ...links, ...(record_refs.length ? { record_refs } : {}) });
}

/** Apply the selector owner's retention gates before ANY alias of a boundary reference becomes durable.
 * `capture` and its access needs are ephemeral server context. A restricted reference is removed even when the
 * same result also returned it in a generic id/source slot. Ordinary calls need no capability/history lookup. */
export function admittedExecutionCapture(value = {}, capabilities = []) {
  const { capture, ...plain } = value;
  if (!capture) return plain;
  const needs = capture.kept_with;
  const blocked = Boolean(needs?.row && !capabilities.includes(needs.row));
  // Namespace aliases name the same immutable bytes. Admission compares the same canonical address used by
  // the lookup projection, before any alias is retained. File normalization is pure: no managed history read.
  const captureKey = value => {
    const ref = String(value).trim();
    return CONTENT_IDENTITY.test(ref.replace(/^file:/, '')) ? inspectionRecordId({ read: () => null }, ref).id : ref;
  };
  const denied = new Set((needs?.ids ?? []).filter(need => !capabilities.includes(need.access)).map(need => captureKey(need.id)));
  const allowed = ref => !blocked && !denied.has(captureKey(ref));
  const references = executionReferences([...(plain.references ?? []), ...(capture.references ?? [])].filter(entry => allowed(entry.ref)));
  const withoutDenied = fields => Object.fromEntries(Object.entries(fields ?? {}).filter(([, ref]) => allowed(ref)));
  const links = withoutDenied(plain.links);
  const recordRefs = [...new Set([...(plain.links?.record_refs ?? []), ...references.map(entry => entry.ref)].filter(allowed))];
  delete links.record_refs;
  if (recordRefs.length) links.record_refs = recordRefs;
  const sourceFields = new Set(['source_ref', 'parent_call_id', 'handoff_id', 'case_id', 'work_ref', 'proof_ref']);
  const keepSource = fields => Object.fromEntries(Object.entries(fields ?? {}).filter(([field, ref]) => !sourceFields.has(field) || allowed(ref)));
  const observation = plain.observation ? withoutDenied(plain.observation) : undefined;
  return { ...keepSource(plain), links, references,
    ...(plain.claimed ? { claimed: keepSource(plain.claimed) } : {}), ...(observation ? { observation } : {}) };
}

/** A dispatch response, an independent readback, and a client claim remain different evidence. */
export function providerObservation(value, { basis = 'claimed', now = new Date().toISOString(), origin = 'unknown' } = {}) {
  if (!object(value)) return null;
  const fields = fieldsOf(value, PROVIDER_FIELDS);
  if (!Object.keys(fields).length) return null;
  return { ...fields, basis, origin: ORIGINS.includes(value.origin) ? value.origin : origin,
    observed_at: timeOf(value.observed_at, now),
    ...(Number.isInteger(value.decision_generation) ? { decision_generation: value.decision_generation } : {}) };
}

export function recordExecution(eeaf, value = {}, recorder = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const namedRef = value.call_id || value.execution_ref ? executionRef(value.execution_ref ?? value.call_id) : null;
  const prior = namedRef ? eeaf.read(namedRef) : null;
  const context = executionContext({ ...(prior?.operation ? { operation: prior.operation } : {}), ...value }, { ...options, recorder, now });
  const existing = namedRef === context.execution_ref ? prior : eeaf.read(context.execution_ref);
  if (existing) {
    const operationMatches = existing.operation === context.operation || existing.capture_kind === 'host_transcript' && !existing.operation;
    if (existing.call_id !== context.call_id || !operationMatches || existing.capture_kind !== context.capture_kind) throw new Error('This execution reference already belongs to a different captured action.');
    if (context.capture_kind !== 'host_transcript' || !value.event_phase) return existing;
    // The same native call is observed at its input and result boundaries. Reuse the owner's bounded merge:
    // a result must not discard its input references, and replay must not manufacture another receipt/version.
    // Both observations remain caller claims; a transcript is not a managed dispatch or a consumption check.
    const references = executionReferences(value.references, { claimed: true });
    const event = { ...executionUpdateRecord(eeaf, existing.execution_ref, { links: referenceLookupLinks(eeaf, value.links, references), references }, now,
      { existing: { ...existing, links: referenceLookupLinks(eeaf, existing.links, existing.references) } }).value,
      ...(!existing.operation && context.operation ? { operation: context.operation } : {}),
      event_phase: value.event_phase === 'called' && ['returned', 'failed'].includes(existing.event_phase) ? existing.event_phase
        : ['called', 'returned', 'failed'].includes(value.event_phase) ? value.event_phase : 'unknown',
      ...(value.references ? { coverage: { ...existing.coverage, references: 'declared_metadata_only' } } : {}),
      ...(value.observation ? { observation: providerObservation(value.observation,
        { now: value.captured_at ?? existing.observation?.observed_at ?? now, origin: existing.origin }) } : {}) };
    const { updated_at: _was, ...before } = existing;
    const { updated_at: _next, ...after } = event;
    if (JSON.stringify(before) === JSON.stringify(after)) return existing;
    eeaf.write([{ id: event.execution_ref, type: EXECUTION_TYPE, value: event }], { actor: executionRecorder(recorder) });
    return event;
  }
  const corrects = value.corrects ? executionRef(value.corrects) : null;
  if (corrects && !eeaf.read(corrects)) throw new Error('The execution being corrected was not found.');
  const references = executionReferences(value.references, { claimed: options.managed !== true });
  const record = { ...context, phase: options.managed ? 'dispatching' : 'recorded',
    links: options.managed ? executionLinks(value.links) : referenceLookupLinks(eeaf, value.links, references),
    ...(references.length ? { references } : {}),
    created_at: now, updated_at: now,
    ...(value.event_phase ? { event_phase: ['called', 'returned', 'failed'].includes(value.event_phase) ? value.event_phase : 'unknown' } : {}),
    ...(corrects ? { corrects, correction_reason: executionText(value.correction_reason, 'correction_reason', EXECUTION_LIMITS.label_chars) } : {}),
    ...(value.observation ? { observation: providerObservation(value.observation,
      { now: context.capture_kind === 'host_transcript' ? value.captured_at ?? now : now, origin: context.origin }) } : {}),
    coverage: { before_dispatch: options.managed === true, input_output: 'not_captured', native_host: options.managed ? 'managed_boundary_only' : 'caller_supplied_evidence',
      ...(context.capture_kind === 'host_transcript' && value.references ? { references: 'declared_metadata_only' } : {}) },
  };
  // `defer`: the start of an internal-only operation is held by its owner and written with the data (or alone, once,
  // when it finishes without one); see internalOnlyOperation.
  if (!options.defer) eeaf.write([{ id: record.execution_ref, type: EXECUTION_TYPE, value: record }], { actor: executionRecorder(recorder) });
  return record;
}

/** An owner can compose this version into the same EEAF write as the actual records it changes. */
export function executionUpdateRecord(eeaf, ref, update = {}, now = new Date().toISOString(), { held = null, existing = undefined } = {}) {
  const key = executionRef(ref);
  // Reuse the caller's exact lookup; a held start is the fallback before its first data write.
  const prior = key && ((existing === undefined ? eeaf.read(key) : existing) ?? held);
  if (!prior) throw new Error('The execution source must be kept before its result.');
  if (update.phase && !PHASES.includes(update.phase)) throw new Error('Unknown execution phase.');
  const links = { ...(prior.links ?? {}), ...executionLinks(update.links) };
  if (prior.links?.record_refs || update.links?.record_refs) links.record_refs = [...new Set([...(prior.links?.record_refs ?? []), ...(update.links?.record_refs ?? [])])];
  executionLinks(links);
  const references = executionReferences([...new Map([...(prior.references ?? []), ...(update.references ?? [])].map(entry => [JSON.stringify(entry), entry])).values()]);
  const record = { ...prior, ...(update.phase ? { phase: update.phase } : {}), links, updated_at: now,
    ...(references.length ? { references } : {}),
    ...(update.error_code ? { error_code: executionText(update.error_code, 'error_code', EXECUTION_LIMITS.label_chars) } : {}),
    ...(update.observation ? { observation: providerObservation(update.observation, { basis: 'provider_response', now, origin: prior.origin }) } : {}) };
  return { id: key, type: EXECUTION_TYPE, value: record };
}

/** Only owner integrations call this. It appends an EEAF version and preserves the original actor and recorder. */
export function updateExecution(eeaf, ref, update = {}, recorder = {}, now = new Date().toISOString(), { held = null } = {}) {
  const prior = eeaf.read(executionRef(ref));
  const record = executionUpdateRecord(eeaf, ref, update, now, { held, existing: prior });
  // An update that changes nothing but its time writes nothing (a finish of what the data write already returned).
  const { updated_at: _was, ...before } = prior ?? {};
  const { updated_at: _now, ...after } = record.value;
  if (prior && JSON.stringify(before) === JSON.stringify(after)) return prior;
  eeaf.write([record], { actor: executionRecorder(recorder) });
  return record.value;
}

export const readExecution = (eeaf, ref) => { const key = executionRef(ref); return key ? eeaf.read(key) ?? null : null; };

const LOOKUP_CURSOR = 'execution-lookup:';
const LOOKUP_TYPES = [EXECUTION_TYPE, 'record:sent'];
const cursorError = () => Object.assign(new Error('This execution lookup cursor does not belong to this item and provider. Start from its first page.'), { code: 'execution_cursor_invalid' });
function executionLookup(query) {
  const needle = executionText(query.object_id ?? query.item, 'item');
  const provider = executionText(query.provider, 'provider'), account = executionText(query.account, 'account');
  const objectId = executionText(query.object_id, 'object_id');
  const native = !provider && !account && !objectId ? nativeInspectionAddress(needle) : null;
  const target = native?.id ?? needle;
  // Keep long exact identities out of an already bounded relation cursor. This binds pagination to the query;
  // it is not authorization or a stored fact, and a continued page never claims complete historical coverage.
  const binding = bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([needle, provider, account, objectId]))));
  const initial = { needle, target, native, binding, relation: query.cursor || null, relation_done: false,
    search: { kind: 0, before: null }, continued: Boolean(query.cursor) };
  if (query.cursor === null || query.cursor === undefined || query.cursor === '') return initial;
  if (typeof query.cursor !== 'string' || query.cursor.length > 32768) throw cursorError();
  if (!query.cursor.startsWith(LOOKUP_CURSOR)) return initial; // Existing record-scope cursors keep their owner.
  let cursor;
  try { cursor = JSON.parse(query.cursor.slice(LOOKUP_CURSOR.length)); } catch { throw cursorError(); }
  if (!object(cursor) || cursor.query !== binding || typeof cursor.relation_done !== 'boolean'
    || cursor.relation !== null && !object(cursor.relation) || !object(cursor.search)
    || !Number.isInteger(cursor.search.kind) || cursor.search.kind < 0 || cursor.search.kind > LOOKUP_TYPES.length
    || cursor.search.before !== null && (typeof cursor.search.before !== 'string' || !cursor.search.before || cursor.search.before.length > EXECUTION_LIMITS.id_chars)) throw cursorError();
  return { ...initial, relation: cursor.relation === null ? null : JSON.stringify(cursor.relation),
    relation_done: cursor.relation_done, search: cursor.search };
}

/** Reuse one bounded relation page in trace and receipt reads. A composite cursor is never sent to scope's owner. */
export function executionReferencePage(query, references, kinds = []) {
  if (typeof references !== 'function') return null;
  const lookup = executionLookup(query);
  if (!lookup.target) return null;
  if (lookup.relation_done) return { records: [], coverage: { complete: false, examined: 0, more: false,
    next_cursor: null, index_complete: false, model_index_complete: false, pagination: 'live_index', consistent_snapshot: false,
    read: 'relation_page_already_consumed' } };
  return references(lookup.target, { limit: Math.max(1, Math.min(EXECUTION_LIMITS.page, Number(query.limit) || EXECUTION_LIMITS.page)),
    kinds, cursor: lookup.relation });
}

// Both record engines expose bounded type/id pages. Their text searches have different work contracts, so a
// sparse raw/provider id must not use find(): LIMIT there bounds matches, not the history examined.
function executionCandidatePage(eeaf, start, limit) {
  if (start.kind === LOOKUP_TYPES.length) return { records: [], next: null, available: true };
  if (typeof eeaf.ids !== 'function') return { records: [], next: null, available: false };
  const records = [];
  let { kind, before } = start;
  while (kind < LOOKUP_TYPES.length && records.length < limit) {
    const room = limit - records.length;
    const ids = eeaf.ids(LOOKUP_TYPES[kind], { ...(before !== null ? { before } : {}), limit: room + 1 });
    records.push(...ids.slice(0, room).map(id => ({ id })));
    if (ids.length > room) return { records, next: { kind, before: ids[room - 1] }, available: true };
    kind += 1;
    before = null;
  }
  return { records, next: kind < LOOKUP_TYPES.length ? { kind, before } : null, available: true };
}

/** Provider ids can collide across accounts. Read indexed candidates, then match exact identity; expose ambiguity. */
export function findExecutionRecords(eeaf, { item, provider, account, object_id, limit = EXECUTION_LIMITS.page, cursor = null } = {}, { references = null } = {}) {
  const query = { item, provider, account, object_id, limit, cursor }, lookup = executionLookup(query);
  const { needle, target } = lookup;
  if (!needle) return { records: [], ambiguous: false, coverage: { limit, complete: true } };
  const size = Math.max(1, Math.min(EXECUTION_LIMITS.page, Number(limit) || EXECUTION_LIMITS.page));
  const fields = [['call_id'], ...LINK_FIELDS.map(field => ['links', field]), ['links', 'record_refs'],
    ...SOURCE_FIELDS.map(field => ['claimed', field]), ['claimed', 'tool_call_id'], ['actor', 'conversation_id'], ['parent_call_id'], ['source_ref'],
    ['observation', 'object_id'], ['observation', 'response_ref'], ['provider_id'], ['execution_ref']];
  // The shared relation owner indexes array-valued target links in the same transaction as their receipt.
  // The record store's text search reads string fields only; it cannot discover a target in record_refs.
  const indexed = executionReferencePage(query, references, LOOKUP_TYPES);
  // Any confirmed stored kind has an exact address. Restricting this to a couple of prefixes made a sparse
  // lookup for another kind walk the entire execution text history. Explicit provider binding stays separate.
  const namespaceTarget = CONTENT_IDENTITY.test(needle.replace(/^file:/, ''));
  const canonicalTarget = indexed && !provider && !account && !object_id
    && (/^(?:list:|record:)/.test(needle) || namespaceTarget || lookup.native || Boolean(eeaf.typeOf(needle)));
  const indexedIds = [...new Set((indexed?.records ?? []).map(row => row.id))].slice(0, size);
  const searched = canonicalTarget ? { records: [], next: null, available: true }
    : executionCandidatePage(eeaf, lookup.search, Math.max(0, size - indexedIds.length));
  const candidates = [...new Set([...indexedIds, ...searched.records.map(row => row.id)])];
  const exact = [...new Set([needle, target, executionRef(needle), `record:sent:${needle}`, ...candidates])]
    .filter(id => [EXECUTION_TYPE, 'record:sent'].includes(eeaf.typeOf(id)))
    .map(id => ({ id, value: eeaf.read(id) })).filter(({ value }) => object(value));
  const at = (value, path) => path.reduce((current, key) => current?.[key], value);
  const matches = exact.filter(({ id, value }) => {
    const identity = value.observation ?? { provider: value.provider, account: value.provider_account, object_id: value.provider_id };
    if (provider && identity.provider !== provider || account && identity.account !== account || object_id && identity.object_id !== object_id) return false;
    return id === needle || id === target || (value.references ?? []).some(reference => reference.ref === needle || reference.ref === target)
      || fields.some(path => { const found = at(value, path); return Array.isArray(found) ? found.includes(needle) || found.includes(target) : found === needle || found === target; });
  });
  const relationNext = indexed?.coverage.next_cursor ?? null;
  const more = Boolean(relationNext || searched.next);
  let nextCursor = null;
  if (more) {
    let relation = null;
    try { relation = relationNext === null ? null : JSON.parse(relationNext); } catch { throw cursorError(); }
    nextCursor = LOOKUP_CURSOR + JSON.stringify({ query: lookup.binding, relation, relation_done: !relationNext,
      search: searched.next ?? { kind: LOOKUP_TYPES.length, before: null } });
    if (nextCursor.length > 32768) throw cursorError();
  }
  return { records: matches, ambiguous: matches.filter(row => (row.value.observation?.object_id ?? row.value.provider_id) === needle).length > 1,
    coverage: { limit: size, complete: !lookup.continued && (indexed?.coverage.complete ?? true) && searched.available && !more,
      lookup: canonicalTarget ? 'indexed_exact_match' : indexed ? 'field_and_record_candidates_exact_match' : 'field_candidates_exact_match',
      candidate_work_bounded: true, candidate_records_examined: searched.records.length,
      ...(!canonicalTarget ? { candidate_order: 'type_then_id_desc', candidate_reader: searched.available ? 'bounded_type_ids' : 'unavailable' } : {}),
      ...(namespaceTarget ? { reference_aliases: 'exact_index_key_only', historical_aliases: 'not_backfilled' } : {}),
      ...(lookup.native ? { reference_aliases: 'declared_native_owner', lookup_target: target, requested_id: needle } : {}),
      ...(indexed ? { index_complete: indexed.coverage.index_complete, relation_candidates_examined: indexed.coverage.examined,
        model_index_complete: indexed.coverage.model_index_complete } : {}),
      more, next_cursor: nextCursor, pagination: 'live_index', consistent_snapshot: false, history: 'existing_record_retention' } };
}

/** The bounded receipt graph around one exact lookup: linked receipts and sent records held in the same store, plus
 *  task and effect metadata only from a caller that holds that task owner. A store without one says so in coverage;
 *  an absent relation is never presented as no relation. */
export function executionRecordGraph(eeaf, query, found, { task = null, effect = null } = {}) {
  const records = new Map(found.records.map(record => [record.id, record]));
  const pending = [...found.records];
  const add = (id, value) => { if (value && !records.has(id) && records.size < 100) { const row = { id, value }; records.set(id, row); pending.push(row); } };
  const addTask = id => {
    if (!task || typeof id !== 'string' || !id.startsWith('task_')) return;
    add(`task:${id}`, task(id));
  };
  const raw = typeof query.item === 'string' ? query.item : '';
  // A report's canonical row is itself a source owner. Keep only its diagnostic references and labels here;
  // opening its existing list still owns the full content, editing and access checks. A generic row can never
  // supply a task's independent readback or make an unrecorded historical relationship appear proven.
  if (raw.startsWith('record:') && !raw.startsWith('record:sent:')) {
    const row = eeaf.read(raw);
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const fields = ['title', 'label', 'source_ref', 'work_ref', 'proof_ref', 'execution_ref', 'intake_state', 'origin', 'created_at', 'sent_at'];
      add(raw, Object.fromEntries(fields.filter(field => typeof row[field] === 'string').map(field => [field, row[field]])));
    }
  }
  addTask(raw.startsWith('task:') ? raw.slice(5) : raw);
  if (raw.startsWith('effect:') && effect) add(raw, effect(raw));
  let followed = 0;
  for (; pending.length && followed < 100; followed += 1) {
    const { value } = pending.shift();
    addTask(value.links?.task_id ?? value.by?.task_id);
    const source = value.execution_ref;
    for (const linked of [value.corrects, value.claimed?.source_ref]) if (typeof linked === 'string' && linked.startsWith('execution:')) add(linked, readExecution(eeaf, linked));
    if (source) add(source, readExecution(eeaf, source));
    if (value.parent_call_id) { const parent = readExecution(eeaf, value.parent_call_id); if (parent) add(parent.execution_ref, parent); }
    const effectRef = value.links?.effect_ref ?? value.effect_ref;
    if (effectRef && effect) add(`effect:${effectRef}`, effect(`effect:${effectRef}`));
    const sentRef = value.links?.sent_ref;
    if (sentRef) add(sentRef, eeaf.read(sentRef));
    for (const ref of value.links?.record_refs ?? []) {
      if (ref.startsWith('execution:')) add(ref, readExecution(eeaf, ref));
      if (ref.startsWith('record:sent:')) add(ref, eeaf.read(ref));
    }
  }
  return { ...found, records: [...records.values()], coverage: { ...found.coverage, relation_limit: 100,
    complete: found.coverage.complete && !pending.length && records.size < 100,
    ...(task ? {} : { task_relations: 'held_by_their_task_owner' }) } };
}

/** The identity an independent observer must bind to. Unknown components remain absent. */
export function taskEffectBinding(task) {
  const effect = task?.effect;
  if (!effect?.effect_ref) return null;
  const observed = effect.observation ?? {};
  return { task_id: task.task_id, effect_ref: effect.effect_ref, attempt_count: effect.attempt_count,
    ...fieldsOf(observed, ['provider', 'account', 'connection_id', 'provider_origin', 'dispatch_route', 'object_id', 'route']),
    ...(task.execution_ref ? { execution_ref: task.execution_ref } : {}) };
}

// Small JSON mutation replies expose only references, never their whole payload. This projection is shared by
// direct HTTP and MCP capture; arbitrary record fields cannot become provenance simply by appearing in a reply.
export function executionResultLinks(result) {
  if (!object(result)) return {};
  const links = executionLinks({ task_id: result.task_id, effect_ref: result.effect?.effect_ref,
    sent_ref: result.kept_in_sent ? `record:sent:${result.kept_in_sent}` : undefined });
  const refs = ['id', 'record_id', 'identity', 'invite_id', 'execution_ref', 'source_ref'].flatMap(field => {
    const ref = ['string', 'number'].includes(typeof result[field]) ? executionText(result[field], field) : null;
    return ref ? [ref] : [];
  });
  if (result.handoff?.handoff_id) refs.push(executionText(result.handoff.handoff_id, 'handoff_id'));
  if (result.file?.identity) refs.push(executionText(result.file.identity, 'file identity'));
  return { ...links, ...(refs.length ? { record_refs: [...new Set(refs)] } : {}) };
}
