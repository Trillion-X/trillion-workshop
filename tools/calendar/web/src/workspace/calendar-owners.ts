// tools/calendar/web/src/workspace/calendar-owners.ts
//
// PURPOSE
//   The Calendar screen's reads from the person's own owners, called from the screen's own code (no /work/api route):
//   their calendar accounts and events through their connected accounts and the calendar events tool, and their Gmail
//   accounts for the Mail panel through the same accounts tool, as calendar-owners.json says (no owner of their own
//   timed tasks is named yet, so that list is empty). Answers in the
//   shapes the screen already draws
//   (calendar-screen-core.ts Item, SourceState, Task; CalendarControls CalendarAccount).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a person, an account, a provider or a table: calendar-owners.json and the answers do.
//   2. Reading only. A write the screen asks for still goes where it went, and says it could not when nobody answers.
//   3. One account that cannot be read never hides the others: its source stays, unread, with its own words.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { runWorkshopTool } from '../../../../workspace-screens/web/src/workspace/workshop-tool-api';
import type { Item, SourceState, Task } from './calendar-screen-core';
import type { CalendarAccount } from './calendar-controls';
import { pass } from '../../../../workspace-screens/web/src/workspace/account-pass';
import owners from './calendar-owners.json';
import { createTaskQuery, personOfToken, personTasksQuery, taskOfRow } from './calendar-task-rows.mjs';
import type { TaskOwner, TaskQuery } from './calendar-task-rows.d.mts';

type Account = { id: string; user_id: string | null; toolkit: string | null; alias: string | null; status: string | null };
type Block = { id: string; interval?: { start?: string; end?: string; allDay?: boolean }; display?: { title?: string }; relations?: { linkedRecord?: string[] } };

const accountsRead = new Map<string, Promise<Account[]>>();
/** The person's working accounts of one Composio toolkit, read once per page and again after a failed read. */
function workingAccounts(toolkit: string): Promise<Account[]> {
  if (!accountsRead.has(toolkit)) accountsRead.set(toolkit, runWorkshopTool<{ accounts?: Account[] }>(owners.accounts_tool, { toolkit }).then(ran => {
    if (!Array.isArray(ran.result?.accounts)) throw new Error('');
    return ran.result.accounts.filter(account => account.status === owners.working_status);
  }, error => { accountsRead.delete(toolkit); throw error; }));
  return accountsRead.get(toolkit)!;
}
/** The person's working calendar accounts. */
const calendarAccounts = () => workingAccounts(owners.accounts_toolkit);

const sourceOf = (account: Account) => `${owners.provider}:${account.id}`;
const labelOf = (account: Account) => account.alias ?? account.id;

/** The events of every working account over [from, to), with one source per account. */
export async function readCalendar(from: string, to: string): Promise<{ from: string; to: string; items: Item[]; sources: SourceState[] }> {
  const accounts = await calendarAccounts();
  const reads = await Promise.allSettled(accounts.map(account => runWorkshopTool<{ blocks?: Block[] }>(owners.events_tool, {
    provider: owners.provider, connection: { connection_id: account.id, ...(account.user_id ? { user_id: account.user_id } : {}) },
    range_start: from, range_end: to, max_results: owners.most_events,
  })));
  const items: Item[] = [];
  const sources: SourceState[] = accounts.map((account, at) => {
    const read = reads[at]!;
    const source = sourceOf(account);
    if (read.status === 'rejected') return { id: source, label: labelOf(account), read: false, connected: true, said: read.reason instanceof Error ? read.reason.message : '' };
    for (const block of read.value.result?.blocks ?? []) {
      const start = block.interval?.start;
      if (!start) continue;
      items.push({
        id: `${source}:${block.id}`, source, source_id: block.id, title: block.display?.title ?? '', about: null,
        starts_at: start, ends_at: block.interval?.end ?? null, all_day: block.interval?.allDay === true,
        space_id: null, space_title: null, going: null, may_move: false, status: null, link: block.relations?.linkedRecord?.[0] ?? null,
      });
    }
    return { id: source, label: labelOf(account), read: true, connected: true, complete: true, writable: false };
  });
  return { from, to, items, sources };
}

/** The person's calendar accounts as the calendar choice lists them (one main calendar each, read only). */
export async function readCalendarAccounts(): Promise<{ accounts: CalendarAccount[]; selections: null }> {
  const accounts = await calendarAccounts();
  return { accounts: accounts.map(account => ({ source_id: sourceOf(account), connection_id: account.id, connected_at: '', account_label: labelOf(account), calendars: [{ id: 'primary', summary: labelOf(account), primary: true, writable: false }] })), selections: null };
}

const tasksOwner = owners.tasks as TaskOwner;

/** One statement on the task owner's table, through the SQL tool with its timeout. */
async function runTaskSql(query: TaskQuery): Promise<Record<string, unknown>[]> {
  const ran = await runWorkshopTool<{ rows?: Record<string, unknown>[] }>(tasksOwner.tool, { database: tasksOwner.database, sql: query.sql, params: query.params, statement_timeout_ms: tasksOwner.statement_timeout_ms });
  return ran.result?.rows ?? [];
}

/** The signed-in person's id: the subject of his pass. Null when the pass names none, so nothing is read for him. */
const signedInPerson = async (): Promise<string | null> => personOfToken(await pass());

/** The person's open tasks: the rows that name him as an assignee or that he sent, newest first, at most `most_tasks`.
 *  No signed-in id answers the empty list, said as complete. */
export async function readCalendarTasks(): Promise<{ tasks: Task[]; page: { complete: boolean; next_cursor: null }; collections: []; collections_page: { complete: boolean; next_cursor: null } }> {
  const person = await signedInPerson();
  const rows = person ? await runTaskSql(personTasksQuery(tasksOwner, person)) : [];
  return {
    tasks: rows.map(row => taskOfRow(row, tasksOwner) as Task),
    page: { complete: rows.length < tasksOwner.most_tasks, next_cursor: null },
    collections: [], collections_page: { complete: true, next_cursor: null },
  };
}

/** A task the person typed: written sent by him and assigned to him, so the list shows it at once. */
export async function createCalendarTask(input: { title: string; duration_minutes?: number; collection_id?: string | null; smart_list?: string | null }): Promise<{ task: Task }> {
  const person = await signedInPerson();
  if (!person) throw new Error(tasksOwner.signed_out);
  const id = `record:calendar-task:${crypto.randomUUID()}`;
  const [row] = await runTaskSql(createTaskQuery(tasksOwner, person, input, id, new Date().toISOString()));
  if (!row) throw new Error(tasksOwner.not_kept);
  return { task: taskOfRow(row, tasksOwner) as Task };
}

/** A mail account the Mail screen can open: its Composio connection, and the user id Composio asks with it. */
export type CalendarMailAccount = { connection_id: string; connected_at: string; account_label: string; status: string; can_send: boolean; provider: string; user_id: string | null };

/** The person's Gmail accounts through Composio, as the Mail screen opens them (read only). */
export async function readCalendarMailAccounts(): Promise<CalendarMailAccount[]> {
  const accounts = await workingAccounts(owners.mail_toolkit);
  return accounts.map(account => ({ connection_id: account.id, connected_at: '', account_label: labelOf(account), status: 'connected', can_send: true, provider: owners.mail_provider, user_id: account.user_id }));
}

/** Runs one mail tool as this Composio account, on its provider; the connection carries the user id Composio asks with it. */
export const runCalendarMail = (account: CalendarMailAccount, toolId: string, input: Record<string, unknown>, requestKey?: string) =>
  runWorkshopTool(toolId, { ...input, provider: account.provider, connection: { connection_id: account.connection_id, ...(account.user_id ? { user_id: account.user_id } : {}) } }, requestKey);
