// src/workspace/door-grant-approval.ts
//
// PURPOSE
//   Reads the person's master auto-approve for door grants: the one statement APPROVAL_SQL (door-grant.mjs), run through
//   the SQL tool with the connection account-records.json names, the same road sql-records.ts and account-notifications.ts
//   use. Its answer rows say whether the grant is kept without a press (autoOf). Any failure is an answer of "ask": the
//   person presses Allow, never an automatic keep by mistake.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A failed or unreadable check asks the person (returns null); it never keeps a grant.
//   2. The statement is the engine's rule shape (approval.rs CHECK_SQL); this file adds no second rule.

import { runWorkshopTool } from './workshop-tool-api';
import kept from './account-records.json' with { type: 'json' };
import { APPROVAL_SQL, KEPT_NOTICE_SQL, approvalParams, autoOf, keptNoticeParams } from './door-grant.mjs';

/** The auto decision for one grant label, or null when the person must press Allow (or the check cannot be read). */
export async function autoDecisionFor(label: string) {
  try {
    const ran = await runWorkshopTool<{ rows: Record<string, unknown>[] }>(kept.tool, { credential_name: kept.credential_name, sql: APPROVAL_SQL, params: approvalParams(label) });
    return autoOf(ran.result?.rows ?? []);
  } catch {
    return null;
  }
}

/** Tells the owner, as one notice row, about a grant kept under auto-approve. A notice that cannot be written is not a failed keep. */
export async function tellKept(input: unknown, computer: string) {
  try {
    await runWorkshopTool(kept.tool, { credential_name: kept.credential_name, sql: KEPT_NOTICE_SQL, params: keptNoticeParams(input, computer) });
  } catch { /* the grant stands; the grants screen lists it */ }
}
