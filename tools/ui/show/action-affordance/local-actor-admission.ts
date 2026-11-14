import { makeHashCodeHexFromBytes } from '#workspace-records';

/**
 * Desktop local-actor admission carrier.
 *
 * One dispatch grammar for admitted owner actions: the ambient carrier builds
 * the `{payload, ambient_actor, access_decision}` wrapper. Hosted public apps
 * use the server route carrier; a local desktop app registers THIS provider so
 * the browser seam can wrap dispatches to admitted owner targets the same way.
 * The wrapper is evidence, never authority: owners still verify every decision
 * durably through `access-rule.verify-decision`.
 */

type JsonRecord = Record<string, unknown>;
type Dispatch = (request: { target: string; payload: JsonRecord }) => Promise<unknown>;

/** The doorway admission recipe DATA (from the owner package-target
 * descriptor). Bindings resolve against `{payload, actor_ref, session_ref,
 * session_revision, target}` exactly like the hosted carrier's binding
 * context. */
export type AdmissionRecipe = {
  readonly target?: string;
  readonly action_ref: string;
  readonly authorized_action_refs?: readonly string[];
  readonly constraints?: JsonRecord;
  readonly predicate_ref: string;
  readonly predicate_binding: JsonRecord;
  readonly subject_binding: JsonRecord;
  readonly resource_revision_binding: JsonRecord;
};

export type AdmittedOwnerWrapper = {
  readonly payload: JsonRecord;
  readonly ambient_actor: { actor_ref: string; session_ref: string; session_revision: string };
  readonly access_decision: JsonRecord;
};

const PRODUCT_ACCESS_AUTHORITY_TARGET = 'tool:check-a-buyer-may-open';
const ACCESS_RULE_EVALUATE_TARGET = 'access-rule.evaluate';
const SCOPE_SCHEMA = 'addressed-expiring-value-scope/v1';
const UNGATED_MEMBERSHIP_REVISION = 'membership-revision:ungated';

/** First-class local desktop actor identity. Same ambient_actor schema the
 * hosted path uses; a single-user local app's operator is the authority. */
export const LOCAL_DESKTOP_ACTOR = {
  actor_ref: 'actor:local-operator',
  session_ref: 'account-session:local-operator',
  session_revision: 'local-operator:1',
} as const;

export class LocalAdmissionUnavailableError extends Error {
  constructor(reason: string) {
    super(`This app could not confirm permission to save right now. Wait a moment and try again. (${reason})`);
    this.name = 'LocalAdmissionUnavailableError';
  }
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

/** Runtime Kit target replies arrive as byte payloads (carrier frames); the
 * decision is JSON inside them. Mirrors the owner-side jsonReply decode. */
function replyBytes(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  const payload = record(reply)?.payload;
  if (payload !== undefined) return replyBytes(payload);
  throw new Error('the access owner reply had no readable payload');
}

function jsonReply(reply: unknown): JsonRecord {
  const direct = record(reply);
  if (direct && !('payload' in direct)) return direct;
  const payload = direct?.payload;
  if (payload instanceof Uint8Array
    || payload instanceof ArrayBuffer
    || ArrayBuffer.isView(payload)) {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(replyBytes(reply)));
    const value = record(parsed);
    if (!value) throw new Error('the access owner reply was not a decision');
    return value;
  }
  if (record(payload)) return record(payload)!;
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(replyBytes(reply)));
  const value = record(parsed);
  if (!value) throw new Error('the access owner reply was not a decision');
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

/** Resolves the doorway binding grammar: `{from: 'literal', value}` and
 * `{from: 'context', path: 'a.b'}`. The owner independently recomputes and
 * binds subject/resource identity, so a wrong resolution can only fail closed
 * at the owner, never forge one. */
export function resolveAdmissionBinding(binding: unknown, context: JsonRecord, label: string): unknown {
  const source = record(binding);
  if (!source || typeof source.$kind !== 'string') throw new Error(`${label} is not an admission binding`);
  const select = record(source.select);
  if (!select) throw new Error(`${label} is not an admission binding`);
  if (select.from === 'literal') return select.value;
  if (select.from === 'context') {
    const path = typeof select.path === 'string' ? select.path.split('.') : [];
    if (!path.length || path.some((segment) => !segment.trim())) throw new Error(`${label} has an invalid context path`);
    let current: unknown = context;
    for (const segment of path) {
      const next = record(current)?.[segment];
      if (next === undefined) throw new Error(`${label} context path is missing a segment`);
      current = next;
    }
    return current;
  }
  throw new Error(`${label} has an unsupported binding source`);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = record(value);
  if (!object) return value === undefined ? null : value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function authorizedActions(recipe: AdmissionRecipe): string[] {
  const actions = recipe.authorized_action_refs ?? [recipe.action_ref];
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 64
    || actions.some((value) => typeof value !== 'string' || !value.trim() || value !== value.trim())
    || new Set(actions).size !== actions.length
    || !actions.includes(recipe.action_ref)) {
    throw new LocalAdmissionUnavailableError('the permission rule names invalid actions');
  }
  return [...actions];
}

function admissionConstraints(recipe: AdmissionRecipe, guard: JsonRecord): JsonRecord {
  const supplied = recipe.constraints === undefined ? {} : record(recipe.constraints);
  if (!supplied) throw new LocalAdmissionUnavailableError('the permission rule has invalid limits');
  if (Object.prototype.hasOwnProperty.call(supplied, 'revision_guards')) {
    throw new LocalAdmissionUnavailableError('the permission rule cannot replace the local authority check');
  }
  // The recipe is immutable DATA and its identity is already included in the
  // policy revision. Preserve every bound exactly, then add the one guard only
  // this local carrier owns. JSON round-tripping prevents later caller mutation
  // from changing the decision request after its policy identity was derived.
  let preserved: JsonRecord;
  try {
    preserved = JSON.parse(JSON.stringify(supplied)) as JsonRecord;
  } catch {
    throw new LocalAdmissionUnavailableError('the permission rule has invalid limits');
  }
  if (!canonicalEqual(preserved, supplied)) {
    throw new LocalAdmissionUnavailableError('the permission rule has invalid limits');
  }
  return { ...preserved, revision_guards: [guard] };
}

function policyRevisionFor(recipe: AdmissionRecipe, authorityOperation?: string): string {
  const identity = JSON.stringify(canonical({
    kind: 'local-actor-admission.policy/v1',
    recipe,
    ...(authorityOperation === undefined ? {} : { authority_operation: authorityOperation }),
  }));
  return `policy:${makeHashCodeHexFromBytes(new TextEncoder().encode(identity))}`;
}

function correlationIdFor(input: {
  actor: typeof LOCAL_DESKTOP_ACTOR;
  target: string;
  actionRef: string;
  subjectRef: string;
  resourceRevision: string;
  policyRevision: string;
}): string {
  const identity = JSON.stringify(canonical({
    kind: 'local-actor-admission.request/v1',
    actor_ref: input.actor.actor_ref,
    session_ref: input.actor.session_ref,
    session_revision: input.actor.session_revision,
    target: input.target,
    action_ref: input.actionRef,
    subject_ref: input.subjectRef,
    resource_revision: input.resourceRevision,
    policy_revision: input.policyRevision,
  }));
  return `local-admission:${makeHashCodeHexFromBytes(new TextEncoder().encode(identity))}`;
}

/** The one revision guard this carrier adds: tool:check-a-buyer-may-open answers that the local operator may open
 * the local app's own (ungated) scope, and its `membership_revision` is the ungated one, so the admission fails
 * closed if the answer ever changes. The tool takes the buyer as `subject` and the scope as an object. */
function authorityGuard(actor: typeof LOCAL_DESKTOP_ACTOR): JsonRecord {
  const scope = {
    schema: SCOPE_SCHEMA,
    value_ref: 'access:local-app',
    instance_ref: 'local-operator',
    required_access_refs: [],
  };
  return {
    target: PRODUCT_ACCESS_AUTHORITY_TARGET,
    payload: { subject: actor.actor_ref, scope },
    expected_reply: { authorized: true, membership_revision: UNGATED_MEMBERSHIP_REVISION },
  };
}

function durableLocalDecision(value: unknown, expected: {
  actionRef: string;
  subjectRef: string;
  authorizedActionRefs: readonly string[];
  constraints: JsonRecord;
  actor: typeof LOCAL_DESKTOP_ACTOR;
  revisions: JsonRecord;
}): JsonRecord {
  const decision = record(value);
  if (
    !decision
    || decision.decision !== 'allow'
    || decision.action_ref !== expected.actionRef
    || decision.actor_ref !== expected.actor.actor_ref
    || decision.session_ref !== expected.actor.session_ref
    || decision.subject_ref !== expected.subjectRef
    || !canonicalEqual(decision.authorized_action_refs, expected.authorizedActionRefs)
    || !canonicalEqual(decision.constraints, expected.constraints)
    || typeof decision.decision_proof !== 'string'
    || !decision.decision_proof.trim()
  ) throw new LocalAdmissionUnavailableError('the access owner did not allow this action');
  const revisions = record(decision.revisions);
  if (!revisions || !canonicalEqual(revisions, expected.revisions)) {
    throw new LocalAdmissionUnavailableError('the access decision did not match this session');
  }
  return decision;
}

let registered = false;

/** Idempotent registration by the consuming desktop surface's admitted entry
 * bytes. Hosted publications never register: their server route carrier owns
 * admission, and unregistered seams keep today's raw dispatch grammar. */
export function registerLocalActorAdmission(): void {
  registered = true;
}

export function localActorAdmissionRegistered(): boolean {
  return registered;
}

/** For tests: reset module-level registration. */
export function __resetLocalActorAdmissionForTests(): void {
  registered = false;
}

/** Builds the admitted owner wrapper for one dispatch by evaluating the
 * doorway recipe through the durable access owner. Fail-closed with a
 * plain-language error when the decision cannot be computed. */
export async function localActorAdmittedWrapper(input: {
  readonly target: string;
  /** The saved value's authority may span several separately admitted actions.
   * It is part of the policy revision the decision is bound to; it does not
   * replace the decision's exact action, subject, or resource revision. */
  readonly authorityOperation?: string;
  readonly payload: JsonRecord;
  readonly recipe: AdmissionRecipe;
  readonly dispatch: Dispatch;
}): Promise<AdmittedOwnerWrapper> {
  const actor = LOCAL_DESKTOP_ACTOR;
  const bindingContext: JsonRecord = {
    payload: input.payload,
    actor_ref: actor.actor_ref,
    session_ref: actor.session_ref,
    session_revision: actor.session_revision,
    target: input.target,
  };
  const subjectRef = requiredText(
    resolveAdmissionBinding(input.recipe.subject_binding, bindingContext, 'admission subject binding'),
    'admission subject binding',
  );
  const resourceRevision = requiredText(
    String(resolveAdmissionBinding(input.recipe.resource_revision_binding, bindingContext, 'admission resource binding')),
    'admission resource binding',
  );
  const revisions: JsonRecord = {
    session_revision: actor.session_revision,
    policy_revision: policyRevisionFor(input.recipe, input.authorityOperation),
    membership_revision: UNGATED_MEMBERSHIP_REVISION,
    resource_revision: resourceRevision,
  };
  const authorizedActionRefs = authorizedActions(input.recipe);
  const constraints = admissionConstraints(input.recipe, authorityGuard(actor));
  const request: JsonRecord = {
    kind: 'access-decision-request/v1',
    correlation_id: correlationIdFor({
      actor,
      target: input.target,
      actionRef: input.recipe.action_ref,
      subjectRef,
      resourceRevision,
      policyRevision: String(revisions.policy_revision),
    }),
    subject_ref: subjectRef,
    action_ref: input.recipe.action_ref,
    authorized_action_refs: authorizedActionRefs,
    constraints,
    predicate_ref: input.recipe.predicate_ref,
    predicate_binding: input.recipe.predicate_binding,
    context: { ...bindingContext, subject_ref: subjectRef, resource_revision: resourceRevision },
    ambient_actor: { ...actor },
    revisions,
  };
  let reply: unknown;
  try {
    reply = await input.dispatch({ target: ACCESS_RULE_EVALUATE_TARGET, payload: request });
  } catch (error) {
    throw new LocalAdmissionUnavailableError(`the access owner is unreachable: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  let decision: JsonRecord;
  try {
    decision = jsonReply(reply);
  } catch (error) {
    throw new LocalAdmissionUnavailableError(`the access owner returned no decision: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  return {
    payload: input.payload,
    ambient_actor: { ...actor },
    access_decision: durableLocalDecision(decision, {
      actionRef: input.recipe.action_ref,
      subjectRef,
      authorizedActionRefs,
      constraints,
      actor,
      revisions,
    }),
  };
}
