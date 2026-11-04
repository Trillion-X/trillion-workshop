// parts/ui/show/record-picker/record-value.ts
//
// PURPOSE
//   What a `record` form field holds and how it travels: the field's descriptor (where its rows come from, where a new
//   one is made, which card field carries suggestions), the row it chose ({ id, title, list_id }) and the one text form
//   that row takes inside a form's string values (HoverFormBody keeps every value as text). Zero DOM and zero React.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a list, a row type or a kind of person: `from`, `new` and `suggest` are the caller's DATA.
//   2. A chosen row is stored as JSON text `{"id","title","list_id"}`; plain words in the same place (an older answer, a
//      field that only asks for a name) read as a title with no row, never as an error.
//   3. `recordPart` is the one reading of a value for a run: the title by default (a tool that takes a plain name), or
//      `id` / `list_id` when the run says which part it reads.
//   4. A card's suggestions come best first, so its best guess is the first that is a row (`bestGuess`): the picker
//      chooses it before the person does anything, and they change it with Remove or by choosing another. A suggestion
//      that is only words is never chosen for them; it is offered first when they search.

/** Where a record field's rows come from: lists by id, the row types whose lists are searched, and/or what the lists hold
 *  (`holds`: a name the lists owner defines, e.g. every list that holds people, whatever it is called). */
export type RecordFrom = { lists?: string[]; row_types?: string[]; holds?: string };
/** Where a row the person types is made when none matches: the list (made once if missing), its words for one row. */
export type RecordNew = { list: string; label?: string; list_label?: string; title_field?: string };
/** A row the picker offers or has chosen. */
export type RecordHit = { id: string; list_id: string; list_label: string; title: string; detail?: string };
/** A row a card suggests, with why. `id` and `list_id` are given when the suggestion is a row that exists. */
export type RecordSuggestion = { id?: string; list_id?: string; title: string; why?: string };
/** The chosen row as a form value. */
export type RecordValue = { id: string; title: string; list_id: string };

/** The form value of a chosen row. */
export const encodeRecord = (row: RecordValue): string => JSON.stringify({ id: row.id, title: row.title, list_id: row.list_id });

/** The row a form value holds; null for empty text or plain words. */
export function parseRecord(value: unknown): RecordValue | null {
  if (typeof value !== 'string' || !value.startsWith('{')) return null;
  try {
    const row = JSON.parse(value) as Record<string, unknown>;
    return typeof row.id === 'string' && row.id && typeof row.title === 'string' && row.title && typeof row.list_id === 'string'
      ? { id: row.id, title: row.title, list_id: row.list_id } : null;
  } catch { return null; }
}

/** The words of a value: a chosen row's title, else the plain words as they are. */
export const recordText = (value: unknown): string => parseRecord(value)?.title ?? (typeof value === 'string' ? value : '');

/** One part of a value for a run: `title` (the default), `id` or `list_id`; a plain-words value has only a title. */
export function recordPart(value: unknown, part: 'id' | 'title' | 'list_id' = 'title'): string | undefined {
  const row = parseRecord(value);
  if (row) return row[part];
  return part === 'title' && typeof value === 'string' && value.trim() ? value : undefined;
}

/** Suggestions held by a card field (an array of { id?, title, why? }, or its JSON text), the ones that are well formed. */
export function suggestionsIn(raw: unknown): RecordSuggestion[] {
  let list: unknown = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  return list.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const { id, list_id: listId, title, why } = item as Record<string, unknown>;
    if (typeof title !== 'string' || !title.trim()) return [];
    return [{ title: title.trim(), ...(typeof id === 'string' && id ? { id } : {}), ...(typeof listId === 'string' && listId ? { list_id: listId } : {}), ...(typeof why === 'string' && why.trim() ? { why: why.trim() } : {}) }];
  });
}

/** The best guess among a card's suggestions (invariant 4): the first, since whoever computes them puts the best first. */
export const bestGuess = (suggestions: readonly RecordSuggestion[]): RecordSuggestion | null => suggestions.find(item => item.id && item.list_id) ?? null;

/** Whether a field descriptor's `from` and `new` are well formed (names of lists and types, never empty both ways). */
export function validRecordField(field: { from?: unknown; new?: unknown; suggest?: unknown }): boolean {
  const names = (value: unknown) => value === undefined || (Array.isArray(value) && value.length <= 25 && value.every(item => typeof item === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(item)));
  const from = field.from as Record<string, unknown> | undefined;
  const holds = from?.holds === undefined || (typeof from.holds === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(from.holds));
  if (!from || typeof from !== 'object' || Array.isArray(from) || !names(from.lists) || !names(from.row_types) || !holds || (!(Array.isArray(from.lists) && from.lists.length) && !(Array.isArray(from.row_types) && from.row_types.length) && from.holds === undefined)) return false;
  if (field.new !== undefined) {
    const made = field.new as Record<string, unknown>;
    if (!made || typeof made !== 'object' || typeof made.list !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(made.list)) return false;
    if ([made.label, made.list_label, made.title_field].some(text => text !== undefined && (typeof text !== 'string' || !text.trim()))) return false;
  }
  return field.suggest === undefined || (typeof field.suggest === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(field.suggest));
}

/** The source a record field reads and writes through, handed in by the screen (like a file field's source). */
export type RecordSource = {
  search: (query: string, from: RecordFrom, limit?: number) => Promise<RecordHit[]>;
  create: (made: RecordNew, title: string) => Promise<RecordHit>;
};
