// packages/account-contact-points/do-work/import-contact-points-target.ts
//
// `account-contact-points.import` — the IMPORTED-LEAD ingestion front door
// (J07 gate free-signup-paid-signup-and, third acquisition path).
//
// Per validated row it (1) derives the account identity via the
// account-identity.derive target (TS boundary — package asks never ride
// inside workflow definitions) and (2) dispatches the SAME
// `action:upsert-email-contact-point` every other acquisition path uses.
// The resulting `account-email-contact-point` delta is the ONE local entry
// signal (L063): the welcome claim + activation buckets fire off it with
// zero import-specific policy. This target adds NO lifecycle logic.
//
// Fail-closed per row: an identity-derive or upsert failure records the row
// as failed with its exact reason — it never fails the batch, and it never
// invents an account id. The raw email stays in the controlled PII store
// (SP7): nothing here signs events or writes to the signed event log.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
// canonical role-materialization reply reader (account-identity owns its reply
// grammar, L098/L043 — declared public-source; same import account-session uses)
import { readMaterializedRoleValue } from '../../../../shared-code/packages/account-identity/read-data/account-identity-materialization';
import { normalizeImportBatch, type NormalizedImportRow } from './import-contact-points';

const ACCOUNT_IDENTITY_TARGET = 'account-identity.derive';
const UPSERT_EMAIL_CONTACT_POINT_ACTION = 'action:upsert-email-contact-point';

type Sender = typeof sendRequestToBitfieldTarget;

function decodeReply(payload: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(payload);
  const parsed = text.trim() ? JSON.parse(text) : {};
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export interface ImportRowResult {
  email: string;
  status: 'imported' | 'failed';
  account_id?: string;
  reason?: string;
}

export interface ImportContactPointsResult {
  kind: 'contact-points-import-result';
  source_ref: string;
  imported: number;
  failed: number;
  rejected: number;
  rows: ImportRowResult[];
  rejections: Array<{ index: number; reason: string; email?: string }>;
}

async function importRow(row: NormalizedImportRow, sender: Sender): Promise<ImportRowResult> {
  try {
    const identityReply = await sender({
      target: ACCOUNT_IDENTITY_TARGET,
      payload: { email: row.email },
    });
    const account_id = readMaterializedRoleValue(identityReply.payload, 'identity.subject');
    // include_output:true is LOAD-BEARING: it keeps this off the entry-scope
    // no-reply lowering lane (which matches the include_output:false plan and
    // fire-and-forgets). An importer that reports per-row status must AWAIT
    // the write — the reply is the proof the contact-point delta landed.
    const upsertReply = await sender({
      target: 'slot::workflow',
      payload: {
        operation: 'execute_definition',
        definition_id: UPSERT_EMAIL_CONTACT_POINT_ACTION,
        include_steps: false,
        include_output: true,
        input: { account_id, address: row.email, source_ref: row.source_ref, at: row.at },
      },
    });
    const upsertStatus = decodeReply(upsertReply.payload).status;
    if (upsertStatus !== 'completed') {
      throw new Error(`upsert-email-contact-point did not complete (status: ${String(upsertStatus)})`);
    }
    return { email: row.email, status: 'imported', account_id };
  } catch (error) {
    return {
      email: row.email,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function importContactPointsTarget(
  input: { source?: unknown; rows?: unknown; at?: string; dry_run?: unknown },
  _context?: { packageData?: unknown },
  sender: Sender = sendRequestToBitfieldTarget,
): Promise<ImportContactPointsResult> {
  const batch = normalizeImportBatch(input);
  const rows: ImportRowResult[] = [];
  if (input.dry_run === true) {
    // validation-only pass: prove the batch decodes without dispatching
    return {
      kind: 'contact-points-import-result',
      source_ref: batch.source_ref,
      imported: 0,
      failed: 0,
      rejected: batch.rejected.length,
      rows: batch.rows.map((row) => ({ email: row.email, status: 'failed' as const, reason: 'dry_run' })),
      rejections: batch.rejected,
    };
  }
  for (const row of batch.rows) rows.push(await importRow(row, sender));
  return {
    kind: 'contact-points-import-result',
    source_ref: batch.source_ref,
    imported: rows.filter((r) => r.status === 'imported').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    rejected: batch.rejected.length,
    rows,
    rejections: batch.rejected,
  };
}
