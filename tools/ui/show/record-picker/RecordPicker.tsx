// parts/ui/show/record-picker/RecordPicker.tsx
//
// PURPOSE
//   The one box for a field that means a row that exists (a person, a customer, a place), instead of a box of free
//   words: search the person's lists as they type, the card's own suggestions first with why they are suggested, the
//   rows found grouped by the list they live in under a row of lists that narrows to one, sorted by best match or by
//   name, and, when nothing is the one they mean, a `New <label> "typed"` row that makes that row in the list the field
//   names and chooses it. What is chosen is shown as the shared record chip with a Remove press. Built on the shared
//   mention picker (grouping, list row, keyboard rows) and the shared record chip; it adds only the search, the states
//   and the new row. Used by the shared form body (record-views/hover-form.tsx, so the Waiting on you cards, the hold
//   and any form), the guide's form and a list's link cell.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a list, a kind of row or a person: `from`, `made`, the suggestions and every word are the
//      caller's DATA (`words` has plain defaults), and a row's list label comes with the row.
//   2. Loading, failed (with Try again) and genuinely empty are three different drawings, never one blank list.
//   3. Keyboard: Arrow keys move through the drawn rows (the new row last), Enter chooses, Escape closes the list only;
//      every row is a real press, so touch works the same. Pressing in the list never moves focus off the box.
//   4. Without a source the field is a plain words box, so a screen that has no lists still lets the person answer.
//   5. The value is the chosen row as text (record-value.ts); removing it empties the value.
//   6. Appearance belongs to screen-look (`record-picker*` classes); no colour or size is chosen here.
//   7. The best guess is preselected: when the field is empty, the card's first suggestion that is a row
//      (record-value.ts `bestGuess`) is chosen before the person does anything. A suggestion that is only words is never
//      chosen for them; it comes first when they search. It happens once per field; anything the person types, chooses
//      or removes is never undone by it.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';

import { Button } from '../button';
import { Container } from '../container';
import { Input } from '../coss/ui/input';
import { NamedIcon } from '../icon';
import { MentionPicker, pickMentions, type MentionOption } from '../mention-picker';
import { RecordChip } from '../record-chip';
import { Text } from '../text';
import { hitOf, pickRecords, type PickSort } from './pick-records';
import { bestGuess, encodeRecord, parseRecord, type RecordFrom, type RecordHit, type RecordNew, type RecordSource, type RecordSuggestion } from 'trillion-workshop/tools/ui/show/record-picker/record-value.ts';

export type RecordPickerWords = {
  suggested: string; searching: string; failed: string; retry: string; empty: string; best: string; byName: string;
  remove: string; making: string; makeFailed: string; newRow: string; sortBy: string;
};
export const recordPickerWords: RecordPickerWords = {
  suggested: 'Suggested', searching: 'Searching…', failed: 'Could not search. Nothing was changed.', retry: 'Try again', empty: 'Nothing found yet.',
  best: 'Best match', byName: 'Name', remove: 'Remove', making: 'Adding…', makeFailed: 'Could not add it.', newRow: 'New {label} "{typed}"', sortBy: 'Sort by',
};

export type RecordPickerProps = {
  name: string;
  label: string;
  placeholder?: string;
  from: RecordFrom;
  /** Where a row that is not found is made; without it no new row is offered. */
  made?: RecordNew;
  suggestions?: readonly RecordSuggestion[];
  /** The form value: the chosen row as text, or empty. */
  value: string;
  onChange: (value: string) => void;
  source?: RecordSource;
  autoFocus?: boolean;
  invalid?: boolean;
  /** The named icon of a list's group and of the chosen chip. */
  icon?: string;
  words?: Partial<RecordPickerWords>;
};

const hold = (event: React.MouseEvent) => event.preventDefault();
const SEARCH_MOST = 30;
const DELAY = 180;

type Found = { status: 'loading' | 'ready' | 'failed'; rows: RecordHit[] };

export function RecordPicker({ name, label, placeholder, from, made, suggestions = [], value, onChange, source, autoFocus, invalid, icon = 'List', words: given }: RecordPickerProps) {
  const said = { ...recordPickerWords, ...given };
  const selected = parseRecord(value);
  const [editing, setEditing] = React.useState(false);
  const chosen = editing ? null : selected;
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [found, setFound] = React.useState<Found>({ status: 'loading', rows: [] });
  const [kind, setKind] = React.useState<string | null>(null);
  const [sort, setSort] = React.useState<PickSort>('best');
  const [highlighted, setHighlighted] = React.useState(0);
  const [making, setMaking] = React.useState<{ status: 'making' | 'failed'; title: string } | null>(null);
  const [tries, setTries] = React.useState(0);
  const creating = React.useRef(false);
  const input = React.useRef<HTMLInputElement | null>(null);
  const listId = React.useId();
  const removeButton = React.useRef<HTMLButtonElement | null>(null);
  const keepFocus = React.useRef(false);
  // The box that had focus becomes the chip; focus moves to its Remove press so it is never dropped onto the page behind.
  React.useEffect(() => { if (chosen && keepFocus.current) { keepFocus.current = false; removeButton.current?.focus(); } }, [chosen?.id]);
  // The best guess, chosen once before the person does anything (invariant 7); `touched` is anything they did.
  const touched = React.useRef(false);
  const guessed = React.useRef(false);
  React.useEffect(() => {
    const best = bestGuess(suggestions);
    if (guessed.current || touched.current || !source || value || !best) return;
    guessed.current = true;
    onChange(encodeRecord({ id: best.id as string, list_id: best.list_id as string, title: best.title }));
  }, [source, suggestions, value]);

  React.useEffect(() => {
    if (!open || !source) return undefined;
    let current = true;
    setFound(before => ({ status: 'loading', rows: before.rows }));
    const timer = window.setTimeout(() => {
      source.search(query.trim(), from, SEARCH_MOST)
        .then(rows => { if (current) setFound({ status: 'ready', rows }); })
        .catch(() => { if (current) setFound({ status: 'failed', rows: [] }); });
    }, query.trim() ? DELAY : 0);
    return () => { current = false; window.clearTimeout(timer); };
    // `from` is data that does not change while a field is drawn; its text stands for it.
  }, [open, query, tries, source, JSON.stringify(from)]);

  const picked = React.useMemo(() => pickRecords(found.rows, suggestions, query, sort, said.suggested, icon), [found.rows, suggestions, query, sort, said.suggested, icon]);
  const shown = React.useMemo(() => pickMentions(picked.options, picked.kinds, '', kind), [picked, kind]);
  const typed = query.trim();
  const exact = found.rows.some(row => row.title.toLocaleLowerCase() === typed.toLocaleLowerCase());
  const canMake = Boolean(made && typed && !exact);
  const total = shown.length + (canMake ? 1 : 0);
  React.useEffect(() => { setHighlighted(0); }, [query, kind, sort]);

  const close = () => { setOpen(false); setQuery(''); setKind(null); setEditing(false); };
  const edit = () => { touched.current = true; setEditing(true); setOpen(true); setQuery(''); window.setTimeout(() => input.current?.focus(), 0); };
  const choose = (row: { id: string; list_id: string; title: string }) => { touched.current = true; keepFocus.current = document.activeElement === input.current; onChange(encodeRecord(row)); close(); };
  const make = async (title: string) => {
    if (!source || !made || creating.current) return;
    creating.current = true;
    setMaking({ status: 'making', title });
    try {
      const row = await source.create(made, title);
      setMaking(null);
      choose(row);
    } catch { setMaking({ status: 'failed', title }); }
    finally { creating.current = false; }
  };
  const pick = (option: MentionOption) => {
    const hit = hitOf(option, found.rows);
    if (!hit) return;
    if (hit.id && hit.list_id) { choose({ id: hit.id, list_id: hit.list_id, title: hit.title }); return; }
    // A suggestion that is not a row yet becomes one where the field makes new rows, else it stays the words it is.
    if (made) void make(hit.title); else { touched.current = true; onChange(hit.title); close(); }
  };

  if (!source) {
    return <Input autoFocus={autoFocus} name={name} placeholder={placeholder} value={chosen?.title ?? value} aria-invalid={invalid ? true : undefined} onChange={event => onChange(event.currentTarget.value)} />;
  }
  if (chosen) {
    return (
      <Container layout="horizontal" gap="xs" alignItems="center" className="record-picker-chosen" data-slot="record-picker" data-state="chosen">
        <RecordChip kind={chosen.list_id} value={chosen.id} label={chosen.title} icon={icon} onOpen={edit} />
        <Button ref={removeButton} type="button" variant="ghost" size="icon-xs" className="record-picker-remove" aria-label={`${said.remove} ${chosen.title}`}
          onClick={() => { touched.current = true; onChange(''); setEditing(true); setOpen(true); window.setTimeout(() => input.current?.focus(), 0); }}>
          <NamedIcon name="X" size="xs" aria-hidden="true" />
        </Button>
      </Container>
    );
  }
  const status = found.status === 'failed' ? 'failed' : picked.options.length === 0 ? (found.status === 'loading' ? 'loading' : 'empty') : 'ready';
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      if (total) setHighlighted(at => (event.key === 'ArrowDown' ? (at + 1) % total : (at - 1 + total) % total));
    } else if (event.key === 'Enter' && open && total) {
      // Enter chooses the highlighted row; it never also sends the form.
      event.preventDefault();
      event.stopPropagation();
      if (highlighted < shown.length) pick(shown[highlighted]); else void make(typed);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  return (
    <Container layout="vertical" gap="xs" className="record-picker" data-slot="record-picker" data-state={open ? 'open' : 'closed'}
      onBlur={(event: React.FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(); }}>
      <Input ref={input} autoFocus={autoFocus} name={name} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={label}
        autoComplete="off" placeholder={placeholder} value={query} aria-invalid={invalid ? true : undefined}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
        onChange={event => { touched.current = true; setQuery(event.currentTarget.value); setOpen(true); }} onKeyDown={onKeyDown} />
      {open ? (
        <Container layout="vertical" gap="xs" className="record-picker-panel" data-state={status}>
          {picked.options.length > 1 ? (
            <Container layout="horizontal" gap="xs" alignItems="center" role="toolbar" aria-label={said.sortBy} className="record-picker-sort">
              <Text variant="caption" color="faint">{said.sortBy}</Text>
              <Button type="button" variant="ghost" size="xs" active={sort === 'best'} onMouseDown={hold} onClick={() => setSort('best')}>{said.best}</Button>
              <Button type="button" variant="ghost" size="xs" active={sort === 'name'} onMouseDown={hold} onClick={() => setSort('name')}>{said.byName}</Button>
            </Container>
          ) : null}
          {picked.options.length > 0 ? (
            <MentionPicker candidates={picked.options} kinds={picked.kinds} query="" kind={kind} onKindChange={setKind}
              highlighted={highlighted} onHighlight={setHighlighted} onChoose={pick} label={label} id={listId} allLabel="All" />
          ) : null}
          {status === 'loading' || (found.status === 'loading' && picked.options.length > 0)
            ? <Text variant="caption" color="muted" role="status" className="record-picker-note" data-state="loading">{said.searching}</Text> : null}
          {status === 'failed' ? (
            <Container layout="horizontal" gap="xs" alignItems="center" className="record-picker-note" data-state="failed">
              <Text variant="caption" role="alert">{said.failed}</Text>
              <Button type="button" size="xs" variant="outline" onMouseDown={hold} onClick={() => setTries(count => count + 1)}>{said.retry}</Button>
            </Container>
          ) : null}
          {status === 'empty' ? <Text variant="caption" color="muted" className="record-picker-note" data-state="empty">{said.empty}</Text> : null}
          {canMake && made ? (
            <Button type="button" role="option" aria-selected={highlighted === shown.length} data-new="true" variant={highlighted === shown.length ? 'secondary' : 'ghost'} size="sm"
              className="record-picker-new" disabled={making?.status === 'making'} onMouseDown={hold} onMouseEnter={() => setHighlighted(shown.length)} onClick={() => make(typed)}>
              <NamedIcon name="Plus" size="xs" aria-hidden="true" />
              <Text variant="body" weight="semibold" truncate>{said.newRow.replace('{label}', made.label ?? '').replace('{typed}', typed).replace('  ', ' ')}</Text>
            </Button>
          ) : null}
          {making ? (
            making.status === 'making'
              ? <Text variant="caption" color="muted" role="status" className="record-picker-note" data-state="making">{said.making}</Text>
              : (
                <Container layout="horizontal" gap="xs" alignItems="center" className="record-picker-note" data-state="make-failed">
                  <Text variant="caption" role="alert">{said.makeFailed}</Text>
                  <Button type="button" size="xs" variant="outline" onMouseDown={hold} onClick={() => make(making.title)}>{said.retry}</Button>
                </Container>
              )
          ) : null}
        </Container>
      ) : null}
    </Container>
  );
}
