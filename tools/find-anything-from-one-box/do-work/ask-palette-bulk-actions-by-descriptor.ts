// packages/command-palette/do-work/ask-palette-bulk-actions-by-descriptor.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic bulk-action descriptor seam. The palette does not know what actions
// are possible on a group of selected results — it knows how to read a
// `palette-bulk-action-descriptor` DATA row (kind:
// "palette-bulk-action-descriptor") scoped to a result `group` (the SAME
// `group` string a `palette-source-descriptor`'s `result_mapping.group`
// produces), and dispatch its generic `action` binding with the raw selected
// items. A "Move to folder" action for local files, a "Add to collection"
// action for media, or any future bulk action on any future group works
// identically — zero code change here.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero domain vocabulary — no "media", "collection", "video" anywhere here.
// 2. Descriptor fields are the ONLY source of dispatch target/action/binding;
//    this file never hardcodes an action id, a group name, or a label.
// 3. Zero admitted rows for a group is a valid, honest state — it means that
//    group currently has no bulk actions, not an error.
// 4. Output (label + a runner closure) is exactly what a BulkSelectBar action
//    row needs (label, onClick) — the UI layer never inspects descriptor
//    internals.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';

const DESCRIPTOR_TARGET = 'slot::find-current-items';
const DESCRIPTOR_KIND = 'palette-bulk-action-descriptor';

// ---------------------------------------------------------------------------
// DESCRIPTOR SHAPE (DATA — every field below is read from a stored record)
// ---------------------------------------------------------------------------

export interface PaletteBulkActionDispatch {
  readonly target: string;
  readonly definition_id: string;
  readonly static_input?: Record<string, unknown>;
  readonly selected_field: string;
}

export interface PaletteBulkActionDescriptor {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly variant?: 'default' | 'danger';
  readonly dispatch: PaletteBulkActionDispatch;
}

// ---------------------------------------------------------------------------
// GENERIC DECODE HELPERS (duplicated minimally from ask-palette-sources-by-text
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

// ---------------------------------------------------------------------------
// M2d: read every admitted bulk-action descriptor scoped to a set of groups
// ---------------------------------------------------------------------------

export function readPaletteBulkActionDescriptorsFromReply(
  reply: unknown,
): PaletteBulkActionDescriptor[] {
  const decoded = decodeReplyPayload(reply);
  const rows = readRows(decoded);
  const descriptors: PaletteBulkActionDescriptor[] = [];
  for (const row of rows) {
    const flat = flattenRow(row);
    if (flat.kind !== DESCRIPTOR_KIND) continue;
    const dispatch = flat.dispatch;
    if (
      !isRecord(dispatch) ||
      typeof dispatch.target !== 'string' ||
      typeof dispatch.definition_id !== 'string' ||
      typeof dispatch.selected_field !== 'string'
    ) {
      continue;
    }
    const id = typeof flat.id === 'string' ? flat.id : null;
    const group = typeof flat.group === 'string' ? flat.group : null;
    const label = typeof flat.label === 'string' ? flat.label : null;
    if (!id || !group || !label) continue;
    descriptors.push({
      id,
      group,
      label,
      variant: flat.variant === 'danger' ? 'danger' : 'default',
      dispatch: {
        target: dispatch.target,
        definition_id: dispatch.definition_id,
        selected_field: dispatch.selected_field,
        static_input: isRecord(dispatch.static_input) ? dispatch.static_input : undefined,
      },
    });
  }
  return descriptors;
}

export async function askPaletteBulkActionDescriptors(
  groups: readonly string[],
  signal?: AbortSignal,
): Promise<PaletteBulkActionDescriptor[]> {
  if (groups.length === 0) return [];
  try {
    const reply = await sendRequestToBitfieldTarget(
      {
        target: DESCRIPTOR_TARGET,
        payload: {
          operation: 'find-current-items',
          in: 'published-record',
          where: { all: [{ field: 'kind', in: [DESCRIPTOR_KIND] }] },
        },
      },
      signal,
    );
    const all = readPaletteBulkActionDescriptorsFromReply(reply);
    const groupSet = new Set(groups);
    return all.filter((descriptor) => groupSet.has(descriptor.group));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// M2e: run one bulk action against the raw items currently selected — the
// descriptor never assumes a fixed selection shape, it names its own field.
// ---------------------------------------------------------------------------

export interface RunPaletteBulkActionOutcome {
  readonly ok: boolean;
  readonly error: string | null;
}

export async function runPaletteBulkAction(
  descriptor: PaletteBulkActionDescriptor,
  selectedRawItems: readonly unknown[],
): Promise<RunPaletteBulkActionOutcome> {
  const input: Record<string, unknown> = {
    ...(descriptor.dispatch.static_input ?? {}),
    [descriptor.dispatch.selected_field]: selectedRawItems,
  };
  try {
    await sendRequestToBitfieldTarget({
      target: descriptor.dispatch.target,
      payload: {
        operation: 'execute_definition',
        definition_id: descriptor.dispatch.definition_id,
        input,
      },
    });
    return { ok: true, error: null };
  } catch (rawError: unknown) {
    const error = rawError instanceof Error ? rawError.message : String(rawError);
    return { ok: false, error };
  }
}
