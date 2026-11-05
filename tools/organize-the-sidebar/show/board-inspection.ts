// packages/group/show/board-inspection.ts

import {
  createInspectionResolverRegistry,
  type InspectionResolver,
  type InspectionSource,
} from '../../ui/show/inspection-ref';
import {
  createBlindRegistry,
  type BlindRegistry,
} from '../../ui/show/blind-registry/blind-registry';
import { parseRows } from '../read-data/catalog-merge.ts';
import BOARD_FIELDS from '../read-data/board-inspection-fields.json' with { type: 'json' };

/** The board's write kind for item edits — routed by the panel through its
 *  write-op registry. An open string like any other write kind. */
export const BOARD_MODEL_WRITE_KIND = 'group.board-model';

/** The published-record kind carrying a surface's inspectable fields. */
export const INSPECTION_FIELD_SET_KIND = 'inspection-field-descriptor-set';

export interface BoardItemLike {
  readonly memberId: string;
  readonly text?: string;
  readonly extra?: Record<string, unknown> | null;
}

/** One inspectable field — a DATA row from an inspection-field-descriptor-set
 *  record. `write_op` is an open key the host's write-op registry dispatches;
 *  `write_config` is opaque config that op receives. New field = one row. */
export interface InspectionFieldRow {
  readonly id: string;
  readonly label: string;
  readonly path: readonly string[];
  readonly write_op: string;
  readonly write_config?: Record<string, unknown>;
  /** How the shared inspector draws the value (a TuningPanel setting without key and label). */
  readonly setting?: Readonly<Record<string, unknown>> & { readonly widget?: string };
}

/** family → its field rows, decoded from published records. */
export type InspectionFieldSets = ReadonlyMap<string, readonly InspectionFieldRow[]>;

function readFieldRow(raw: unknown): InspectionFieldRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.write_op !== 'string') return null;
  if (!Array.isArray(row.path) || row.path.some((p) => typeof p !== 'string')) return null;
  return {
    id: row.id,
    label: typeof row.label === 'string' ? row.label : '',
    path: row.path as string[],
    write_op: row.write_op,
    ...(row.write_config && typeof row.write_config === 'object'
      ? { write_config: row.write_config as Record<string, unknown> }
      : {}),
    ...(row.setting && typeof row.setting === 'object' && !Array.isArray(row.setting)
      ? { setting: row.setting as Record<string, unknown> }
      : {}),
  };
}

/** Decode every inspection-field-descriptor-set: the board's own rows (read-data/board-inspection-fields.json)
 *  first, then published records, a published set replacing the board's for its family.
 *  Blind: families and rows are whatever the DATA declares. */
export function readInspectionFieldSets(
  records: ReadonlyArray<{ payload?: unknown }>,
): InspectionFieldSets {
  const sets = new Map<string, readonly InspectionFieldRow[]>();
  for (const record of [{ payload: BOARD_FIELDS }, ...records]) {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload || payload.kind !== INSPECTION_FIELD_SET_KIND) continue;
    if (typeof payload.family !== 'string') continue;
    // Shared fail-safe row parser (one owner: L063) — skips non-object/malformed field rows.
    const rows = parseRows(payload.fields, readFieldRow);
    if (rows.length > 0) sets.set(payload.family, rows);
  }
  return sets;
}

/**
 * Build the board's resolver registry from descriptor DATA. One resolver is
 * registered per family PRESENT IN THE DATA — the module never names a family
 * itself. `findItem` is injected (the panel's live item lookup). No field sets
 * → an empty registry → honest surface-scope-only inspection.
 */
export function createBoardInspectionRegistry(
  findItem: (memberId: string) => BoardItemLike | null,
  fieldSets: InspectionFieldSets,
): BlindRegistry<InspectionResolver> {
  const registry = createInspectionResolverRegistry();
  for (const [family, rows] of fieldSets) {
    registry.register(family, (ref): readonly InspectionSource[] | null => {
      const memberId = ref.parts.member;
      if (!memberId) return null;
      const item = findItem(memberId);
      if (!item) return null;
      return rows.map((row) => ({
        recordAddress: `board-item::${memberId}`,
        fieldPath: row.path,
        label: row.label,
        ...(row.setting ? { setting: row.setting } : {}),
        write: {
          kind: BOARD_MODEL_WRITE_KIND,
          inputTemplate: {
            member_id: memberId,
            op: row.write_op,
            config: row.write_config ?? {},
            value: '$value',
          },
        },
      }));
    });
  }
  return registry;
}

/** The record projection the host serves for `board-item::<id>` reads: the
 *  item's inspectable values. `fill` is the resolved fill color the host
 *  derives from the item's layer stack (the host owns that derivation). */
export function boardItemRecordProjection(
  item: BoardItemLike,
  fillColor: string | undefined,
): Record<string, unknown> {
  return { text: item.text ?? '', fill: fillColor ?? '', extra: { ...(item.extra ?? {}) } };
}

/** A write-op handler: applies one op to one member. Registered by the host
 *  for each op its mutation seams support; dispatched by open-key lookup. */
export type BoardWriteOp = (
  memberId: string,
  value: unknown,
  config: Record<string, unknown>,
) => Promise<void>;

/** An op registry with no fallback — an unknown op is an honest error at
 *  dispatch (the descriptor DATA named an op this host has no seam for). */
export function createBoardWriteOpRegistry(): BlindRegistry<BoardWriteOp> {
  return createBlindRegistry<BoardWriteOp>();
}

/** Dispatch a board-model write input through the op registry. Pure routing —
 *  no path inspection, no op names, no field knowledge. */
export async function dispatchBoardModelWrite(
  input: Record<string, unknown>,
  ops: BlindRegistry<BoardWriteOp>,
  unsupportedText: string,
): Promise<void> {
  const memberId = typeof input.member_id === 'string' ? input.member_id : null;
  const op = typeof input.op === 'string' ? ops.get(input.op) : undefined;
  if (!memberId || !op) throw new Error(unsupportedText);
  const config =
    input.config && typeof input.config === 'object'
      ? (input.config as Record<string, unknown>)
      : {};
  await op(memberId, input.value, config);
}
