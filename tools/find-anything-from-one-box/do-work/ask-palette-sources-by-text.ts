// packages/command-palette/do-work/ask-palette-sources-by-text.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic palette-source descriptor seam. The palette does not know "media
// search" exists — it knows how to read a `palette-source-descriptor` DATA row
// (kind: "palette-source-descriptor") and dispatch its generic `action`
// binding with the live query text, then map whatever items come back into
// the SAME row shape `read-palette-results.ts` already understands (title,
// description, group, render_hint). A legal-docs descriptor, a contacts
// descriptor, or any future source works identically — zero code change.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero domain vocabulary — no "media", "vector", "embedding" anywhere here.
// 2. Descriptor fields are the ONLY source of dispatch target/action/binding;
//    this file never hardcodes an action id or index id.
// 3. Result field names (id/title/description/group/render_hint) come from
//    the descriptor's `result_mapping`, never assumed from a fixed source.
// 4. Output shape matches `PaletteQueryReply` exactly so it merges into
//    the existing reply array with zero changes to read-palette-results.ts.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';
import type { PaletteQueryReply } from './ask-current-items-ranked-by-text';

const DESCRIPTOR_TARGET = 'slot::find-current-items';
const DESCRIPTOR_KIND = 'palette-source-descriptor';
const RESULT_POLICY_KIND = 'semantic-result-policy';

// ---------------------------------------------------------------------------
// DESCRIPTOR SHAPE (DATA — every field below is read from a stored record)
// ---------------------------------------------------------------------------

export interface PaletteSourceResultMapping {
  readonly id_field?: string;
  readonly score_field?: string;
  readonly title_field?: string;
  readonly description_field?: string;
  readonly group?: string;
  /** A field of each result naming the heading it shows under; `group` when the result has none. */
  readonly group_field?: string;
  /** A field of each result naming its icon (a NamedIcon name); the row shows its group's first letter without one. */
  readonly icon_field?: string;
  readonly render_hint?: string;
  readonly items_path?: readonly string[];
  /** Path to a non-empty list of places still being searched. */
  readonly still_looking_path?: readonly string[];
  readonly canonical_address_field?: string;
  readonly canonical_revision_field?: string;
  readonly payload_hash_field?: string;
  readonly owner_target_field?: string;
  readonly schema_ref_field?: string;
  readonly schema_digest_field?: string;
  readonly authority_provenance_ref_field?: string;
  readonly rank_provenance_ref_field?: string;
  readonly surface_ref_field?: string;
  readonly rank_provenance_ref?: string;
}

export interface PaletteSourceHydration {
  readonly definition_id: string;
  readonly target: string;
  readonly address_field: string;
  readonly revision_field: string;
  readonly payload_hash_field: string;
}

export interface PaletteSourceDispatch {
  readonly target: string;
  readonly definition_id: string;
  readonly static_input?: Record<string, unknown>;
  readonly query_field: string;
  readonly limit_field?: string;
}

export interface PaletteSourceDescriptor {
  readonly id: string;
  readonly dispatch: PaletteSourceDispatch;
  readonly result_mapping: PaletteSourceResultMapping;
  readonly min_query_length?: number;
  readonly result_policy: PaletteResultPolicy;
  readonly authority_ref: string;
  readonly correlation_ref: string;
  readonly hydration: PaletteSourceHydration;
}

export interface PaletteResultPolicy {
  readonly ref: string;
  readonly max_result_count: number;
  readonly max_schema_bytes_per_result: number;
  readonly total_prompt_budget_bytes: number;
}

interface PaletteResultBudget { result_count: number; schema_bytes: number; }

function event(name: string, fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ event: name, ...fields }));
}

function reject(recordAddress: string, reason: string): void {
  event('palette.result.rejected', { record_address: recordAddress, reason_ref: reason });
}

// ---------------------------------------------------------------------------
// GENERIC DECODE HELPERS (duplicated minimally from read-palette-results.ts
// on purpose — this file must never import UI-layer scoring internals)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || (ArrayBuffer.isView(value) && value.constructor.name === 'Uint8Array');
}

const textDecoder = new TextDecoder();

function decodeReplyPayload(reply: unknown): unknown {
  const payload = isRecord(reply) && isBytes(reply.payload) ? reply.payload : reply;
  if (!isBytes(payload)) return payload;
  const text = textDecoder.decode(payload).trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readNestedPayload(row: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(row.payload) ? row.payload : null;
}

function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const payload = readNestedPayload(row);
  return payload ? { ...row, ...payload, payload } : row;
}

function readRows(decoded: unknown): Record<string, unknown>[] {
  if (Array.isArray(decoded)) return decoded.filter(isRecord);
  if (!isRecord(decoded)) return [];
  for (const key of ['items', 'results', 'result', 'choices']) {
    const value = decoded[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

/** Walk an arbitrary path of keys, descending into nested records. */
function readPath(root: Record<string, unknown>, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// M2a: read every admitted palette-source descriptor
// ---------------------------------------------------------------------------

export function readPaletteSourceDescriptorsFromReply(reply: unknown): PaletteSourceDescriptor[] {
  const decoded = decodeReplyPayload(reply);
  const rows = readRows(decoded);
  const policies = new Map<string, PaletteResultPolicy>();
  for (const row of rows) {
    const flat = flattenRow(row);
    if (flat.kind !== RESULT_POLICY_KIND || typeof flat.id !== 'string') continue;
    const maxResultCount = flat.max_result_count;
    const maxSchemaBytes = flat.max_schema_bytes_per_result;
    const totalPromptBytes = flat.total_prompt_budget_bytes;
    if (![maxResultCount, maxSchemaBytes, totalPromptBytes].every((value) => typeof value === 'number' && Number.isInteger(value) && value > 0)) continue;
    policies.set(`semantic-result-policy:${flat.id}`, {
      ref: `semantic-result-policy:${flat.id}`,
      max_result_count: maxResultCount as number,
      max_schema_bytes_per_result: maxSchemaBytes as number,
      total_prompt_budget_bytes: totalPromptBytes as number,
    });
  }
  const descriptors: PaletteSourceDescriptor[] = [];
  for (const row of rows) {
    const flat = flattenRow(row);
    if (flat.kind !== DESCRIPTOR_KIND) continue;
    const dispatch = flat.dispatch;
    const resultMapping = flat.result_mapping;
    if (!isRecord(dispatch) || typeof dispatch.target !== 'string' || typeof dispatch.definition_id !== 'string' || typeof dispatch.query_field !== 'string') {
      continue;
    }
    if (!isRecord(resultMapping)) continue;
    const id = typeof flat.id === 'string' ? flat.id : null;
    const policyRef = typeof flat.result_policy_ref === 'string'
      ? flat.result_policy_ref
      : (isRecord(dispatch.static_input) && typeof dispatch.static_input.result_policy_ref === 'string'
        ? dispatch.static_input.result_policy_ref : null);
    const policy = policyRef ? policies.get(policyRef) : undefined;
    const canonicalMappingFields = ['canonical_address_field', 'canonical_revision_field', 'payload_hash_field', 'owner_target_field', 'schema_ref_field', 'schema_digest_field', 'authority_provenance_ref_field', 'score_field', 'rank_provenance_ref_field'];
    const authorityRef = typeof flat.authority_ref === 'string' ? flat.authority_ref : null;
    const correlationRef = typeof flat.correlation_ref === 'string' ? flat.correlation_ref : null;
    const hydration = flat.hydration;
    if (!id || !policy || !authorityRef || !correlationRef || !isRecord(hydration) || typeof hydration.definition_id !== 'string' || typeof hydration.target !== 'string' || typeof hydration.address_field !== 'string' || typeof hydration.revision_field !== 'string' || typeof hydration.payload_hash_field !== 'string' || canonicalMappingFields.some((field) => typeof resultMapping[field] !== 'string')) continue;
    descriptors.push({
      id,
      dispatch: {
        target: dispatch.target,
        definition_id: dispatch.definition_id,
        query_field: dispatch.query_field,
        static_input: isRecord(dispatch.static_input) ? dispatch.static_input : undefined,
        limit_field: typeof dispatch.limit_field === 'string' ? dispatch.limit_field : undefined,
      },
      result_mapping: {
        id_field: typeof resultMapping.id_field === 'string' ? resultMapping.id_field : undefined,
        score_field: typeof resultMapping.score_field === 'string' ? resultMapping.score_field : undefined,
        title_field: typeof resultMapping.title_field === 'string' ? resultMapping.title_field : undefined,
        description_field: typeof resultMapping.description_field === 'string' ? resultMapping.description_field : undefined,
        group: typeof resultMapping.group === 'string' ? resultMapping.group : undefined,
        group_field: typeof resultMapping.group_field === 'string' ? resultMapping.group_field : undefined,
        icon_field: typeof resultMapping.icon_field === 'string' ? resultMapping.icon_field : undefined,
        render_hint: typeof resultMapping.render_hint === 'string' ? resultMapping.render_hint : undefined,
        items_path: Array.isArray(resultMapping.items_path)
          ? resultMapping.items_path.filter((seg): seg is string => typeof seg === 'string')
          : undefined,
        still_looking_path: Array.isArray(resultMapping.still_looking_path)
          ? resultMapping.still_looking_path.filter((seg): seg is string => typeof seg === 'string')
          : undefined,
        canonical_address_field: typeof resultMapping.canonical_address_field === 'string' ? resultMapping.canonical_address_field : undefined,
        canonical_revision_field: typeof resultMapping.canonical_revision_field === 'string' ? resultMapping.canonical_revision_field : undefined,
        payload_hash_field: typeof resultMapping.payload_hash_field === 'string' ? resultMapping.payload_hash_field : undefined,
        owner_target_field: typeof resultMapping.owner_target_field === 'string' ? resultMapping.owner_target_field : undefined,
        schema_ref_field: typeof resultMapping.schema_ref_field === 'string' ? resultMapping.schema_ref_field : undefined,
        schema_digest_field: typeof resultMapping.schema_digest_field === 'string' ? resultMapping.schema_digest_field : undefined,
        authority_provenance_ref_field: typeof resultMapping.authority_provenance_ref_field === 'string' ? resultMapping.authority_provenance_ref_field : undefined,
        rank_provenance_ref_field: typeof resultMapping.rank_provenance_ref_field === 'string' ? resultMapping.rank_provenance_ref_field : undefined,
        surface_ref_field: typeof resultMapping.surface_ref_field === 'string' ? resultMapping.surface_ref_field : undefined,
        rank_provenance_ref: typeof resultMapping.rank_provenance_ref === 'string' ? resultMapping.rank_provenance_ref : undefined,
      },
      min_query_length: typeof flat.min_query_length === 'number' ? flat.min_query_length : undefined,
      result_policy: policy,
      authority_ref: authorityRef,
      correlation_ref: correlationRef,
      hydration: { definition_id: hydration.definition_id, target: hydration.target, address_field: hydration.address_field, revision_field: hydration.revision_field, payload_hash_field: hydration.payload_hash_field },
    });
  }
  return descriptors;
}

export async function askPaletteSourceDescriptors(signal?: AbortSignal): Promise<PaletteSourceDescriptor[]> {
  try {
    const reply = await sendRequestToBitfieldTarget(
      {
        target: DESCRIPTOR_TARGET,
        payload: {
          operation: 'find-current-items',
          in: 'published-record',
          where: { all: [{ field: 'kind', in: [DESCRIPTOR_KIND, RESULT_POLICY_KIND] }] },
        },
      },
      signal,
    );
    return readPaletteSourceDescriptorsFromReply(reply);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// M2b: map one raw dispatch-reply item into the row shape read-palette-results
// already understands (title/description/group/render_hint/id) — DATA-driven
// field selection only, never a fixed field name assumption.
// ---------------------------------------------------------------------------

function deriveFallbackTitle(id: string): string {
  // Trailing "label:N" pairs are positional coordinates (an ordinal plus its
  // axis name), not the thing itself — strip each pair so "…/video.mp4:x:0"
  // titles as "video.mp4", never "0". Purely structural: a pure-number tail
  // consumes itself and one preceding label segment.
  const segments = id.split(/[:/]+/).filter(Boolean);
  while (segments.length > 1 && /^\d+$/.test(segments[segments.length - 1])) {
    segments.pop();
    if (segments.length > 1) segments.pop();
  }
  const lastSegment = segments.pop();
  return lastSegment && lastSegment.length > 0 ? lastSegment : id;
}

async function hydrateRankedRow(
  ranked: Record<string, unknown>,
  descriptor: PaletteSourceDescriptor,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const address = ranked.address;
  if (typeof address !== 'string' || !address) { reject('unknown', 'rank-result-missing-address'); return null; }
  const reply = await sendRequestToBitfieldTarget({
    // Meaning Search owns this operation. Palette supplies descriptor DATA and
    // never receives an unvalidated owner row.
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition', definition_id: descriptor.hydration.definition_id, include_output: true,
      input: {
        owner_query_target: descriptor.hydration.target,
        owner_query: {
          operation: 'find-current-items',
          in: 'published-record',
          addresses: [address],
          include: ['address', 'content_hash', 'payload'],
        },
        canonical_address: address,
        canonical_revision: ranked.revision,
        payload_hash: ranked.payload_hash,
        owner_target: ranked.owner_target,
        schema_ref: ranked.schema_ref,
        schema_digest: ranked.schema_digest,
        surface_ref: ranked.surface_ref,
        title: ranked.title,
        description: ranked.description,
        input_schema: ranked.input_schema,
        rank_score: ranked.score,
        rank_provenance_ref: descriptor.result_mapping.rank_provenance_ref ?? ranked.rank_provenance_ref,
        authority_provenance_ref: ranked.authority_provenance_ref,
        descriptor_revision: ranked.descriptor_revision,
        model_provenance_ref: ranked.model_provenance_ref,
      },
    },
  }, signal);
  const decoded = decodeReplyPayload(reply);
  const output = isRecord(decoded) && isRecord(decoded.output) ? decoded.output : decoded;
  const owner = isRecord(output) && isRecord(output.item) ? flattenRow(output.item) : null;
  if (!owner) {
    reject(address, 'stale-or-missing-canonical-owner');
    return null;
  }
  return owner;
}

export function mapDispatchItemToPaletteRow(
  raw: Record<string, unknown>,
  mapping: PaletteSourceResultMapping,
): Record<string, unknown> | null {
  const canonicalAddress = raw[mapping.canonical_address_field ?? 'canonical_address'];
  const idValue = canonicalAddress;
  if (typeof idValue !== 'string' || idValue.length === 0) return null;

  const scoreValue = mapping.score_field ? raw[mapping.score_field] : raw.score;
  const titleValue = mapping.title_field ? raw[mapping.title_field] : undefined;
  const descriptionValue = mapping.description_field ? raw[mapping.description_field] : undefined;

  const canonicalFields = Object.fromEntries([
    ['canonical_address', canonicalAddress],
    ['canonical_revision', raw[mapping.canonical_revision_field ?? 'canonical_revision']],
    ['payload_hash', raw[mapping.payload_hash_field ?? 'payload_hash']],
    ['owner_target', raw[mapping.owner_target_field ?? 'owner_target']],
    ['schema_ref', raw[mapping.schema_ref_field ?? 'schema_ref']],
    ['schema_digest', raw[mapping.schema_digest_field ?? 'schema_digest']],
    ['authority_provenance_ref', raw[mapping.authority_provenance_ref_field ?? 'authority_provenance_ref']],
    ['rank_provenance_ref', mapping.rank_provenance_ref ?? raw[mapping.rank_provenance_ref_field ?? 'rank_provenance_ref']],
    ['descriptor_revision', raw.descriptor_revision],
    ['model_provenance_ref', raw.model_provenance_ref],
    ['surface_ref', raw[mapping.surface_ref_field ?? 'surface_ref']],
    ['input_schema', raw.input_schema],
  ].filter(([, value]) => value !== undefined));

  return {
    id: idValue,
    address: canonicalAddress,
    target: typeof canonicalFields.owner_target === 'string' ? canonicalFields.owner_target : undefined,
    title: typeof titleValue === 'string' && titleValue.length > 0 ? titleValue : deriveFallbackTitle(idValue),
    description: typeof descriptionValue === 'string' ? descriptionValue : '',
    group: (mapping.group_field && typeof raw[mapping.group_field] === 'string' ? raw[mapping.group_field] as string : undefined) ?? mapping.group ?? 'Results',
    ...(mapping.icon_field && typeof raw[mapping.icon_field] === 'string' ? { icon: raw[mapping.icon_field] } : {}),
    render_hint: mapping.render_hint,
    score: typeof scoreValue === 'number' ? scoreValue : undefined,
    rank_score: typeof scoreValue === 'number' ? scoreValue : undefined,
    ...canonicalFields,
  };
}

// ---------------------------------------------------------------------------
// M2c: dispatch one descriptor with the live query text, produce a reply
// shaped EXACTLY like PaletteQueryReply so it merges with zero changes
// to the existing reader/scorer.
// ---------------------------------------------------------------------------

export async function askPaletteSourceByText(
  descriptor: PaletteSourceDescriptor,
  queryText: string,
  signal?: AbortSignal,
  budget: PaletteResultBudget = { result_count: 0, schema_bytes: 0 },
): Promise<PaletteQueryReply | null> {
  const trimmed = queryText.trim();
  const minLength = descriptor.min_query_length ?? 1;
  if (trimmed.length < minLength) return null;

  const startedAt = performance.now();
  const input: Record<string, unknown> = {
    ...(descriptor.dispatch.static_input ?? {}),
    [descriptor.dispatch.query_field]: trimmed,
  };
  if (descriptor.dispatch.limit_field) {
    input[descriptor.dispatch.limit_field] = descriptor.result_policy.max_result_count;
  }
  const queryRef = `${descriptor.correlation_ref}:${startedAt.toFixed(3)}`;
  event('palette.source_query.started', { query_ref: queryRef, source_ref: descriptor.id, authority_ref: descriptor.authority_ref, policy_ref: descriptor.result_policy.ref });

  try {
    const reply = await sendRequestToBitfieldTarget(
      {
        target: descriptor.dispatch.target,
        payload: {
          operation: 'execute_definition',
          definition_id: descriptor.dispatch.definition_id,
          // Without include_output the workflow reply carries ONLY
          // {definition_id,status,duration_ms} — no output object — so every
          // result_mapping.items_path read resolves empty and the palette
          // silently shows "No results" (T8c root cause). include_steps stays
          // off: step echo can carry KB-scale payloads and trap the wasm
          // serializer.
          include_output: true,
          include_steps: false,
          input,
        },
      },
      signal,
    );
    const decoded = decodeReplyPayload(reply);
    const itemsRoot = descriptor.result_mapping.items_path && isRecord(decoded)
      ? readPath(decoded, descriptor.result_mapping.items_path)
      : decoded;
    const rawRows = readRows(itemsRoot) ?? [];
    const stillLookingIn = descriptor.result_mapping.still_looking_path && isRecord(decoded)
      ? readPath(decoded, descriptor.result_mapping.still_looking_path)
      : null;
    const mappedRows: Record<string, unknown>[] = [];
    for (const rawRow of rawRows) {
      const hydrated = await hydrateRankedRow(flattenRow(rawRow), descriptor, signal);
      if (!hydrated) continue;
      const mapped = mapDispatchItemToPaletteRow(hydrated, descriptor.result_mapping);
      const recordAddress = typeof mapped?.canonical_address === 'string' ? mapped.canonical_address : 'unknown';
      if (!mapped) { reject(recordAddress, 'invalid-canonical-result'); continue; }
      const requiredStrings = ['canonical_address', 'canonical_revision', 'payload_hash', 'owner_target', 'schema_ref', 'schema_digest', 'authority_provenance_ref', 'rank_provenance_ref', 'descriptor_revision', 'model_provenance_ref'];
      if (requiredStrings.some((field) => typeof mapped[field] !== 'string' || (mapped[field] as string).length === 0) || typeof mapped.rank_score !== 'number' || !Number.isFinite(mapped.rank_score as number)) {
        reject(recordAddress, 'missing-canonical-result-field');
        continue;
      }
      if (mapped.input_schema !== undefined) {
        const bytes = new TextEncoder().encode(JSON.stringify(mapped.input_schema)).byteLength;
        if (bytes > descriptor.result_policy.max_schema_bytes_per_result || budget.schema_bytes + bytes > descriptor.result_policy.total_prompt_budget_bytes) {
          reject(recordAddress, 'schema-budget-exceeded');
          continue;
        }
        budget.schema_bytes += bytes;
      }
      if (budget.result_count >= descriptor.result_policy.max_result_count) {
        reject(recordAddress, 'result-count-exceeded');
        continue;
      }
      mappedRows.push(mapped);
      budget.result_count += 1;
    }
    event('palette.source_query.completed', { query_ref: queryRef, source_ref: descriptor.id, candidate_count: rawRows.length, returned_count: mappedRows.length, elapsed_ms: performance.now() - startedAt, policy_ref: descriptor.result_policy.ref });

    return {
      target: descriptor.dispatch.target,
      recordId: descriptor.id,
      sourcePath: `${descriptor.dispatch.definition_id}.items`,
      publishedRecord: null,
      durationMs: performance.now() - startedAt,
      reply: { items: mappedRows },
      error: null,
      stillLooking: Array.isArray(stillLookingIn) && stillLookingIn.length > 0,
    };
  } catch (rawError: unknown) {
    const error = rawError instanceof Error ? rawError.message : String(rawError);
    return {
      target: descriptor.dispatch.target,
      recordId: descriptor.id,
      sourcePath: `${descriptor.dispatch.definition_id}.items`,
      publishedRecord: null,
      durationMs: performance.now() - startedAt,
      reply: null,
      error,
    };
  }
}

export async function askAllPaletteSourcesByText(
  descriptors: readonly PaletteSourceDescriptor[],
  queryText: string,
  signal?: AbortSignal,
): Promise<PaletteQueryReply[]> {
  const budgets = new Map<string, PaletteResultBudget>();
  const replies: PaletteQueryReply[] = [];
  for (const descriptor of [...descriptors].sort((left, right) => left.id.localeCompare(right.id))) {
    const budget = budgets.get(descriptor.result_policy.ref) ?? { result_count: 0, schema_bytes: 0 };
    budgets.set(descriptor.result_policy.ref, budget);
    const reply = await askPaletteSourceByText(descriptor, queryText, signal, budget);
    if (reply) replies.push(reply);
  }
  return replies;
}
