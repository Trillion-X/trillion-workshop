// src/workspace/door-grant-approval.ts
//
// PURPOSE
//   Reads the person's master auto-approve for door grants. The approvals place (the owner-places record's role named in
//   door-grant-approval.json) names the pursuit database that holds approval_setting and approval_decision, the approver
//   the check reads, and the two tables. The one statement APPROVAL_SQL (door-grant.mjs) is filled from that place and run
//   through the SQL tool with its connection; its answer rows say whether the grant is kept without a press (autoOf). Any
//   failure is an answer of "ask": the person presses Allow, never an automatic keep by mistake.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A failed or unreadable check, or a place that is missing or not usable, asks the person (returns null); it never keeps a grant.
//   2. The statement is the engine's rule shape (approval.rs CHECK_SQL); this file adds no second rule.
//   3. The approval tables are read only through the approvals place, never through the workspace's own records database.

import { runWorkshopTool, type Ran } from './workshop-tool-api.ts';
import kept from './account-records.json' with { type: 'json' };
import approval from './door-grant-approval.json' with { type: 'json' };
import { approvalCheckOf, autoOf, KEPT_NOTICE_SQL, keptNoticeParams } from './door-grant.mjs';

type Place = { credential_name: string; table: string; decision_table: string; approver: string };
/** One tool run; the key is the run's own idempotency key (the same key again is the same run). */
type Runner = <T>(tool: string, input: Record<string, unknown>, requestKey?: string) => Promise<Ran<T>>;

/** The approvals place from the owner-places record; null when the record has no approvals role. */
async function placeOf(run: Runner): Promise<Place | null> {
  const ran = await run<{ rows?: { value: string }[] }>(approval.tool, {
    credential_name: approval.roles.credential_name,
    sql: approval.roles.sql,
    params: [approval.roles.label],
    statement_timeout_ms: approval.statement_timeout_ms,
  });
  const value = ran.result?.rows?.[0]?.value;
  const roles = value ? (JSON.parse(value) as { roles?: Record<string, Place> }).roles ?? {} : {};
  return roles[approval.role] ?? null;
}

/** The auto decision for one grant label, or null when the person must press Allow (or the check cannot be read). */
export async function autoDecisionFor(label: string, run: Runner = runWorkshopTool) {
  try {
    const place = await placeOf(run);
    const check = place ? approvalCheckOf(place, label) : null;
    if (!place || !check) return null;
    const ran = await run<{ rows: Record<string, unknown>[] }>(approval.tool, {
      credential_name: place.credential_name,
      sql: check.sql,
      params: check.params,
      statement_timeout_ms: approval.statement_timeout_ms,
    });
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
