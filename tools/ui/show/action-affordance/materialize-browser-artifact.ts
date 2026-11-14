import { sendRequestToBitfieldTarget } from '#workspace-records';
import { makeHashCodeHexFromBytes } from '#workspace-records';
import type { AskField } from './action-affordance-types';
import type { BrowserFileFieldValue } from './browser-file-field';
import {
  localActorAdmissionRegistered,
  localActorAdmittedWrapper,
  type AdmissionRecipe,
} from './local-actor-admission';

export const MAX_BROWSER_MATERIALIZATION_BYTES = 16 * 1024 * 1024;

export type AdmittedMaterializerDescriptor = {
  readonly target: string;
  readonly admission: 'hosted-session-admitted';
  readonly output_contract: { readonly kind: string };
  readonly relation?: Record<string, unknown>;
  readonly provenance?: Record<string, unknown>;
  readonly admission_recipe?: AdmissionRecipe;
};

export type MaterializedRelation = {
  readonly kind: 'content-media.materialized-relation/v1';
  readonly relation_ref: string;
  readonly media_type: string;
  readonly display_name: string;
  readonly byte_length: number;
  readonly integrity_hash: string;
};

type Dispatch = (request: { target: string; payload: Record<string, unknown> }) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

export function admittedMaterializerDescriptor(value: unknown): AdmittedMaterializerDescriptor {
  const descriptor = record(value);
  const output = record(descriptor?.output_contract);
  const relation = descriptor?.relation;
  const provenance = descriptor?.provenance;
  const recipe = descriptor?.admission_recipe;
  if (!descriptor || descriptor.admission !== 'hosted-session-admitted' || !output
    || typeof output.kind !== 'string' || !output.kind.trim()
    || (relation !== undefined && !record(relation)) || (provenance !== undefined && !record(provenance))) {
    throw new Error('materializer descriptor is not an admitted data contract');
  }
  if (record(relation)?.context_ref !== undefined) {
    throw new Error('materializer relation.context_ref is owner-derived');
  }
  const target = requiredText(descriptor.target, 'materializer.target');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(target)) throw new Error('materializer.target is invalid');
  return {
    target,
    admission: 'hosted-session-admitted',
    output_contract: { kind: output.kind.trim() },
    ...(record(relation) ? { relation: record(relation)! } : {}),
    ...(record(provenance) ? { provenance: record(provenance)! } : {}),
    ...(admissionRecipe(recipe) ? { admission_recipe: admissionRecipe(recipe)! } : {}),
  };
}

function admissionRecipe(value: unknown): AdmissionRecipe | null {
  if (value === undefined || value === null) return null;
  const recipe = record(value);
  if (
    !recipe
    || typeof recipe.action_ref !== 'string' || !recipe.action_ref.trim()
    || typeof recipe.predicate_ref !== 'string' || !recipe.predicate_ref.trim()
    || !record(recipe.predicate_binding) || !record(recipe.subject_binding) || !record(recipe.resource_revision_binding)
  ) throw new Error('materializer descriptor carries an invalid admission recipe');
  return recipe as AdmissionRecipe;
}

function materializedRelation(value: unknown): MaterializedRelation {
  const reply = record(value);
  const result = record(reply?.payload) ?? reply;
  if (!result || result.kind !== 'content-media.materialized-relation/v1') throw new Error('materializer owner returned an invalid relation');
  const byteLength = result.byte_length;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_BROWSER_MATERIALIZATION_BYTES) {
    throw new Error('materializer owner returned an invalid byte length');
  }
  const relationRef = requiredText(result.relation_ref, 'relation_ref');
  if (/payload_address|storage_ref|cas_address/.test(JSON.stringify(result))) {
    throw new Error('materializer owner exposed a storage identity');
  }
  return {
    kind: 'content-media.materialized-relation/v1',
    relation_ref: relationRef,
    media_type: requiredText(result.media_type, 'media_type').toLowerCase(),
    display_name: requiredText(result.display_name, 'display_name'),
    byte_length: byteLength,
    integrity_hash: requiredText(result.integrity_hash, 'integrity_hash'),
  };
}

/** Runtime Kit target replies arrive as byte payloads (carrier frames); the
 * materializer relation is JSON inside them. A byte-view payload decodes
 * before the relation reader sees it. */
function decodedOwnerReply(reply: unknown): unknown {
  const wrapper = record(reply);
  const payload = wrapper?.payload;
  if (payload instanceof Uint8Array) {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  }
  if (payload instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(payload)));
  }
  if (ArrayBuffer.isView(payload)) {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)));
  }
  return reply;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = record(value);
  if (!object) return value === undefined ? null : value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
}

function relationIdentity(relation: Record<string, unknown> | undefined) {
  return {
    target_ref: relation?.target_ref ?? null,
    context_ref: null,
    role_ref: relation?.role_ref ?? null,
  };
}

/** The idempotency domain is a relation, not a file. Runtime Kit owns the
 * digest primitive; canonical relation data prevents identical bytes addressed
 * to different target/context/role tuples from collapsing into one relation. */
function idempotencyFor(
  descriptor: AdmittedMaterializerDescriptor,
  bytes: Uint8Array,
  source: { media_type: string; display_name: string },
): string {
  const byteDigest = makeHashCodeHexFromBytes(bytes);
  const identity = canonical({
    kind: 'content-media.relation-idempotency/v1',
    materializer_target: descriptor.target,
    bytes: { integrity_hash: byteDigest, byte_length: bytes.byteLength },
    source: {
      media_type: source.media_type,
      display_name: source.display_name,
      provenance: descriptor.provenance ?? {},
    },
    relation: relationIdentity(descriptor.relation),
  });
  return `relation:${makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(identity)))}`;
}

/** Converts browser-selected bytes into the bounded JSON-safe source grammar.
 * The caller supplies only a DATA descriptor; it cannot select a CAS namespace
 * or storage reference. One dispatch grammar everywhere: when a local-actor
 * admission carrier is registered and the descriptor carries the doorway
 * admission recipe, the seam obtains the durable access decision and
 * dispatches the admitted wrapper; otherwise it dispatches raw and the
 * ambient server carrier (hosted public apps) owns admission. */
export async function materializeBrowserBytes(
  input: {
    readonly bytes: Uint8Array;
    readonly media_type: string;
    readonly display_name: string;
    readonly descriptor: unknown;
  },
  dispatch: Dispatch = sendRequestToBitfieldTarget as Dispatch,
): Promise<MaterializedRelation> {
  const descriptor = admittedMaterializerDescriptor(input.descriptor);
  if (input.bytes.byteLength > MAX_BROWSER_MATERIALIZATION_BYTES) throw new Error('selected file exceeds the browser materialization bound');
  const mediaType = requiredText(input.media_type, 'media_type').toLowerCase();
  const displayName = requiredText(input.display_name, 'display_name');
  const ownerPayload: Record<string, unknown> = {
    source: {
      bytes: Array.from(input.bytes),
      media_type: mediaType,
      display_name: displayName,
      byte_length: input.bytes.byteLength,
      provenance: descriptor.provenance ?? {},
    },
    ...(descriptor.relation ? { relation: descriptor.relation } : {}),
    idempotency_ref: idempotencyFor(descriptor, input.bytes, {
      media_type: mediaType,
      display_name: displayName,
    }),
  };
  const admitted = localActorAdmissionRegistered() && descriptor.admission_recipe
    ? await localActorAdmittedWrapper({
      target: descriptor.target,
      payload: ownerPayload,
      recipe: descriptor.admission_recipe,
      dispatch,
    })
    : ownerPayload;
  const result = await dispatch({
    target: descriptor.target,
    payload: admitted as Record<string, unknown>,
  });
  const materialized = materializedRelation(decodedOwnerReply(result));
  if (materialized.byte_length !== input.bytes.byteLength || materialized.media_type !== mediaType) {
    throw new Error('materializer owner returned mismatched caller-ready metadata');
  }
  return materialized;
}

/** ActionForm host adapter. It accepts only the browser-file capability handle,
 * reads it once under the shared byte bound, and replaces the answer with the
 * owner result. */
export async function materializeActionFormFile(
  request: {
    readonly field: AskField;
    readonly value: unknown;
    readonly answers: Readonly<Record<string, unknown>>;
    readonly descriptor: Readonly<Record<string, unknown>>;
  },
  dispatch: Dispatch = sendRequestToBitfieldTarget as Dispatch,
): Promise<MaterializedRelation> {
  const value = record(request.value) as Partial<BrowserFileFieldValue> | null;
  const file = value?.handle;
  if (typeof File === 'undefined' || !(file instanceof File)) throw new Error(`${request.field.label} requires a browser file handle`);
  if (file.size > MAX_BROWSER_MATERIALIZATION_BYTES) throw new Error('selected file exceeds the browser materialization bound');
  const bytes = new Uint8Array(await file.arrayBuffer());
  return materializeBrowserBytes({
    bytes,
    media_type: file.type || 'application/octet-stream',
    display_name: file.name || 'artifact.bin',
    descriptor: request.descriptor,
  }, dispatch);
}
