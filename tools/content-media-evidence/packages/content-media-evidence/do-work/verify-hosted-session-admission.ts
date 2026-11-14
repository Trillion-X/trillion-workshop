import { makeHashCodeHexFromBytes } from '@bitfield/runtime-kit/protocol';

type JsonRecord = Record<string, unknown>;
export type OwnerSender = (request: unknown) => Promise<unknown>;

const record = (value: unknown): JsonRecord | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonRecord
  : null;

/** Runtime Kit target replies arrive as byte payloads (carrier frames); the
 * verification reply is JSON inside them. A byte-view payload decodes before
 * the verification reader sees it. */
function replyBytes(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  const payload = record(reply)?.payload;
  if (payload !== undefined) return replyBytes(payload);
  throw new Error('verification reply had no readable payload');
}

function jsonVerificationReply(reply: unknown): JsonRecord {
  const direct = record(reply);
  if (direct && !('payload' in direct)) return direct;
  const payload = direct?.payload;
  if (payload instanceof Uint8Array || payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) {
    return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(replyBytes(reply))))!;
  }
  if (record(payload)) return record(payload)!;
  return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(replyBytes(reply))))!;
}

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
};

const revisionVector = (value: unknown): JsonRecord => {
  const input = record(value);
  if (!input) throw new Error('access_decision.revisions is required');
  return Object.fromEntries([
    'membership_revision',
    'policy_revision',
    'resource_revision',
    'session_revision',
  ].map((key) => [key, text(input[key], `access_decision.revisions.${key}`)]));
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = record(value);
  if (!object) return value === undefined ? null : value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
}

function authorityScopeRef(decision: JsonRecord): string {
  const constraints = record(decision.constraints);
  const guards = constraints?.revision_guards;
  if (!Array.isArray(guards)) throw new Error('verified decision has no owner authority guard');
  // The durable authority guard is the product-access authorization request
  // the decision was bound to (hosted and local actors alike). Its full
  // request is the authority scope identity: a payload the guard target can
  // re-verify live, never a caller-decorated field name.
  const authorityGuards = guards.filter((value) => {
    const guard = record(value);
    const request = record(guard?.payload);
    const expected = record(guard?.expected_reply);
    return guard?.target === 'product-access.authorize-addressed-expiring-value-scope'
      && typeof request?.principal_ref === 'string'
      && request.principal_ref.trim().length > 0
      && request?.scope !== undefined
      && expected?.authorized === true;
  }).map((value) => record(value)!);
  if (authorityGuards.length !== 1) throw new Error('verified decision has an ambiguous owner authority guard');
  const request = record(authorityGuards[0].payload)!;
  const identity = canonical({
    kind: 'owner-authority-scope/v1',
    target: authorityGuards[0].target,
    request,
  });
  return `authority-scope:${makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(identity)))}`;
}

/**
 * Owner-side verification for every admitted content-media target. The
 * carrier's wrapper is evidence, never authority: this function asks the
 * durable access owner before any state or CAS operation.
 */
export async function verifyContentMediaOwnerAdmission(
  input: unknown,
  actionRef: string,
  sender: OwnerSender,
): Promise<{
  payload: JsonRecord;
  actorRef: string;
  subjectRef: string;
  resourceRevision: string;
  decisionRef: string;
  authorityScopeRef: string;
}> {
  const wrapper = record(input);
  const payload = record(wrapper?.payload);
  const actor = record(wrapper?.ambient_actor);
  const decision = record(wrapper?.access_decision);
  if (!payload || !actor || !decision || decision.decision !== 'allow') {
    throw new Error('server admission is required and must be current');
  }
  const actorRef = text(actor.actor_ref, 'ambient_actor.actor_ref');
  const sessionRef = text(actor.session_ref, 'ambient_actor.session_ref');
  const sessionRevision = text(actor.session_revision, 'ambient_actor.session_revision');
  const subjectRef = text(decision.subject_ref, 'access_decision.subject_ref');
  const decisionRef = text(decision.decision_proof, 'access_decision.decision_proof');
  const revisions = revisionVector(decision.revisions);
  if (
    text(decision.actor_ref, 'access_decision.actor_ref') !== actorRef
    || text(decision.session_ref, 'access_decision.session_ref') !== sessionRef
    || revisions.session_revision !== sessionRevision
  ) throw new Error('server admission is stale or invalid');
  // The presented `action_ref` is NOT compared here, deliberately. `action_ref` is provenance, the
  // action the request was made for, while `authorized_action_refs` is scope, and the authority
  // itself only ever asks about scope: `access-rule/do-work/decision-targets.ts:158` authorizes on
  // `authorized_action_refs.includes(actionRef)` and compares no `action_ref` at all, while
  // `access-rule/src/validate-records.ts:64` refuses to mint any decision whose grant list omits
  // its own `action_ref`. Comparing it here applied a rule strictly narrower than the authority's,
  // which made a multi-action grant impossible to present for any action but its first.
  // Nothing weaker replaces it: the caller-supplied grant list is deliberately still not read,
  // because it could only ever reject what the durable check below also rejects, while adding a
  // second unvalidated rule that can diverge from the authority's.

  const verification = jsonVerificationReply(await sender({
    target: 'access-rule.verify-decision',
    payload: {
      decision_proof: decisionRef,
      actor_ref: actorRef,
      session_ref: sessionRef,
      subject_ref: subjectRef,
      action_ref: actionRef,
      revisions,
    },
  }));
  const durable = record(verification?.decision);
  const durableRevisions = record(durable?.revisions);
  if (
    verification?.verified !== true
    || !durable
    || durable.decision !== 'allow'
    || text(durable.decision_proof, 'verified decision decision_proof') !== decisionRef
    || text(durable.actor_ref, 'verified decision actor_ref') !== actorRef
    || text(durable.session_ref, 'verified decision session_ref') !== sessionRef
    || text(durable.subject_ref, 'verified decision subject_ref') !== subjectRef
    // `durable.action_ref` is likewise NOT compared: same reason, and this was the comparison that
    // actually made a multi-action grant unusable, since it sits on the server-verified record and
    // would have thrown even after the presented one above stopped refusing. The two lines were
    // one defect wearing two faces, so they were deleted together. Scope is enforced on the next
    // two lines, against the durable record, which is exactly the authority's own rule.
    || !Array.isArray(durable.authorized_action_refs)
    || !durable.authorized_action_refs.includes(actionRef)
    || !durableRevisions
    || Object.entries(revisions).some(([key, value]) => durableRevisions[key] !== value)
  ) throw new Error('server admission is not durable or does not authorize this owner action');

  return {
    payload,
    actorRef,
    subjectRef,
    resourceRevision: text(revisions.resource_revision, 'access_decision.revisions.resource_revision'),
    decisionRef,
    authorityScopeRef: authorityScopeRef(durable),
  };
}
