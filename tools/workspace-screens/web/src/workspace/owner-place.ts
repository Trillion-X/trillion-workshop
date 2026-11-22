// src/workspace/owner-place.ts
//
// PURPOSE
//   The one reader of the owner-places record: the person's own workspace_records row that names where each role's data is
//   kept, {roles: {<role>: {credential_name, table, ...}}}. A screen names its role and gets that role's place back, or null
//   when the record has no such role. The label, the statement and the connection are DATA (owner-places.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every read is one tool run (tool:run-sql-in-my-database) with the owner's connection and statement_timeout_ms.
//   2. A record that cannot be read throws; a record with no such role answers null. The caller decides (ask, refuse).
//   3. Only owner-places.json names the record's label; test/owner-place.test.ts keeps it that way.

import { runWorkshopTool, type Ran } from './workshop-tool-api.ts';
import owner from './owner-places.json' with { type: 'json' };

/** One tool run; the key is the run's own idempotency key (the same key again is the same run). */
export type Runner = <T>(tool: string, input: Record<string, unknown>, requestKey?: string) => Promise<Ran<T>>;

/** The role's place from the owner-places record; null when the record has no such role. */
export async function ownerPlaceOf<Place>(role: string, run: Runner = runWorkshopTool): Promise<Place | null> {
  const ran = await run<{ rows?: { value: string }[] }>(owner.tool, {
    credential_name: owner.credential_name,
    sql: owner.sql,
    params: [owner.label],
    statement_timeout_ms: owner.statement_timeout_ms,
  });
  const value = ran.result?.rows?.[0]?.value;
  const roles = value ? (JSON.parse(value) as { roles?: Record<string, Place> }).roles ?? {} : {};
  return roles[role] ?? null;
}
