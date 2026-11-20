// tools/calendar/web/src/workspace/calendar-owners.ts
//
// PURPOSE
//   The Calendar screen's reads from the person's own owners, called from the screen's own code (no /work/api route):
//   their calendar accounts and events through their connected accounts and the calendar events tool, as
//   calendar-owners.json says (no owner of their own timed tasks is named yet, so that list is empty). Answers in the
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
import owners from './calendar-owners.json';

type Account = { id: string; user_id: string | null; toolkit: string | null; alias: string | null; status: string | null };
type Block = { id: string; interval?: { start?: string; end?: string; allDay?: boolean }; display?: { title?: string }; relations?: { linkedRecord?: string[] } };

let accountsRead: Promise<Account[]> | null = null;
/** The person's working calendar accounts, read once per page and again after a failed read. */
function calendarAccounts(): Promise<Account[]> {
  accountsRead ??= runWorkshopTool<{ accounts?: Account[] }>(owners.accounts_tool, { toolkit: owners.accounts_toolkit }).then(ran => {
    if (!Array.isArray(ran.result?.accounts)) throw new Error('');
    return ran.result.accounts.filter(account => account.status === owners.working_status);
  }, error => { accountsRead = null; throw error; });
  return accountsRead;
}

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

/** The person's timed tasks. No owner of them is named yet (calendar-owners.json), so the list is empty, said as
 *  complete, never a failure. */
export async function readCalendarTasks(): Promise<{ tasks: Task[]; page: { complete: boolean; next_cursor: null }; collections: []; collections_page: { complete: boolean; next_cursor: null } }> {
  return { tasks: [], page: { complete: true, next_cursor: null }, collections: [], collections_page: { complete: true, next_cursor: null } };
}
