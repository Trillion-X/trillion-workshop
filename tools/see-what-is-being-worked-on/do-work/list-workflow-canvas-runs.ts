// packages/workflow-canvas/do-work/list-workflow-canvas-runs.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Read the durable run trail for one definition: the owner-written execution
// receipts on the run-receipt path (asked for by run-workflow-canvas-
// definition). Decoded tolerantly into plain rows for the inspector's
// "Past runs" list — newest first.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The receipts are the owner's evidence — this reader never invents,
//    augments, or backfills run facts.
// 2. Malformed receipts degrade to honest unknowns, never crashes.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';
import { RUN_RECEIPT_KIND } from './run-workflow-canvas-definition';

export interface WorkflowRunReceiptRow {
  definitionId: string;
  status: string;
  durationMs: number;
  startedAtMs: number | null;
  writeCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

export function decodeRunReceiptItems(
  definitionId: string,
  reply: unknown,
): WorkflowRunReceiptRow[] {
  const body = isRecord(reply) && reply.payload instanceof Object && ArrayBuffer.isView(reply.payload)
    ? JSON.parse(new TextDecoder().decode(reply.payload as Uint8Array)) as unknown
    : reply;
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
  const rows: WorkflowRunReceiptRow[] = [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const evidence = isRecord(raw.evidence) ? raw.evidence : {};
    const rowDefinitionId = typeof raw.definition_id === 'string' ? raw.definition_id : '';
    if (rowDefinitionId !== definitionId) continue;
    rows.push({
      definitionId: rowDefinitionId,
      status: typeof raw.status === 'string' ? raw.status : 'unknown',
      durationMs: readNumber(raw.duration_ms),
      startedAtMs: typeof evidence.started_at_ms === 'number' ? evidence.started_at_ms : null,
      writeCount: readNumber(raw.write_count),
    });
  }
  rows.sort((left, right) => (right.startedAtMs ?? 0) - (left.startedAtMs ?? 0));
  return rows;
}

export async function listWorkflowCanvasRuns(input: {
  definitionId: string;
  limit?: number;
}): Promise<WorkflowRunReceiptRow[]> {
  const reply = await sendRequestToBitfieldTarget({
    target: 'slot::find-current-items',
    payload: {
      operation: 'find-current-items',
      in: RUN_RECEIPT_KIND,
      select: ['definition_id', 'status', 'duration_ms', 'write_count', 'evidence'],
      where: { all: [{ field: 'definition_id', eq: input.definitionId }] },
      limit: input.limit ?? 25,
    },
  });
  return decodeRunReceiptItems(input.definitionId, reply);
}
