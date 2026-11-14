import { blake3 } from '@noble/hashes/blake3.js';
import { readTrustedRuntimeClockMs, sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { BitfieldRuntimeContext } from '@bitfield/runtime-kit';

/*
 * Actuation gateway (P-A) over ai-action-guard. The only door an effect reaches a
 * computer through, doing three jobs IN ORDER:
 *   1. resolve: turn the caller's OPAQUE ref into the target THIS SERVER holds in
 *      its authoritative snapshot; the caller's own label is ignored (the
 *      relabel-attack defense).
 *   2. decide: fail-closed attribute policy. Deny beats allow, absent denies, a
 *      broken deny still denies, a broken allow does not permit.
 *   3. record: write the audit row to the audit owner and read it back BEFORE any
 *      forward token exists; an action that was not recorded did not happen.
 *
 * The pure core (governComputerActionWithDeps) injects every side effect
 * (readSnapshot, readRule, writeAuditRow, readAuditRow), mirroring
 * evaluate-guard-policy.ts's evaluateGuardPolicyWithReader, so the door unit-tests
 * with no engine, no browser, no store. The resource domain (browser, file, MCP,
 * anything later) is a DATA descriptor, never a code branch: the same core
 * governs every domain (see govern-computer-action.test.ts deletion tests).
 */

export const GOVERN_REQUEST_SCHEMA = 'ai-action-guard-govern-computer-action-request/v1';
export const GOVERN_RECEIPT_SCHEMA = 'ai-action-guard-govern-computer-action-receipt/v1';

const ENGINE_OPERATION_TARGET = 'engine.operation.label-addressed';
const ENGINE_READ_CURRENT = 'engine.operation.read-current';
const AUDIT_APPEND_TARGET = 'ai-execution-history.append-execution-step';
const SNAPSHOT_ADDRESS_PREFIX = 'package::ai-action-guard::snapshot::';
// The generic engine query the gateway uses to read permission-lease's live
// control-note DATA (who is currently in control of one computer). It is an
// EXISTING routed op (the same op permission-lease's own workflows dispatch), so
// the gate needs no new target and no reboot, and it never imports permission-lease.
// The records are self-describing DATA (kind/lease_class/scope_ref/holder/revoked/
// expires_at), so a generic reader evaluates them (L090); permission-lease owns
// the schema. Field names (lease_class, lease_ref) stay as the wire spelling
// permission-lease's own records use today, a coordinated cross-package rename
// tracked in the plan rename-the-lease-jargon-to-plain-words.
const FIND_CURRENT_ITEMS_TARGET = 'slot::find-current-items';
const CONTROL_NOTE_KIND = 'permission_lease';
const CONTROL_HANDBACK_KIND = 'permission_lease_revocation';
const ONLY_ONE_CONTROLS_RULE = 'exclusive-control';
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

export type SnapshotElement = { ref: string; role: string; name: string; type?: string };

export type ResolvedElement = { ref: string; role: string; name: string; type?: string };

export type PolicyDecision = {
  allowed: boolean;
  mode: 'enforce' | 'dry-run';
  source: 'deny' | 'allow' | 'default' | 'exclusive-control';
  matched_rule_id: string | null;
  forward: boolean;
  reason: string;
};

/*
 * The one-driver takeover result the gateway reads from permission-lease's live
 * exclusive-control lease DATA (a blind log read, never a permission-lease import).
 * `held` is true iff a party OTHER than the actuator holds a live exclusive-control
 * lease on the action's computer scope; `holder` is that party's self-describing
 * DATA value (bot | human | any future party). The blocked reason is DERIVED from
 * `holder`, never a hardcoded 'human' literal (L090). The check is an injected
 * dependency, the exact style of readSnapshot/readRule: a pure-core caller that
 * does not wire an exclusive-control relationship simply observes no hold and the
 * attribute policy is the sole decider.
 */
export type ExclusiveControlHold = { held: boolean; holder?: string; lease_ref?: string };

export type GuardDomainDescriptor = {
  kind?: string;
  id?: string;
  resolves_ref?: boolean;
  intent_map?: Record<string, string>;
  context_fields?: string[];
  snapshot_owner_address_template?: string;
};

export type GovernComputerActionRequest = {
  schema?: string;
  request_ref: string;
  scope_ref: string;
  domain?: GuardDomainDescriptor;
  domain_ref?: string;
  rule_ref: string;
  run_ref: string;
  subject_ref: string;
  tool: string;
  /**
   * The actuator's own party for the one-driver takeover gate (self-describing
   * DATA: 'bot' by default). An exclusive-control lease held by a party equal to
   * this actuator does not block the actuator; a lease held by ANY other party
   * (a human that took the wheel) does. Never a code branch: the party is DATA.
   */
  actuator_holder?: string;
  element_ref?: string;
  expected_snapshot_id?: number;
  key?: string;
  file_path?: string;
  target_url?: string;
  mcp?: { server?: string; tool?: string; effect?: string };
};

export type AuditWriteResult = { payload_hash_code_hex: string; step_ref?: string };
export type AuditReadResult = { found: boolean; payload_hash_code_hex?: string };

export type GovernComputerActionDeps = {
  readSnapshot: (scopeRef: string) => Promise<unknown>;
  readRule: (ruleRef: string) => Promise<unknown>;
  /**
   * Ask permission-lease's live exclusive-control lease DATA whether the scope is
   * held by a party other than the actuator. Injected exactly like the other side
   * effects, so the door still unit-tests with no engine. When present, this gate
   * runs BEFORE the attribute policy (a human at the wheel overrides policy).
   */
  checkExclusiveControl?: (scopeRef: string, actuatorHolder: string) => Promise<ExclusiveControlHold>;
  writeAuditRow: (row: Record<string, unknown>) => Promise<AuditWriteResult>;
  readAuditRow: (rowId: string) => Promise<AuditReadResult>;
  /**
   * The instant the runtime received this request, in milliseconds since the epoch.
   * Required, and a plain number rather than a thunk: the same value stamps the audit
   * row and bounds the exclusive-control lease check, so the two cannot disagree, and
   * the same log replays to the same row. The door never reads a clock of its own.
   */
  nowUnixMs: number;
};

/** The actuator's default party. The bot drives unless a human takes the wheel. DATA, overridable per request. */
export const DEFAULT_ACTUATOR_HOLDER = 'bot';

export type GovernComputerActionReceipt = {
  schema: typeof GOVERN_RECEIPT_SCHEMA;
  kind: 'ai-action-guard-govern-receipt';
  request_ref: string;
  scope_ref: string;
  tool: string;
  resolved_element: ResolvedElement | null;
  stale_ref: boolean;
  decision: PolicyDecision;
  action_record_ref: string;
  recorded_at: string;
  forward_token: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

/* =============================================================================
 * PURE CORE 1: resolveSnapshotTarget
 * Resolve the caller's OPAQUE ref against the snapshot THIS SERVER holds. The
 * caller-supplied name/role are never read. Returns undefined for an unknown ref
 * (the policy still runs). A ref carried against a snapshot the server has since
 * replaced (expected_snapshot_id mismatch) must not resolve.
 * ========================================================================== */
export function resolveSnapshotTarget(
  snapshot: unknown,
  ref: string | undefined,
  expectedSnapshotId?: number,
): { element: ResolvedElement | undefined; stale: boolean } {
  if (!isRecord(snapshot) || snapshot.kind !== 'ai-guard-authoritative-snapshot') {
    return { element: undefined, stale: false };
  }
  const snapshotId = snapshot.snapshot_id;
  const stale = typeof expectedSnapshotId === 'number' && expectedSnapshotId !== snapshotId;
  if (stale || !ref) return { element: undefined, stale };
  const elements = Array.isArray(snapshot.elements) ? (snapshot.elements as SnapshotElement[]) : [];
  const found = elements.find(element => isRecord(element) && element.ref === ref);
  if (!found) return { element: undefined, stale: false };
  return {
    element: {
      ref: found.ref,
      role: found.role,
      name: found.name,
      ...(found.type ? { type: found.type } : {}),
    },
    stale: false,
  };
}

/* =============================================================================
 * PURE CORE 2: evaluateAttributePolicy
 * deny[] first, then allow[]. Deny beats allow. Absent rule denies. A broken
 * predicate in deny still denies; a broken predicate in allow does not permit.
 * Predicates are STRUCTURED self-describing DATA: a dumb walker evaluates them,
 * no CEL parser. The ops are a bounded set of comparison primitives; adding a
 * domain field is DATA, never a new op (enum-dissolution safe).
 * ========================================================================== */
const OPS: Record<string, (a: unknown, b: unknown) => boolean> = {
  equals: (a, b) => a === b,
  not_equals: (a, b) => a !== b,
  contains_ci: (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase()),
  matches_ci: (a, b) => new RegExp(String(b), 'i').test(String(a)),
  in: (a, b) => Array.isArray(b) && b.includes(a),
  exists: a => a !== undefined && a !== null,
};

function fieldValue(context: unknown, path: unknown): unknown {
  if (!Array.isArray(path)) throw new Error('predicate field must be an array path');
  let current: unknown = context;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key as string];
  }
  return current;
}

/** Evaluate one predicate tree. THROWS on a malformed predicate (unknown op, bad regex, bad shape). */
function evalPredicate(pred: unknown, context: unknown): boolean {
  if (!isRecord(pred)) throw new Error('malformed predicate');
  if (Array.isArray(pred.all)) return pred.all.every(child => evalPredicate(child, context));
  if (Array.isArray(pred.any)) return pred.any.some(child => evalPredicate(child, context));
  if (pred.not !== undefined) return !evalPredicate(pred.not, context);
  const op = OPS[pred.op as string];
  if (!op || !Array.isArray(pred.field)) throw new Error(`unknown or malformed op: ${String(pred.op)}`);
  return op(fieldValue(context, pred.field), pred.value) === true;
}

/** Never throws. onError decides what a broken predicate means for its list. */
function predicateMatches(pred: unknown, context: unknown, onError: boolean): boolean {
  try {
    return evalPredicate(pred, context) === true;
  } catch {
    return onError;
  }
}

export function evaluateAttributePolicy(rule: unknown, context: unknown): PolicyDecision {
  if (!isRecord(rule) || rule.kind !== 'ai-guard-rule') {
    return { allowed: false, mode: 'enforce', source: 'default', matched_rule_id: null, forward: false, reason: 'no policy present, refused' };
  }
  const mode: 'enforce' | 'dry-run' = rule.mode === 'dry-run' ? 'dry-run' : 'enforce';
  const deny = Array.isArray(rule.deny) ? rule.deny : [];
  const allow = Array.isArray(rule.allow) ? rule.allow : [];
  for (const entry of deny) {
    if (isRecord(entry) && predicateMatches(entry.predicate, context, true)) {
      return { allowed: false, mode, source: 'deny', matched_rule_id: (entry.id as string) ?? null, forward: mode === 'dry-run', reason: 'refused by a deny rule' };
    }
  }
  for (const entry of allow) {
    if (isRecord(entry) && predicateMatches(entry.predicate, context, false)) {
      return { allowed: true, mode, source: 'allow', matched_rule_id: (entry.id as string) ?? null, forward: true, reason: 'permitted by policy' };
    }
  }
  return { allowed: false, mode, source: 'default', matched_rule_id: null, forward: mode === 'dry-run', reason: 'no rule permits this action, refused' };
}

/* =============================================================================
 * Server-side context derivation. Every attribute the policy sees comes from the
 * server (the resolved snapshot element, the server-derived file/host), never
 * from the caller's request body.
 * ========================================================================== */
const ACTIVATING_KEYS = new Set(['Enter', 'NumpadEnter', 'Space', ' ']);

function intentOf(tool: string, key: string | undefined, domain: GuardDomainDescriptor | undefined): string | undefined {
  const map = domain?.intent_map;
  if (tool === 'computer_key') return key && ACTIVATING_KEYS.has(key) ? 'activate' : 'type';
  if (map && map[tool]) return map[tool];
  switch (tool) {
    case 'computer_click': return 'activate';
    case 'computer_type': return 'type';
    case 'computer_navigate': return 'navigate';
    case 'computer_read':
    case 'computer_snapshot':
    case 'computer_scroll': return 'read';
    case 'computer_read_file': return 'read_file';
    case 'computer_write_file': return 'write_file';
    case 'computer_list_files': return 'list_files';
    default: return undefined;
  }
}

function describeFile(path: string): { path: string; name: string; extension: string } {
  const name = String(path).split(/[\\/]/).pop() ?? String(path);
  const dot = name.lastIndexOf('.');
  return { path, name, extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/* =============================================================================
 * PURE CORE 3: governComputerActionWithDeps (the door)
 * resolve -> build resolved context (NEVER caller attributes) -> decide ->
 * RECORD THE ROW (writeAuditRow), READ IT BACK, then issue the forwarding
 * receipt. If the row write or readback fails, THROW: no receipt, so no actuator
 * can act. Mirrors access-rule evaluateAccessDecisionTarget (write durably, read
 * back, only then return).
 * ========================================================================== */
export async function governComputerActionWithDeps(
  req: GovernComputerActionRequest,
  deps: GovernComputerActionDeps,
): Promise<GovernComputerActionReceipt> {
  const snapshot = await deps.readSnapshot(req.scope_ref);
  const { element, stale } = resolveSnapshotTarget(snapshot, req.element_ref, req.expected_snapshot_id);

  const domain = req.domain;
  const intent = intentOf(req.tool, req.key, domain);
  const snapshotUrl = isRecord(snapshot) && isRecord(snapshot.context_ref) && typeof snapshot.context_ref.url === 'string'
    ? snapshot.context_ref.url
    : '';
  const snapshotId = isRecord(snapshot) && typeof snapshot.snapshot_id === 'number' ? snapshot.snapshot_id : null;
  const context: Record<string, unknown> = {
    tool: { name: req.tool },
    subject: { id: req.subject_ref },
    scope: { ref: req.scope_ref },
    intent,
    context: { host: hostOf(req.target_url ?? snapshotUrl) },
    ...(req.key ? { key: req.key } : {}),
    ...(element ? { element } : {}),
    ...(req.file_path ? { file: describeFile(req.file_path) } : {}),
    ...(req.mcp ? { mcp: req.mcp } : {}),
  };

  // ONE-DRIVER TAKEOVER GATE (before policy). A human that took the wheel holds a
  // live exclusive-control lease on this scope; while any party OTHER than the
  // actuator holds it, this actuate is REFUSED and the attribute policy is never
  // consulted, so takeover overrides policy. The blocked reason is DERIVED from the
  // holder DATA value, never a hardcoded 'human' branch; forward is always false
  // (a human is driving, so the bot must not act, in enforce OR dry-run). Recorded
  // before any effect exactly like a policy decision.
  const actuatorHolder = req.actuator_holder ?? DEFAULT_ACTUATOR_HOLDER;
  const control = deps.checkExclusiveControl
    ? await deps.checkExclusiveControl(req.scope_ref, actuatorHolder)
    : { held: false };

  let decision: PolicyDecision;
  if (control.held) {
    decision = {
      allowed: false,
      mode: 'enforce',
      source: 'exclusive-control',
      matched_rule_id: control.lease_ref ?? null,
      forward: false,
      reason: `blocked:${control.holder}-holds-control`,
    };
  } else {
    const rule = await deps.readRule(req.rule_ref);
    decision = evaluateAttributePolicy(rule, context);
  }

  const row: Record<string, unknown> = {
    kind: 'ai-execution-step',
    id: `ai-exec-step:${req.request_ref}`,
    run_ref: req.run_ref,
    step_kind: 'governed-computer-action',
    tool: req.tool,
    intent,
    scope_ref: req.scope_ref,
    resolved_element: element ?? null,
    context: context.context,
    ...(control.held ? { exclusive_control: { holder: control.holder ?? null, lease_ref: control.lease_ref ?? null } } : {}),
    decision,
    snapshot_id: snapshotId,
    recorded_at: new Date(deps.nowUnixMs).toISOString(),
  };
  const writeResult = await deps.writeAuditRow(row);
  const readback = await deps.readAuditRow(row.id as string);
  if (!readback || readback.found !== true || readback.payload_hash_code_hex !== writeResult.payload_hash_code_hex) {
    throw new Error('audit row readback failed: the effect must not proceed without a durable record');
  }

  return {
    schema: GOVERN_RECEIPT_SCHEMA,
    kind: 'ai-action-guard-govern-receipt',
    request_ref: req.request_ref,
    scope_ref: req.scope_ref,
    tool: req.tool,
    resolved_element: element ?? null,
    stale_ref: stale,
    decision,
    action_record_ref: `${row.id as string}#${writeResult.payload_hash_code_hex}`,
    recorded_at: row.recorded_at as string,
    forward_token: decision.forward ? `forward:${row.id as string}:${writeResult.payload_hash_code_hex}` : null,
  };
}

/* =============================================================================
 * Default Envelope wiring. Reads the server-held snapshot, rule, and domain by
 * owner address (the guard's own package::ai-action-guard::* namespace, plus the
 * caller-selected rule_ref); records the audit row through the audit OWNER
 * (ai-execution-history.append-execution-step) and re-verifies the exact address
 * that owner returns. The guard never stores an audit trail of its own and never
 * hardcodes the audit owner's address scheme: it learns step_ref from the append
 * receipt. Not unit-tested here (it needs a live engine); the pure core above
 * carries the behavior contract.
 * ========================================================================== */
function decodeReply(reply: unknown): Record<string, unknown> {
  if (reply instanceof Uint8Array) return JSON.parse(TEXT_DECODER.decode(reply)) as Record<string, unknown>;
  if (isRecord(reply) && reply.payload instanceof Uint8Array) {
    return JSON.parse(TEXT_DECODER.decode(reply.payload)) as Record<string, unknown>;
  }
  if (!isRecord(reply)) throw new Error('owner read returned no object');
  return reply;
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function hashCodeHexFromBytes(bytes: Uint8Array): string {
  return `1f:${[...blake3(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

function payloadBytes(result: Record<string, unknown>): Uint8Array | undefined {
  if (typeof result.payload_base64 === 'string' && result.payload_base64.length > 0) return decodeBase64(result.payload_base64);
  if (typeof result.value_json === 'string' && result.value_json.length > 0) return TEXT_ENCODER.encode(result.value_json);
  if (isRecord(result.payload)) return TEXT_ENCODER.encode(JSON.stringify(result.payload));
  return undefined;
}

async function readCurrentRecord(addressRef: string): Promise<{ payload: unknown; bytes: Uint8Array } | undefined> {
  // No partition. The engine answers from the partition the request arrived on, so
  // policy rules, snapshots and audit rows come from the app being governed. This
  // used to be a caller-chosen argument threaded through every dependency, which
  // meant a caller picked which store the POLICY RULE came from.
  //
  // Read every record (snapshot, rule, domain, and the returned audit step_ref)
  // by the canonical label address the platform's default write path produces
  // (makeFactAddressBytesFromLabel = 'label-hash'). ai-execution-history's
  // append-execution-step writes the step row via buildEngineWriteBatchRequestFromLabels,
  // which is exactly that address, and returns the step_ref label; reading it back
  // under any other mode (the old 'identity_text' assumed a different, non-matching
  // hash) resolves a different address, so the record-before-effect readback would
  // fail closed on every live dispatch even though the row was durably written.
  const result = decodeReply(await sendRequestToBitfieldTarget({
    target: ENGINE_OPERATION_TARGET,
    payload: {
      operation_label: ENGINE_READ_CURRENT,
      address_label: addressRef,
      address_mode: 'label-hash',
    },
  }));
  if (result.found !== true) return undefined;
  const bytes = payloadBytes(result);
  if (!bytes) return undefined;
  return { payload: JSON.parse(TEXT_DECODER.decode(bytes)), bytes };
}

function readGovernRequest(input: unknown): GovernComputerActionRequest {
  if (!isRecord(input)) throw new TypeError('govern computer action request must be an object');
  if (input.schema !== undefined && input.schema !== GOVERN_REQUEST_SCHEMA) {
    throw new TypeError(`schema must equal ${GOVERN_REQUEST_SCHEMA}`);
  }
  return {
    schema: GOVERN_REQUEST_SCHEMA,
    request_ref: requiredText(input.request_ref, 'request_ref'),
    scope_ref: requiredText(input.scope_ref, 'scope_ref'),
    rule_ref: requiredText(input.rule_ref, 'rule_ref'),
    run_ref: requiredText(input.run_ref, 'run_ref'),
    subject_ref: requiredText(input.subject_ref, 'subject_ref'),
    tool: requiredText(input.tool, 'tool'),
    ...(typeof input.actuator_holder === 'string' ? { actuator_holder: input.actuator_holder } : {}),
    ...(typeof input.domain_ref === 'string' ? { domain_ref: input.domain_ref } : {}),
    ...(typeof input.element_ref === 'string' ? { element_ref: input.element_ref } : {}),
    ...(typeof input.expected_snapshot_id === 'number' ? { expected_snapshot_id: input.expected_snapshot_id } : {}),
    ...(typeof input.key === 'string' ? { key: input.key } : {}),
    ...(typeof input.file_path === 'string' ? { file_path: input.file_path } : {}),
    ...(typeof input.target_url === 'string' ? { target_url: input.target_url } : {}),
    ...(isRecord(input.mcp) ? { mcp: input.mcp as GovernComputerActionRequest['mcp'] } : {}),
  };
}

/* =============================================================================
 * Default Envelope wiring for the ONE-DRIVER TAKEOVER GATE. Reads permission-lease's
 * live exclusive-control lease + revocation DATA for the scope through the generic
 * find-current-items op (no permission-lease import, no new target op, no reboot),
 * applies revocations and SP2 expiry, and reports whether a party OTHER than the
 * actuator holds a live hold. The holder is DATA read off the record; the blocked
 * reason is derived from it in the pure core, never a hardcoded literal.
 * ========================================================================== */
function extractRecordPayload(item: unknown): Record<string, unknown> | undefined {
  if (!isRecord(item)) return undefined;
  if (isRecord(item.payload)) return item.payload;
  if (typeof item.payload_base64 === 'string' && item.payload_base64.length > 0) {
    return JSON.parse(TEXT_DECODER.decode(decodeBase64(item.payload_base64))) as Record<string, unknown>;
  }
  if (typeof item.value_json === 'string' && item.value_json.length > 0) {
    return JSON.parse(item.value_json) as Record<string, unknown>;
  }
  return item;
}

async function findCurrentItems(where: Array<{ field: string; eq?: unknown; in?: unknown[] }>): Promise<Record<string, unknown>[]> {
  const clauses = where.map((clause) =>
    clause.in !== undefined ? { field: clause.field, in: clause.in } : { field: clause.field, eq: clause.eq });
  const reply = decodeReply(await sendRequestToBitfieldTarget({
    target: FIND_CURRENT_ITEMS_TARGET,
    payload: { operation: 'find-current-items', in: 'published-record', where: { all: clauses } },
  }));
  const raw = Array.isArray(reply.items) ? reply.items
    : Array.isArray(reply.results) ? reply.results
    : Array.isArray(reply.records) ? reply.records
    : [];
  return raw.map(extractRecordPayload).filter((value): value is Record<string, unknown> => isRecord(value));
}

function isLiveExclusiveControlHold(lease: Record<string, unknown>, scopeRef: string, revoked: Set<string>, nowMs: number): boolean {
  if (lease.kind !== CONTROL_NOTE_KIND || lease.lease_class !== ONLY_ONE_CONTROLS_RULE) return false;
  if (lease.scope_ref !== scopeRef) return false;
  if (lease.revoked === true) return false;
  const leaseRef = typeof lease.lease_ref === 'string' ? lease.lease_ref : undefined;
  if (leaseRef && revoked.has(leaseRef)) return false;
  const expiresAt = lease.expires_at;
  if (typeof expiresAt === 'string' && expiresAt.length > 0) {
    const time = Date.parse(expiresAt);
    if (Number.isFinite(time) && time <= nowMs) return false;
  }
  return true;
}

async function readExclusiveControlHold(scopeRef: string, actuatorHolder: string, nowMs: number): Promise<ExclusiveControlHold> {
  const [leases, revocations] = await Promise.all([
    findCurrentItems([
      { field: 'kind', eq: CONTROL_NOTE_KIND },
      { field: 'lease_class', eq: ONLY_ONE_CONTROLS_RULE },
      { field: 'scope_ref', eq: scopeRef },
    ]),
    findCurrentItems([{ field: 'kind', eq: CONTROL_HANDBACK_KIND }]),
  ]);
  const revoked = new Set<string>();
  for (const record of revocations) {
    if (typeof record.lease_ref === 'string') revoked.add(record.lease_ref);
  }
  const hold = leases.find((lease) =>
    isLiveExclusiveControlHold(lease, scopeRef, revoked, nowMs) && lease.holder !== actuatorHolder);
  if (!hold) return { held: false };
  return {
    held: true,
    ...(typeof hold.holder === 'string' ? { holder: hold.holder } : {}),
    ...(typeof hold.lease_ref === 'string' ? { lease_ref: hold.lease_ref } : {}),
  };
}

/**
 * The govern-computer-action target entry. Validates the request, resolves the
 * server-held snapshot / rule / domain owner records, and runs the pure core
 * with real Envelope side effects. The one door every governed computer action
 * passes through.
 */
export async function governComputerAction(
  input: unknown,
  context?: BitfieldRuntimeContext,
): Promise<GovernComputerActionReceipt> {
  const request = readGovernRequest(input);
  // Read ONCE. The lease check and the audit row's recorded_at share this instant, so a
  // lease that expires mid-request cannot be live for one and expired for the other.
  const nowUnixMs = readTrustedRuntimeClockMs(context);

  const domain = request.domain_ref
    ? ((await readCurrentRecord(request.domain_ref))?.payload as GuardDomainDescriptor | undefined)
    : request.domain;

  // The audit owner returns the durable step address; the guard reads back THAT
  // exact address, so it never hardcodes ai-execution-history's addressing.
  const stepAddresses = new Map<string, string>();

  const deps: GovernComputerActionDeps = {
    readSnapshot: async (scopeRef) =>
      (await readCurrentRecord(`${SNAPSHOT_ADDRESS_PREFIX}${scopeRef}`))?.payload,
    readRule: async (ruleRef) =>
      (await readCurrentRecord(ruleRef))?.payload,
    checkExclusiveControl: async (scopeRef, actuatorHolder) =>
      readExclusiveControlHold(scopeRef, actuatorHolder, nowUnixMs),
    writeAuditRow: async (row) => {
      const reply = decodeReply(await sendRequestToBitfieldTarget({
        target: AUDIT_APPEND_TARGET,
        payload: { step: row },
      }));
      const stepRef = requiredText(reply.step_ref, 'append-execution-step.step_ref');
      const payload_hash_code_hex = requiredText(reply.payload_hash_code_hex, 'append-execution-step.payload_hash_code_hex');
      stepAddresses.set(row.id as string, stepRef);
      return { payload_hash_code_hex, step_ref: stepRef };
    },
    readAuditRow: async (rowId) => {
      const stepRef = stepAddresses.get(rowId);
      if (!stepRef) return { found: false };
      const readback = await readCurrentRecord(stepRef);
      if (!readback) return { found: false };
      return { found: true, payload_hash_code_hex: hashCodeHexFromBytes(readback.bytes) };
    },
    nowUnixMs,
  };

  return governComputerActionWithDeps({ ...request, domain }, deps);
}
