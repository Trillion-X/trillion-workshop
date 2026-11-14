import {
  readTrustedRuntimePartition,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';
import {
  LOCAL_DESKTOP_ACTOR,
  localActorAdmittedWrapper,
  type AdmissionRecipe,
} from './local-actor-admission';

type JsonRecord = Record<string, unknown>;
type Dispatch = (request: { target: string; payload: unknown }) => Promise<unknown>;
type TargetContext = BitfieldRuntimeContext & {
  runtime?: BitfieldRuntimeContext['runtime'] & {
    caller?: { local_command_list_admitted?: unknown };
  };
};

type MediaRoute = {
  adapter: string;
  target: string;
  descriptor: string;
  subjectField: 'idempotency_ref' | 'relation_ref';
  authorityOperation?: string;
};
const MATERIALIZER: MediaRoute = {
  adapter: 'ui.invoke-local-content-media-materializer',
  target: 'content-media-evidence.materialize-artifact',
  descriptor: 'package::content-media-evidence::target::materialize-artifact',
  subjectField: 'idempotency_ref',
};
const READER: MediaRoute = {
  adapter: 'ui.invoke-local-guarded-media-reader',
  target: 'content-media-evidence.read-guarded-artifact',
  descriptor: 'package::content-media-evidence::target::read-guarded-artifact',
  subjectField: 'relation_ref',
  // Read the value in the same independently verified resource authority
  // under which it was saved. The decision still authorizes the read action.
  authorityOperation: MATERIALIZER.target,
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function replyBytes(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) {
    return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  }
  const payload = record(reply)?.payload;
  if (payload !== undefined) return replyBytes(payload);
  throw new Error('The media access owner returned no readable answer.');
}

function decodedReply(value: unknown): unknown {
  const direct = record(value);
  if (direct && !('payload' in direct)) return direct;
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(replyBytes(value)));
}

function exactRecipe(value: unknown, route: MediaRoute): AdmissionRecipe {
  const recipe = record(value);
  const authorized = recipe?.authorized_action_refs;
  const constraints = record(recipe?.constraints);
  if (!recipe
    || recipe.target !== 'access-rule.evaluate'
    || recipe.action_ref !== route.target
    || !Array.isArray(authorized)
    || authorized.length !== 1
    || authorized[0] !== route.target
    || !constraints
    || Object.keys(constraints).length !== 0
    || typeof recipe.predicate_ref !== 'string'
    || !recipe.predicate_ref.trim()
    || !record(recipe.predicate_binding)
    || !record(recipe.subject_binding)
    || !record(recipe.resource_revision_binding)) {
    throw new Error('The installed media permission rule is missing or invalid.');
  }
  return recipe as unknown as AdmissionRecipe;
}

async function installedMaterializerRecipe(
  context: BitfieldRuntimeContext | undefined,
  dispatch: Dispatch,
  route: MediaRoute,
): Promise<AdmissionRecipe> {
  const partition = readTrustedRuntimePartition(context);
  const current = decodeEngineReadCurrentReply(replyBytes(await dispatch(
    buildEngineReadCurrentRequestFromLabels(partition, route.descriptor) as {
      target: string;
      payload: unknown;
    },
  )));
  if (!current.found || !current.payload) {
    throw new Error('The current media permission rule is unavailable.');
  }
  const descriptor = record(JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(current.payload),
  ));
  if (!descriptor
    || descriptor.kind !== 'package-target-descriptor'
    || descriptor.target !== route.target
    || descriptor.exposure !== 'hosted-session-admitted') {
    throw new Error('The current media permission rule does not match the media owner.');
  }
  return exactRecipe(descriptor.admission, route);
}

function revisions(value: unknown): JsonRecord | null {
  const result = record(value);
  if (!result) return null;
  for (const key of ['session_revision', 'policy_revision', 'membership_revision', 'resource_revision']) {
    if (typeof result[key] !== 'string' || !String(result[key]).trim()) return null;
  }
  return result;
}

async function verifyLocalCarrier(value: JsonRecord, dispatch: Dispatch, route: MediaRoute): Promise<JsonRecord> {
  const payload = record(value.payload);
  const actor = record(value.ambient_actor);
  const decision = record(value.access_decision);
  const decisionRevisions = revisions(decision?.revisions);
  if (!payload || !actor || !decision || !decisionRevisions
    || actor.actor_ref !== LOCAL_DESKTOP_ACTOR.actor_ref
    || actor.session_ref !== LOCAL_DESKTOP_ACTOR.session_ref
    || actor.session_revision !== LOCAL_DESKTOP_ACTOR.session_revision
    || decision.decision !== 'allow'
    || decision.actor_ref !== actor.actor_ref
    || decision.session_ref !== actor.session_ref
    || decision.subject_ref !== payload[route.subjectField]
    || !Array.isArray(decision.authorized_action_refs)
    || !decision.authorized_action_refs.includes(route.adapter)
    || typeof decision.decision_proof !== 'string'
    || !decision.decision_proof.trim()) {
    throw new Error('This media handoff is not from the current local session.');
  }
  const verification = record(decodedReply(await dispatch({
    target: 'access-rule.verify-decision',
    payload: {
      decision_proof: decision.decision_proof,
      actor_ref: actor.actor_ref,
      session_ref: actor.session_ref,
      subject_ref: decision.subject_ref,
      action_ref: route.adapter,
      revisions: decisionRevisions,
    },
  })));
  const durable = record(verification?.decision);
  if (verification?.verified !== true
    || !durable
    || durable.actor_ref !== actor.actor_ref
    || durable.session_ref !== actor.session_ref
    || durable.subject_ref !== decision.subject_ref
    || !Array.isArray(durable.authorized_action_refs)
    || !durable.authorized_action_refs.includes(route.adapter)) {
    throw new Error('This media handoff is not from the current local session.');
  }
  return payload;
}

function trustedLocalWorkflowPayload(
  value: JsonRecord,
  context: TargetContext | undefined,
): JsonRecord | null {
  if (context?.runtime?.caller?.local_command_list_admitted !== true) return null;
  readTrustedRuntimePartition(context);
  return value;
}

/**
 * Current local-owner carrier for staged media. Public target calls first pass
 * through the shell's hosted-session carrier and are accepted only when that
 * durable actor is the local desktop operator. Bare internal calls are refused:
 * where this code happens to run cannot prove who invoked it. The materializer
 * rule is always read from its exact current descriptor; callers cannot send or
 * alter it, and constraints this adapter cannot preserve are refused.
 */
export async function invokeLocalContentMediaMaterializerTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  dispatch: Dispatch = sendRequestToBitfieldTarget as Dispatch,
): Promise<unknown> {
  return invokeLocalMediaOwner(input, context, dispatch, MATERIALIZER);
}

export async function invokeLocalGuardedMediaReaderTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  dispatch: Dispatch = sendRequestToBitfieldTarget as Dispatch,
): Promise<unknown> {
  return invokeLocalMediaOwner(input, context, dispatch, READER);
}

async function invokeLocalMediaOwner(
  input: unknown,
  context: BitfieldRuntimeContext | undefined,
  dispatch: Dispatch,
  route: MediaRoute,
): Promise<unknown> {
  const request = record(input);
  if (!request) throw new Error('The saved media details are missing.');
  if ('admission_recipe' in request) {
    throw new Error('The media permission rule must come from the current media owner.');
  }
  const hasCompleteCarrier = ['payload', 'ambient_actor', 'access_decision'].every(
    (key) => Object.prototype.hasOwnProperty.call(request, key),
  );
  const payload = hasCompleteCarrier
    ? await verifyLocalCarrier(request, dispatch, route)
    : trustedLocalWorkflowPayload(request, context as TargetContext | undefined);
  if (!payload) {
    throw new Error('This media handoff is not from the current local session.');
  }
  if ('admission_recipe' in payload || 'ambient_actor' in payload || 'access_decision' in payload) {
    throw new Error('The saved media details include caller-owned permission fields.');
  }
  const admitted = await localActorAdmittedWrapper({
    target: route.target,
    authorityOperation: route.authorityOperation,
    payload,
    recipe: await installedMaterializerRecipe(context, dispatch, route),
    dispatch: dispatch as Parameters<typeof localActorAdmittedWrapper>[0]['dispatch'],
  });
  return decodedReply(await dispatch({ target: route.target, payload: admitted }));
}
