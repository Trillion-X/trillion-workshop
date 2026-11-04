// packages/command-palette/do-work/ask-palette-bulk-action-descriptors.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic palette bulk-action descriptor seam. The palette reads
// `palette-bulk-action-descriptor` DATA rows (kind: "palette-bulk-action-descriptor")
// to discover what actions are available for bulk selection (multi-select
// checkbox). Each descriptor specifies a workflow action to run when the
// corresponding action row is selected. No domain vocabulary — legal-docs,
// media, contacts, or any future domain works identically.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero domain vocabulary — no "media", "asset", "document" anywhere here.
// 2. Descriptor fields are the ONLY source of action target/definition;
//    this file never hardcodes an action id.
// 3. Result field names (id/label/icon/target/definition_id) come from
//    the descriptor structure, never assumed from external sources.
// 4. Output shape is a flat array of action descriptors for rendering.
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

export interface PaletteBulkActionDescriptor {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly target: string;
  readonly definition_id: string;
  readonly static_input?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GENERIC DECODE HELPERS
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
// M3: Read every admitted palette-bulk-action descriptor
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

    const id = typeof flat.id === 'string' ? flat.id : null;
    if (!id) continue;

    const label = typeof flat.label === 'string' ? flat.label : id;
    const icon = typeof flat.icon === 'string' ? flat.icon : undefined;
    const target = typeof flat.target === 'string' ? flat.target : null;
    const definition_id = typeof flat.definition_id === 'string' ? flat.definition_id : null;

    if (!target || !definition_id) continue;

    descriptors.push({
      id,
      label,
      icon,
      target,
      definition_id,
      static_input: isRecord(flat.static_input) ? flat.static_input : undefined,
    });
  }
  return descriptors;
}

/**
 * Ask the palette for all bulk-action descriptors.
 * These actions are available for multi-selected items.
 */
export async function askPaletteBulkActionDescriptors(
  signal?: AbortSignal,
): Promise<PaletteBulkActionDescriptor[]> {
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
      { signal },
    );

    return readPaletteBulkActionDescriptorsFromReply(reply);
  } catch (error) {
    console.error('[command-palette] failed to read bulk action descriptors:', error);
    return [];
  }
}
