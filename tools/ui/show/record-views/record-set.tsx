// parts/ui/show/record-views/record-set.tsx
//
// PURPOSE
//   One record set on the shared record views, drawn from the set's own DATA: the store answers
//   `{ view, items, ...rest }` and `view` says the list's label, its columns (field rows), its empty and no-match words,
//   which view it starts in, and how an opened record is drawn beside the list (open-views.tsx, picked per record by
//   its kind row's view id, reading the record through named roles). Every view the shared record views offer is
//   offered for every set. A new list, a new column or a new kind of record is DATA; nothing here names a list.
//   Look of the list and the opened record beside it: Klaviyo's sent messages list (what, to whom, when;
//   mobbin.com/screens/91170fd3-3639-4506-89bd-1b5c7fcbcab1), Plain's list and reading pane side by side
//   (mobbin.com/screens/6b03543c-d8bd-403c-a3eb-3c43783a0a23) and 21st.dev Notification Panel 27135 (a feed filtered by
//   kind).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the answer's records are drawn; nothing is invented when a field is missing.
//   2. A field row reads the record at its `path` (default its id); a list value reads as its items joined; a field
//      whose `kind` has a reader in VALUE_READERS (dates, money) is read through it; `values_from` takes a tag's labels and
//      icons from rows elsewhere in the answer. No field id is named here.
//   3. The opened record's view is chosen by DATA and drawn by the registry; an unknown view id draws the fallback.
//   4. Every element is a shared part (RecordViews, Container, Text, Button, the open views); no markup is written here.
//   5. An action is the set's DATA (`view.actions`, visual-database's own action rows): one that names a field is a
//      button beside that column's value and receives the value, one that names none is a row in each record's menu.
//      What it runs is its target, answered by the page; nothing here names one. The record itself goes with it, so its
//      `copy` reads any of the record's own values as `record.payload.<path>`.
//   6. A field row with `derive` is computed: its target (the formula engine, or anything the page answers) is asked
//      once per record with the values of the fields it names, and the column shows what it answered.
//   7. Charts are the set's DATA too (`view.charts`, chart placements over the answer), drawn above the list; the list
//      keeps its own height under them and the two scroll together.

import React from 'react';
import { Button } from '../button';
import { notify } from '../coss/notifications';
import { Container } from '../container';
import { Text } from '../text';
import { relativeWhen } from '../relative-time/relative-time';
import { useNarrowViewport } from '../use-narrow-viewport/useNarrowViewport';
import { RecordViews, type FieldDescriptor, type RecordViewsOptions } from './record-views';
import type { GroupLevel } from './group-sections';
import { emptyGroup, type RuleGroup } from '../rule-filter/rule-tree';
import { METRIC_REDUCERS } from 'trillion-workshop/tools/keep-lists-of-rows/read-data/metric-aggregation.ts';
import { ChartsOver } from '../chart/ChartPlacement';
import type { ChartPlacement } from '../chart/chart-types';
import { openViewFor } from './open-views';
import { sendRequestToBitfieldTarget } from '#workspace-records';
import { recordActionsFromRows, runRecordAction } from 'trillion-workshop/tools/keep-lists-of-rows/do-work/run-record-action.ts';
import type { VisualDatabaseActionDescriptor } from 'trillion-workshop/tools/keep-lists-of-rows/read-data/visual-database.ts';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
import { HoverFormCell, type HoverForm } from './hover-form';
type Path = string[];
/** One column, as DATA. */
export type RecordSetField = {
  id: string; label: string; icon?: string; path?: Path; kind?: string; rule_kind?: string; width?: number;
  filterable?: boolean; groupable?: boolean; sortable?: boolean; hidden_by_default?: boolean; preview?: boolean;
  /** The tag's label and icon per value, from rows elsewhere in the answer (each row's `id` is the value). */
  values_from?: { path: Path; label?: string; icon?: string };
  /** A computed column: `target` is asked with `request` plus `context` (the values of `context_from_fields`, by id),
   *  and the value at `result_path` of its answer is the column's value (visual-database's derive shape). */
  derive?: { target: string; request?: Record<string, unknown>; context_from_fields?: string[]; result_path?: Path };
  /** Each group's heading adds up this field over the group's records with this reducer (visual-database
   *  metric-aggregation METRIC_REDUCERS: sum, average, min, max, count), so a grouped list compares its groups. */
  total?: string;
};
/** How an opened record is drawn, as DATA. */
export type RecordSetOpen = {
  kinds?: Path; kind_field?: Path; view_field?: string; label_field?: string; fallback_view?: string;
  link?: Path; link_words?: string;
  caption?: { path: Path; words: string }[];
  roles?: Record<string, Path[]>;
};
/** The record set's own description, carried in the store's answer. */
export type RecordSetView = {
  label: string; preference_key: string; first_view?: { wide?: string; narrow?: string };
  loading?: string; empty?: { icon?: string; title: string; description?: string }; no_match?: string;
  fields: RecordSetField[]; open?: RecordSetOpen;
  /** What a person can run on a record, as visual-database action rows (target, definition ids, input, copy, field_id). */
  actions?: unknown[];
  /** Where a record says the records it is made of are read (an address answering a record set of its own), so
   *  opening it goes one level down in place; `label` names that level for the way back. */
  inside?: { path: Path; label?: string };
  /** How the records are grouped until a placement keeps its own grouping (visual-database group levels). */
  group?: GroupLevel[];
  /** Charts drawn above the list, each a chart placement over the answer (../chart/chart-types.ts). */
  charts?: ChartPlacement[];
  /** Compact owner-fed values drawn above the record list, read by paths in the full answer. */
  summary?: { id: string; label: string; path: Path; kind?: string; values?: Record<string, string> }[];
};
/** What one placement of a record set keeps (parts/ui/show/placement-kept): its rules, grouping and view, and the
 *  levels it went down through (`inside`, each the address read there, the name of the record it went into and of the
 *  list it went in from, and what that list had kept). */
export type RecordSetKept = { rules?: RuleGroup; group?: GroupLevel[]; view?: string; inside?: RecordSetLevel[] };
/** One level a placement went down through, with what the level it left had kept, for the way back up. */
export type RecordSetLevel = { url: string; label: string; from: string; kept?: Omit<RecordSetKept, 'inside'> };
export type RecordSetAnswer = { view: RecordSetView; items: unknown[] } & Record<string, unknown>;

export const readPath = (from: unknown, path: Path | undefined): unknown =>
  (path ?? []).reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), from);
const filled = (value: unknown) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);
const firstOf = (record: unknown, paths: Path[] | undefined): unknown => (paths ?? []).map(path => readPath(record, path)).find(filled);
const shown = (value: unknown): unknown => (Array.isArray(value) ? value.join(', ') : value ?? '');
const rowsAt = (answer: unknown, path: Path | undefined): Record<string, unknown>[] => {
  const rows = readPath(answer, path);
  return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object') : [];
};

/** How a field kind's value is read, drawn and compared, for the kinds whose drawn words are not their value. */
const amountOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** How an amount of a kind reads (a group's total, a value): money with cents under ten dollars, else a number. */
const AMOUNT_WORDS: Record<string, (amount: number) => string> = {
  money: amount => `$${amount < 10 ? amount.toFixed(2) : Math.round(amount).toLocaleString('en-US')}`,
  percent: amount => `${amount.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`,
};
const amountWords = (kind: string | undefined, amount: number) => (kind && AMOUNT_WORDS[kind] ? AMOUNT_WORDS[kind](amount) : amount.toLocaleString('en-US', { maximumFractionDigits: 2 }));
const VALUE_READERS: Record<string, (at: (record: unknown) => unknown) => Partial<FieldDescriptor>> = {
  // An amount of money in dollars: drawn with cents under ten dollars and whole dollars above, compared as a number.
  money: at => ({
    read: record => { const value = amountOf(at(record)); return value === null ? '' : AMOUNT_WORDS.money(value); },
    factValue: record => amountOf(at(record)) ?? Number.NaN,
    sortValue: record => amountOf(at(record)) ?? -1,
  }),
  // A share out of a hundred: drawn with its percent sign, compared as a number.
  percent: at => ({
    read: record => { const value = amountOf(at(record)); return value === null ? '' : AMOUNT_WORDS.percent(value); },
    factValue: record => amountOf(at(record)) ?? Number.NaN,
    sortValue: record => amountOf(at(record)) ?? -1,
  }),
  date: at => ({
    read: record => { const value = at(record); return typeof value === 'string' ? relativeWhen(value, Date.now(), { clock: true }) : ''; },
    factValue: record => Date.parse(String(at(record) ?? '')),
    sortValue: record => Date.parse(String(at(record) ?? '')),
  }),
};

/** The shared record views' field descriptors from a record set's field rows. */
export function fieldsFromRows(rows: RecordSetField[], answer: unknown, extras: FieldExtras = {}): FieldDescriptor[] {
  return rows.map(row => {
    const at = row.derive
      ? (record: unknown) => extras.derived?.get(String(readPath(record, ['id'])))?.[row.id]
      : (record: unknown) => readPath(record, row.path ?? [row.id]);
    const buttons = (extras.actions ?? []).filter(action => action.fieldId === row.id);
    const values = row.values_from
      ? Object.fromEntries(rowsAt(answer, row.values_from.path).map(found => [String(found.id), {
        label: row.values_from?.label ? String(found[row.values_from.label] ?? '') : undefined,
        icon: row.values_from?.icon ? String(found[row.values_from.icon] ?? '') : undefined,
      }]))
      : undefined;
    const totals = rows.filter(one => one.total && METRIC_REDUCERS[one.total]);
    return {
      ...(row.groupable && totals.length ? { renderGroup: (value: string, records: unknown[]) => (
        <>
          <span className="record-views-group-field">{row.label}:</span> {values?.[value]?.label || value}
          {totals.map(one => {
            const amounts = records.map(record => amountOf(readPath(record, one.path ?? [one.id]))).filter((amount): amount is number => amount !== null);
            const total = METRIC_REDUCERS[one.total!](amounts, records.length);
            return total === null ? null : <span key={one.id} className="record-views-group-total"> · {one.label} {amountWords(one.kind, total)}</span>;
          })}
        </>
      ) } : {}),
      id: row.id, label: row.label, icon: row.icon, kind: row.kind, ruleKind: row.rule_kind, width: row.width,
      filterable: row.filterable, groupable: row.groupable, sortable: row.sortable, hiddenByDefault: row.hidden_by_default, preview: row.preview,
      read: (record: unknown) => shown(at(record)),
      ...(values ? { values } : {}),
      ...(row.kind && VALUE_READERS[row.kind] ? VALUE_READERS[row.kind](at) : {}),
      ...(buttons.length && extras.run ? {
        render: (record: unknown) => (
          <Container layout="horizontal" gap="xs" alignItems="center" minWidth="0">
            <Text truncate>{String(shown(at(record)))}</Text>
            {buttons.map(action => <ActionButton key={action.id} action={action} record={record} run={answers => extras.run!(action, record, String(shown(at(record))), answers)}/>)}
          </Container>
        ),
      } : {}),
    };
  });
}

/** What a set's DATA adds to its fields beyond reading the record: computed values and the actions it can run. */
export type FieldExtras = {
  derived?: Map<string, Record<string, unknown>>;
  actions?: readonly VisualDatabaseActionDescriptor[];
  run?: (action: VisualDatabaseActionDescriptor, record: unknown, value?: string, answers?: Readonly<Record<string, string>>) => Promise<unknown>;
};

/** One action's button: the shared button says the run in itself (running, Done, Try again), and a run that did not
 *  happen says why in a notification, in the words of whatever refused it. */
function ActionButton({ action, record, run }: { action: VisualDatabaseActionDescriptor; record: unknown; run: (answers?: Readonly<Record<string, string>>) => Promise<unknown> }) {
  if (action.hiddenWhen && Object.is(readPath(record, action.hiddenWhen.path as Path), action.hiddenWhen.equals)) return null;
  if (action.when && !Object.is(readPath(record, action.when.path as Path), action.when.equals)) return null;
  const press = (event: React.MouseEvent) => {
    event.stopPropagation();
    return run().catch((error: unknown) => {
      notify(`${action.label} did not run`, { kind: 'error', detail: errorWords(error) });
      throw error;
    });
  };
  if (!action.inputPrompts.length) return <Button size="xs" variant="secondary" title={action.label} data-record-action={action.id} onClick={press}>{action.label}</Button>;
  const control = <Button size="xs" variant="secondary" title={action.label} data-record-action={action.id}/>;
  const start = Object.fromEntries(action.inputPrompts.flatMap(prompt => {
    if (!prompt.startFrom) return [];
    const value = readPath(record, prompt.startFrom.split('.').filter(Boolean));
    return value === null || value === undefined ? [] : [[prompt.key, String(value)]];
  }));
  const form: HoverForm = {
    title: action.label,
    fields: action.inputPrompts.map(prompt => ({
      name: prompt.key, label: prompt.label, kind: prompt.kind ?? 'text', optional: prompt.optional,
      placeholder: prompt.placeholder,
    })),
    start,
    submit: action.label,
    run: async answers => { await run(answers); },
  };
  return <HoverFormCell form={form} trigger={control}>{action.label}</HoverFormCell>;
}

/** The value a derived field's target answers, at its result path. */
async function deriveValue(field: RecordSetField, record: unknown, rows: RecordSetField[]): Promise<unknown> {
  const derive = field.derive!;
  const context = Object.fromEntries((derive.context_from_fields ?? []).map(id => {
    const source = rows.find(row => row.id === id);
    return [id, readPath(record, source?.path ?? [id]) ?? null];
  }));
  const reply = await sendRequestToBitfieldTarget({ target: derive.target, payload: { ...(derive.request ?? {}), context } });
  const answer = JSON.parse(new TextDecoder().decode(reply.payload));
  return derive.result_path ? readPath(answer, derive.result_path) : answer;
}

/** One opened record beside the list, drawn by the view its kind row names. */
function OpenRecord({ record, open, kinds, close }: { record: unknown; open: RecordSetOpen; kinds: Record<string, unknown>[]; close: () => void }) {
  const kindId = readPath(record, open.kind_field);
  const kind = kinds.find(row => row.id === kindId) ?? null;
  const viewId = kind && open.view_field ? kind[open.view_field] : null;
  const View = openViewFor(typeof viewId === 'string' ? viewId : null, open.fallback_view ?? 'text');
  const link = readPath(record, open.link) as { label?: string; url?: string } | undefined;
  const linkUrl = link && typeof link.url === 'string' && link.url ? link.url : null;
  const actions = (
    <>
      {linkUrl ? <Button size="sm" variant="secondary" onClick={() => window.open(linkUrl, '_blank', 'noopener')}>{link?.label || open.link_words || 'Open'}</Button> : null}
      <Button size="sm" variant="ghost" onClick={close}>Close</Button>
    </>
  );
  const caption = (open.caption ?? [])
    .map(part => { const value = readPath(record, part.path); return filled(value) ? part.words.replace('{value}', String(shown(value))) : null; })
    .filter(Boolean).join(' ');
  const kindLabel = kind && open.label_field && typeof kind[open.label_field] === 'string' ? kind[open.label_field] as string : null;
  return (
    <Container layout="vertical" gap="none" minWidth="0" data-open-record="">
      <View record={record} role={name => firstOf(record, open.roles?.[name])} kindLabel={kindLabel} actions={actions} />
      {caption ? <Container padding="lg"><Text variant="caption">{caption}</Text></Container> : null}
    </Container>
  );
}

/** The record's name: the first field's value. */
const fieldsTitle = (rows: RecordSetField[], record: unknown) => (rows[0] ? readPath(record, rows[0].path ?? [rows[0].id]) : '') ?? '';

/** Every derived field's value for every record (by the record's id), each asked of its target once; one that failed
 *  reads as empty. Any list on the shared record views computes its derived columns through this. */
export async function deriveValues(rows: RecordSetField[], items: unknown[]): Promise<Map<string, Record<string, unknown>>> {
  const derivedRows = rows.filter(row => row.derive);
  if (!derivedRows.length) return new Map();
  return new Map(await Promise.all(items.map(async item => {
    const entries = await Promise.all(derivedRows.map(async row => [row.id, await deriveValue(row, item, rows).catch(() => null)] as const));
    return [String(readPath(item, ['id'])), Object.fromEntries(entries)] as const;
  })));
}

/** deriveValues kept until the records change; a value not yet answered reads as empty. */
function useDerivedValues(rows: RecordSetField[], items: unknown[]): Map<string, Record<string, unknown>> {
  const [values, setValues] = React.useState(() => new Map<string, Record<string, unknown>>());
  React.useEffect(() => {
    if (!rows.some(row => row.derive)) return;
    let current = true;
    void deriveValues(rows, items).then(found => { if (current) setValues(found); });
    return () => { current = false; };
  }, [rows, items]);
  return values;
}

/** A record set's list on the shared record views, with an opened record drawn beside it. `options` carries what the
 *  host page shares with every list (the record filter). */
export function RecordSet({ answer, options, kept, onKeep, onInside, onActionComplete }: {
  answer: RecordSetAnswer; options?: Partial<RecordViewsOptions>;
  /** In a placement: what it keeps, and how it keeps a change (its rules, grouping and view are its own). */
  kept?: RecordSetKept; onKeep?: (kept: RecordSetKept) => void;
  /** Goes one level down, into the records a record is made of (`view.inside`). */
  onInside?: (url: string, label: string) => void;
  onActionComplete?: () => void | Promise<void>;
}) {
  const { view: set, items } = answer;
  const [open, setOpen] = React.useState<string | null>(null);
  const narrow = useNarrowViewport();
  const actions = React.useMemo(() => recordActionsFromRows(set.actions), [set.actions]);
  const derived = useDerivedValues(set.fields, items);
  const run = React.useCallback(async (action: VisualDatabaseActionDescriptor, record: unknown, value?: string, answers?: Readonly<Record<string, string>>) => {
    const result = await runRecordAction(action, {
      id: String(readPath(record, ['id'])), title: String(shown(fieldsTitle(set.fields, record))), payload: record,
    }, value, answers);
    await onActionComplete?.();
    return result;
  }, [set.fields, onActionComplete]);
  const fields = React.useMemo(() => fieldsFromRows(set.fields, answer, { derived, actions, run }), [set.fields, answer, derived, actions, run]);
  const rowActions = React.useMemo(() => actions.filter(action => !action.fieldId).map(action => ({
    id: action.id, label: action.label, icon: action.icon ?? 'play',
    run: (ids: string[]) => { for (const id of ids) { const record = items.find(item => String(readPath(item, ['id'])) === id); if (record) void run(action, record); } },
  })), [actions, items, run]);
  const kinds = React.useMemo(() => rowsAt(answer, set.open?.kinds), [answer, set.open?.kinds]);
  const opened = open && set.open ? items.find(item => String(readPath(item, ['id'])) === open) ?? null : null;
  // Opening a record that is made of records goes into them, in place; any other opens beside the list.
  const insideOf = (id: string) => {
    const record = items.find(item => String(readPath(item, ['id'])) === id);
    const url = set.inside && record ? readPath(record, set.inside.path) : null;
    return typeof url === 'string' && url ? { url, label: String(shown(fieldsTitle(set.fields, record))) } : null;
  };
  const openRecord = (id: string) => {
    const inside = onInside ? insideOf(id) : null;
    if (inside) onInside!(inside.url, inside.label);
    else if (set.open) setOpen(id);
  };
  const placed = onKeep ? {
    view: kept?.view ?? (narrow ? set.first_view?.narrow : set.first_view?.wide),
    onViewChange: (view: string) => onKeep({ ...kept, view }),
    groupLevels: kept?.group ?? set.group ?? [],
    onGroupLevelsChange: (group: GroupLevel[]) => onKeep({ ...kept, group }),
    ...(options?.ruleOperators ? { rules: kept?.rules ?? emptyGroup(options.ruleOperators) } : {}),
    onQueryChange: ({ rules }: { rules: RuleGroup }) => onKeep({ ...kept, rules }),
  } : { view: narrow ? set.first_view?.narrow : set.first_view?.wide };
  return (
    <Container layout="horizontal" gap="none" height="full" minHeight="0" data-record-set={set.preference_key}>
      {narrow && opened ? null : (
        <Container layout="vertical" flex={1} minHeight="0" minWidth="0" overflow={set.charts?.length ? 'y-auto' : undefined}>
          {set.summary?.length ? <Container layout="horizontal" gap="md" padding="sm" wrap data-record-set-summary="">
            {set.summary.map(row => {
              const raw = readPath(answer, row.path);
              const value = raw === null || raw === undefined ? '' : row.values?.[String(raw)] ?? (typeof raw === 'number' && row.kind && AMOUNT_WORDS[row.kind] ? amountWords(row.kind, raw) : String(raw));
              return <Container key={row.id} layout="vertical" gap="xs" minWidth="0"><Text variant="caption" color="muted">{row.label}</Text><Text variant="label">{value}</Text></Container>;
            })}
          </Container> : null}
          <ChartsOver placements={set.charts ?? []} records={items} answer={answer}>
            <RecordViews
              label={set.label}
              fields={fields}
              records={items}
              onOpen={set.open || (set.inside && onInside) ? openRecord : undefined}
              preferenceKey={set.preference_key}
              emptyMessage={set.no_match ?? 'Nothing matches.'}
              {...(rowActions.length ? { rowActions } : {})}
              {...options}
              {...placed}
            />
          </ChartsOver>
        </Container>
      )}
      {opened && set.open ? (
        <Container layout="vertical" width={narrow ? '100%' : '560px'} minHeight="0" overflow="auto" border="all" background="secondary">
          <OpenRecord key={open} record={opened} open={set.open} kinds={kinds} close={() => setOpen(null)} />
        </Container>
      ) : null}
    </Container>
  );
}
