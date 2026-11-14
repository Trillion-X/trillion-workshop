// parts/ui/show/mention-picker/pick-mentions.ts
//
// PURPOSE
//   The one rule for what `@` shows (MentionPicker.tsx): the things whose name or line holds the typed words (or whose
//   kind's name starts with them), of the chosen kind or every kind, grouped by kind in the order kinds first appear,
//   and the kinds the words leave for the kind row. Zero DOM and zero React, so every rule here is testable on its own.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind: kinds and their names are the caller's DATA; a kind with no look matches by its key.
//   2. The rows answered are the rows drawn, in order, so a highlighted index always points at a drawn row.

/** Something that can be mentioned: a DATA kind, the thing's own id, its name and a line about it. */
export type MentionOption = { kind: string; value: string; label: string; detail?: string };
type KindNames = Readonly<Record<string, { label: string }>>;

const MOST_ALL = 12;
const MOST_ONE = 30;

const matches = (option: MentionOption, kinds: KindNames, sought: string) => !sought
  || `${option.label} ${option.detail ?? ''}`.toLocaleLowerCase().includes(sought)
  || (kinds[option.kind]?.label ?? option.kind).toLocaleLowerCase().startsWith(sought);

/** The kinds among the options the words leave, in the order they first appear: the choices of the kind row. */
export function mentionKindsAmong(candidates: readonly MentionOption[], kinds: KindNames, query: string): string[] {
  const sought = query.trim().toLocaleLowerCase();
  return [...new Set(candidates.filter(option => matches(option, kinds, sought)).map(option => option.kind))];
}

/** What shows for these words and this kind: grouped by kind in first-appearance order, the rows counted as drawn. */
export function pickMentions(candidates: readonly MentionOption[], kinds: KindNames, query: string, kind: string | null): MentionOption[] {
  const sought = query.trim().toLocaleLowerCase();
  const left = candidates.filter(option => (kind === null || option.kind === kind) && matches(option, kinds, sought)).slice(0, kind === null ? MOST_ALL : MOST_ONE);
  const order = [...new Set(left.map(option => option.kind))];
  return order.flatMap(one => left.filter(option => option.kind === one));
}

