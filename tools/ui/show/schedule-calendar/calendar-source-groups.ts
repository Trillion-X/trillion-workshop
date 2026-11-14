// parts/ui/show/schedule-calendar/calendar-source-groups.ts
//
// PURPOSE
//   The one grouping of writable calendars by the account they belong to, as the default-calendar choice and the calendar
//   choice inside an event form both list them: one group per account (headed by its label), each calendar named as its
//   account names it. A calendar whose account is not known is listed in a group with no heading. A calendar the caller
//   says cannot be chosen (`isDisabled`, a read-only one) is still listed, marked disabled.

import type { CalendarAccount, CalendarControlSource } from './CalendarControls';

export type CalendarSourceGroup = { label?: string; choices: { source: CalendarControlSource; label: string; disabled: boolean }[] };

export function groupSourcesByAccount(sources: readonly CalendarControlSource[], accounts: readonly CalendarAccount[] | undefined, isDisabled: (source: CalendarControlSource) => boolean = () => false): Map<string, CalendarSourceGroup> {
  const groups = new Map<string, CalendarSourceGroup>();
  for (const source of sources) {
    const selection = source.selection;
    const account = selection && accounts?.find(row => row.source_id === selection.source_id
      && row.connection_id === selection.connection_id && row.connected_at === selection.connected_at);
    const key = account ? JSON.stringify([account.source_id, account.connection_id, account.connected_at]) : '';
    const group = groups.get(key) ?? { label: account?.account_label, choices: [] };
    group.choices.push({ source, label: account?.calendars.find(row => row.id === selection?.calendar_id)?.summary ?? source.label, disabled: isDisabled(source) });
    groups.set(key, group);
  }
  return groups;
}
