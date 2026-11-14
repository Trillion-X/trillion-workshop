// parts/ui/show/record-picker/pick-records.ts
//
// PURPOSE
//   The one rule for what a record picker lists: the card's suggestions first (with their why), then the rows found,
//   without a row twice, grouped by the list they came from, sorted best match (the order found) or by name; each
//   shaped as the MentionOption the shared picker draws, one "kind" per source list. Zero DOM, zero React.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing names a list: each row's list id and label come with the row.
//   2. A suggestion a typed query does not match is left out; a suggestion that is a row found is drawn once, as the
//      suggestion, with its why.
//   3. The rows answered are the rows the picker highlights, in order.

import type { MentionOption } from '../mention-picker';
import type { RecordChipKinds } from '../record-chip';
import type { RecordHit, RecordSuggestion } from 'trillion-workshop/tools/ui/show/record-picker/record-value.ts';

export const SUGGESTED = 'suggested';
export type PickSort = 'best' | 'name';

const norm = (text: string) => text.toLocaleLowerCase();

/** The options to draw, and the kinds' looks (the suggested group and one per list found). */
export function pickRecords(found: readonly RecordHit[], suggestions: readonly RecordSuggestion[], query: string, sort: PickSort, suggestedLabel: string, listIcon: string) {
  const sought = norm(query.trim());
  // A suggestion that is only words but names a row already found (the same title) is that row: choosing it chooses
  // the row, never a second one made beside it.
  const shown = suggestions.filter(item => !sought || norm(`${item.title} ${item.why ?? ''}`).includes(sought)).map(item => {
    const same = item.id ? null : found.find(row => norm(row.title) === norm(item.title));
    return same ? { ...item, id: same.id, list_id: same.list_id } : item;
  });
  const taken = new Set(shown.filter(item => item.id).map(item => `${item.list_id ?? ''}:${item.id}`));
  const rows = found.filter(row => !taken.has(`${row.list_id}:${row.id}`) && !shown.some(item => item.id === row.id && !item.list_id));
  const byName = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
  const suggested: MentionOption[] = shown.map(item => ({ kind: SUGGESTED, value: `${item.list_id ?? ''}\u0000${item.id ?? ''}\u0000${item.title}`, label: item.title, ...(item.why ? { detail: item.why } : {}) }));
  const lists = [...new Set(rows.map(row => row.list_id))];
  const found_: MentionOption[] = lists.flatMap(list => {
    const mine = rows.filter(row => row.list_id === list).map(row => ({ kind: list, value: row.id, label: row.title, ...(row.detail ? { detail: row.detail } : {}) }));
    return sort === 'name' ? mine.sort(byName) : mine;
  });
  const kinds: Record<string, RecordChipKinds[string]> = { [SUGGESTED]: { label: suggestedLabel, icon: 'Sparkles', colour: 'accent' } };
  for (const row of rows) kinds[row.list_id] ??= { label: row.list_label, icon: listIcon, colour: 'neutral' };
  return { options: [...suggested, ...found_], kinds: kinds as RecordChipKinds };
}

/** The row an option stands for: a found row, or a suggestion (its own id and list when it has them, else its words). */
export function hitOf(option: MentionOption, found: readonly RecordHit[]): { id?: string; list_id?: string; title: string } | null {
  if (option.kind === SUGGESTED) {
    const [list, id, title] = option.value.split('\u0000');
    return { title, ...(id ? { id } : {}), ...(list ? { list_id: list } : {}) };
  }
  const row = found.find(item => item.list_id === option.kind && item.id === option.value);
  return row ? { id: row.id, list_id: row.list_id, title: row.title } : null;
}
