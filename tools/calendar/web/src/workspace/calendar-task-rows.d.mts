// tools/calendar/web/src/workspace/calendar-task-rows.d.mts
//
// The types of calendar-task-rows.mjs (its invariants are there).

export type TaskOwner = {
  table: string;
  statement_timeout_ms: number;
  most_tasks: number;
  hidden_statuses: string[];
  default_status: string;
  new_status: string;
  default_minutes: number;
  columns: Record<string, string>;
};

export type TaskQuery = { sql: string; params: unknown[] };

export function personOfToken(token: string | null | undefined): string | null;
export function personTasksQuery(owner: TaskOwner, person: string): TaskQuery;
export function createTaskQuery(owner: TaskOwner, person: string, input: { title: string; duration_minutes?: number; collection_id?: string | null; smart_list?: string | null }, id: string, nowIso: string): TaskQuery;
export function taskOfRow(row: Record<string, unknown>, owner: TaskOwner): Record<string, unknown>;
