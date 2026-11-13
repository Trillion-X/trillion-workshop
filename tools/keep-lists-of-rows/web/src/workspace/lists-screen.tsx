// src/workspace/lists-screen.tsx
//
// PURPOSE
//   Lists: every list this person keeps (src/lists.mjs), in the shared record views with how many rows and fields
//   each has; opening one shows its rows in its own tab as a table, board or gallery, with its fields as columns, link
//   fields showing the linked rows by name, a cell edited in place, a field added and a row added.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A list's fields are its DATA: nothing here names a list, a field or a field kind; each field's kind row
//      (src/lists.json field_kinds) says how it draws, how it filters and what a typed value becomes.
//   2. A list and its rows are the person's own records: every read and change goes through list-records.ts (the records
//      door's read and the one records write, the same records the person's AI reads and writes); the screen reads the
//      list back after each change instead of guessing it.
//   3. Every element is a shared component; this file writes no markup.
//   4. A computed field (its kind row `carries` a key) is drawn the way any record set draws one (record-set.tsx): a
//      carried `derive` is a column the formula engine works out from the row's values, a carried `action` is a button
//      on every row running the Workshop tool it names with that row's values. Neither is ever edited in a cell.
//   5. A link field that links a list to itself holds the rows under each row, in order: the list's nesting, handed to
//      the views as one group graph (parts/ui/show/group). Every change a view makes (a row added under another, a
//      title or status set, a row moved to any depth) is one write of the rows, and the list is read back after.
//   6. A list draws its first page of rows as soon as that page is read (list-records.ts invariant 5) and reads each
//      next page when the shared views ask for it (onReadMore); a reload reads again as many rows as are drawn.

import React from 'react';
import { mediaPreviewContent } from '../../parts/ui/show/media-preview';
import { chooseFileViewer } from '../../parts/ui/show/file-preview/choose-file-viewer';
import { previewStore } from './made-previews';
import { bytesAddress, baseName, contentTypeOf, familyOf, previewFor } from './file-picture';
import { openFile } from './open-screen';
import { ScreenState } from '../../parts/ui/show/screen-state';
import { mountRecordViews, type FieldDescriptor, type RecordChange, type RecordNesting } from '../../parts/ui/show/record-views/record-views';
import { loadingLayoutFor } from '../../parts/ui/show/record-views/loading-layout';
import { addMember, emptyGraph, ensureGroup, type GroupGraph } from '../../../../turn-frames-into-slides/read-data/group-graph.ts';
import { deriveValues, fieldsFromRows, type RecordSetField } from '../../parts/ui/show/record-views/record-set';
import { recordActionsFromRows, runRecordAction } from '../../../do-work/run-record-action.ts';
import { loadScreen, mountScreenState } from '../../parts/ui/show/screen-state';
import { notify } from '../../parts/ui/show/coss/notifications';
import { readFileLookup } from './api';
import {recordConfigurationSource} from './record-configurations';
import {makeConfigurationController} from '../../../read-data/configuration-controller.mjs';
import type {SavedRecordView} from '../../parts/ui/show/record-views/record-views';
import { refusal } from './failure';
import { recordFilter } from './record-filter';
import type { RuleGroup } from '../../parts/ui/show/rule-filter/rule-tree';
import { goTo, openScreenOn, openAddress } from './open-screen';
import { recordSource } from './record-source';
import type { RecordFrom, RecordNew } from '../../../../ui/show/record-picker/record-value.ts';
import { addSelectedToTrayAction } from './tray';
import { onRecordsChange, onStoreChange, whileWriting, type ReadDepends } from './store-changes';
import { followHighlights, wordsToFind } from '../../parts/ui/show/text-highlights';
import { clipboardWords, copyRows, pastePlan, readPastedRows, type PastePlan, type PastedRows } from './row-clipboard';

import { errorWords } from '../../../../ui/show/safe-error-card/sanitize-error-text.ts';
import { changeList, makeList, putRows, readList, readLists, readRows, removeView, saveView, titleLinks, whereOf, type Field, type Kind, type List, type Read, type Row, type RowPut, type View } from './list-records';
const failed = (what: string) => (error: unknown) => notify(what, { kind: 'error', detail: errorWords(error) });
const openList = (list: { id: string; label: string }) => openScreenOn('trillion.list', { id: list.id }, list.label);

const LIST_FIELDS: FieldDescriptor[] = [
  { id: 'label', label: 'List', icon: 'List', ruleKind: 'text', filterable: true, sortable: true, width: 280 },
  { id: 'fields', label: 'Fields', icon: 'Columns3', kind: 'number', ruleKind: 'number', sortable: true, width: 110, read: (list: List) => list.fields.length },
  { id: 'about', label: 'About', icon: 'Text', ruleKind: 'text', width: 360 },
];

export function mountListsScreen(element: HTMLElement): () => void {
  let views: ReturnType<typeof mountRecordViews> | null = null;
  const host = document.createElement('div');
  host.className = 'trillion-decisions';
  element.replaceChildren(host);
  const newList = async () => {
    openList(await makeList(`Untitled list ${new Date().toLocaleDateString()}`, [{ id: 'name', label: 'Name', kind: 'text' }]));
  };
  const screen = loadScreen(host, {
    loading: { label: 'Loading your lists', layout: loadingLayoutFor('trillion-lists') },
    read: readLists,
    empty: lists => (lists.length ? null : {
      status: 'empty', icon: 'List', title: 'No lists yet',
      description: 'A list keeps anything in rows and columns: the people you work with, your customers, the AIs in a space. Your AI can make one and fill it, or start one here.',
      action: { label: 'New list', run: () => void newList().catch(failed('The list could not be made')) },
    }),
    failed: refusal('Your lists could not load'),
    clear: () => { views?.destroy(); views = null; },
    draw: lists => {
      const rowOf = (id: string) => lists.find(list => list.id === id);
      const recordOf = (list: List) => `list:${list.id}`;
      const options = {
        label: 'Lists', fields: LIST_FIELDS, records: lists, identify: (list: List) => list.id, preferenceKey: 'trillion-lists',
        ...recordFilter,
        // Each list's ⋯ shares the whole list (src/record-sharing.mjs `list:<id>`), with its rows, fields and rules.
        shareRecord: recordOf,
        bulkActions: [addSelectedToTrayAction(host, rowOf, recordOf, (list: List) => list.label)],
        views: [{ id: 'table', label: 'Table' }], view: 'table',
        onOpen: (id: string) => openList(lists.find(list => list.id === id) ?? { id, label: id }),
        primaryAction: { label: 'New list', icon: 'Plus', onSelect: () => void newList().catch(failed('The list could not be made')) },
        emptyMessage: 'Nothing matches.',
      };
      if (views) views.update(options); else views = mountRecordViews(host, options);
    },
  });
  const stopListening = onStoreChange(() => screen.reload());
  return () => { stopListening(); screen.dispose(); element.replaceChildren(); };
}

// A list's field as a record set's field row: read from the row's values, with whatever its kind row says it carries
// (a formula's `derive`, which reads every kept field unless it names its own, or a button's `action`).
const setFieldOf = (field: Field, kind: Kind | undefined, kept: string[]): RecordSetField => {
  const carried = kind?.carries ? field[kind.carries.key] : undefined;
  const derive = kind?.carries?.key === 'derive' && carried && typeof carried === 'object' ? carried as RecordSetField['derive'] : undefined;
  return {
    id: field.id, label: field.label, path: ['values', field.id],
    ...(derive ? { derive: { ...derive, context_from_fields: derive?.context_from_fields ?? kept } } : {}),
  };
};
// A row's own values as an action's answers (`copy` reads `answers.<field id>`), each as the words it shows.
const answersOf = (row: Row): Record<string, string> => Object.fromEntries(Object.entries(row.values)
  .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value)]));

// The list's nesting from the field that links the list to itself: each row holding rows is a group of them, in order.
// A row listed under itself or under a row it holds is left where it is (a row can never sit inside itself).
const nestingOf = (rows: Row[], fieldId: string): RecordNesting => {
  const ref = (id: string) => ({ family: 'list-row', parts: { id } });
  let graph: GroupGraph = emptyGraph();
  for (const row of rows) {
    const under = row.values[fieldId];
    if (!Array.isArray(under) || under.length === 0) continue;
    graph = ensureGroup(graph, ref(row.id));
    for (const id of under) {
      try { graph = addMember(graph, ref(row.id), ref(String(id)), { memberId: String(id) }); } catch { /* a cycle or a repeat: skipped */ }
    }
  }
  return { graph, field: fieldId };
};

// The fields a list gains the first time it needs them: its notes (a document per row) and the rows under each row.
// Each is offered on every list before it exists, and made when a row is first given notes or a sub-row.
// A rule (a field whose kind's value is a rule) read as a sentence, such as "tags contains red or tags contains
// blue", so the table shows what it checks instead of the tree it is kept as.
type RuleTree = { kind?: string; combinator?: string; negate?: boolean; field?: string; operator?: string; params?: { value?: unknown; values?: unknown[] }; rules?: RuleTree[] };
const ruleWords = (tree: RuleTree | null | undefined): string => {
  if (!tree || typeof tree !== 'object') return '';
  if (tree.kind === 'rule') return [tree.field, String(tree.operator ?? '').replace(/_/g, ' '), tree.params?.value ?? (tree.params?.values ?? []).join(' or ')].filter(part => part !== undefined && part !== '').join(' ');
  const inner = (tree.rules ?? []).map(ruleWords).filter(Boolean).join(tree.combinator === 'or' ? ' or ' : ' and ');
  return tree.negate && inner ? `not (${inner})` : inner;
};
const NOTES_FIELD = { label: 'Notes', kind: 'long-text' };
const UNDER_FIELD = { label: 'Sub-items', kind: 'link' };
// An id for a field the list does not have yet, from its label, never one the list already uses.
const freeFieldId = (list: List, label: string) => {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let id = base;
  for (let n = 2; list.fields.some(field => field.id === id); n += 1) id = `${base}-${n}`;
  return id;
};

// What a typed cell becomes for its field's kind row: a number, a list of texts, or the text itself.
const typedValue = (kind: Kind | undefined, typed: string): unknown => {
  const text = typed.trim();
  if (!text) return null;
  if (kind?.value === 'number') return Number.isFinite(Number(text)) ? Number(text) : text;
  if (kind?.value === 'texts' || kind?.value === 'row-ids') return text.split(',').map(part => part.trim()).filter(Boolean);
  return text;
};

export function mountListScreen(element: HTMLElement, props: { surfaceInput?: Record<string, unknown> }): () => void {
  // The view it opens on, when the address or the opener names one (`?view=form`); else the way the open saved view says it
  // is drawn (display.as, any view the list offers); else the table.
  const named = typeof props.surfaceInput?.view === 'string' ? props.surfaceInput.view : undefined;
  let drawnAs = 'table';
  const id = typeof props.surfaceInput?.id === 'string' ? props.surfaceInput.id : '';
  // The one row the address names (`/lists/<list>/<row>`, a notice about it): scrolled to and marked when it draws.
  const row = typeof props.surfaceInput?.row === 'string' ? props.surfaceInput.row : '';
  if (!id) { mountScreenState(element, { status: 'empty', icon: 'List', title: 'No list was named', description: 'Open a list from Lists.', action: goTo('Open Lists', 'trillion.lists') }); return () => element.replaceChildren(); }
  let views: ReturnType<typeof mountRecordViews> | null = null;
  const host = document.createElement('div');
  host.className = 'trillion-decisions';
  element.replaceChildren(host);
  // Every change this screen makes goes under the list's key, so a store change it causes is read once, after it is answered.
  const writeKey = `list:${id}`;
  const writing = <T,>(run: () => Promise<T>) => whileWriting(writeKey, run);
  // What the last read depended on (list-records.ts): a store change reads this list again only when it touches it.
  let depends: ReadDepends | null = null;
  // The words typed in the list's search are marked where they appear in its rows, without touching the rows' markup.
  const found = followHighlights(host, 'find');
  let activeViewId: string | null = typeof props.surfaceInput?.saved_view === 'string' ? props.surfaceInput.saved_view : null;
  let draftView: {id: string; search: string; rules: RuleGroup} | null = null;
  const change = (what: string, run: () => Promise<unknown>) => void run().then(() => screen.reload(), failed(what));
  // Computed columns' values, asked once per read and drawn when they answer.
  let derived = new Map<string, Record<string, unknown>>();
  let asked: Row[] | null = null;
  let disposed = false;
  let currentRead: Read | null = null;
  let configurationFields: string[] = [];
  let prepareConfiguration: (view: Partial<SavedRecordView>) => Promise<void> = async () => {};
  const configurationSource = recordConfigurationSource({accessCode: typeof props.surfaceInput?.access_code === 'string' ? props.surfaceInput.access_code : undefined});
  const configurations = makeConfigurationController({source: configurationSource, target: `list:${id}`, openPath: `/lists/${encodeURIComponent(id)}`,
    fieldIds: () => configurationFields, beforeSave: view => prepareConfiguration(view),
    initialId: typeof props.surfaceInput?.configuration === 'string' ? props.surfaceInput.configuration : undefined,
    sharedCode: typeof props.surfaceInput?.shared_configuration === 'string' ? props.surfaceInput.shared_configuration : undefined,
    sharedOffer: typeof props.surfaceInput?.shared_offer === 'string' ? props.surfaceInput.shared_offer : undefined,
    changed: () => {if (!disposed && currentRead) drawList(currentRead);},
    applied: view => {
      activeViewId = null; draftView = {id: view.id, search: view.search, rules: view.rules};
      void screen.reload();
    },
  });
  let configurationsStarted = false;

  type FileLook = { identity: string; media_type: string | null; names?: string[]; poster?: string };
  const fileLooks = new Map<string, FileLook | null>();
  const waitingFiles = new Set<string>();
  const inFlightFiles = new Set<string>();
  const mediaRef = (row: Row, field: Field) => typeof row.values[field.id] === 'string' ? String(row.values[field.id]).trim() : '';
  // Metadata and kept posters only: a list never decodes an original recording to make its thumbnails.
  const readMedia = () => {
    while (waitingFiles.size && inFlightFiles.size < 2 && !disposed) {
      const ref = waitingFiles.values().next().value!;
      waitingFiles.delete(ref); inFlightFiles.add(ref);
      void (async () => {
        try {
          const found = await readFileLookup<FileLook>(ref);
          const made = await previewStore.read(found.identity).catch(() => null);
          fileLooks.set(ref, { ...found, ...(made?.poster ? { poster: made.poster } : {}) });
        } catch { fileLooks.set(ref, null); }
        finally { inFlightFiles.delete(ref); }
        if (!disposed && currentRead) drawList(currentRead);
        readMedia();
      })();
    }
  };
  const fileName = (file: FileLook) => baseName(file.names?.[0] ?? '') || 'Unnamed file';
  const fileType = (file: FileLook) => contentTypeOf(fileName(file), file.media_type);
  const pictureOf = (file: FileLook | null | undefined) => file ? file.poster ?? (chooseFileViewer({ name: fileName(file), contentType: fileType(file) }) === 'picture' ? bytesAddress(file.identity) : null) : null;
  const fileLook = (ref: string) => {
    if (!ref) return null;
    const file = fileLooks.get(ref);
    if (file === undefined) return React.createElement(ScreenState, { state: { status: 'loading', label: 'Loading the file', layout: 'preview' } });
    if (!file) return React.createElement(ScreenState, { state: { status: 'unavailable', title: 'The file could not load', inline: true } });
    const look = previewFor(familyOf(fileName(file), file.media_type));
    const picture = pictureOf(file);
    return mediaPreviewContent({ renderer: picture ? 'image' : 'type-icon', source: picture ?? undefined, title: fileName(file), icon: look.icon, typeLabel: look.type_label });
  };
  // The search and rules in force (the shared views' onQueryChange, else the open saved view's), and the `where` the rows
  // drawn were read with: a rule the records door decides itself narrows the read there (list-records.ts whereOf).
  let query: { search: string; rules: RuleGroup | null } | null = null;
  let readWhere: Record<string, unknown> | null = null;
  const inForce = () => {
    const saved = currentRead?.list.views?.find(view => view.id === activeViewId);
    return query ?? (draftView ? { search: draftView.search, rules: draftView.rules } : { search: saved?.search ?? '', rules: (saved?.rules as RuleGroup | undefined) ?? null });
  };
  const sameWhere = (a: Record<string, unknown> | null, b: Record<string, unknown> | null) => JSON.stringify(a) === JSON.stringify(b);
  // The list's next page, appended to the rows drawn; one read at a time, and none for a read a reload has replaced or is replacing. A
  // page is read when the end of the rows comes near; while a search, a rule the door cannot decide, a sort, a grouping
  // or Select all is in force, the rest are read too (`every`), and the status says so.
  let readingMore = false;
  let readingEvery = false;
  const readMore = (want: { end: boolean; search: boolean; rules: boolean; every: boolean }) => {
    const read = currentRead;
    const wanted = want.every || want.search || (want.rules && !whereOf(inForce().rules).whole);
    const end = want.end;
    if (readingMore || disposed || !read?.next || !sameWhere(read.where, readWhere) || (!end && !wanted)) return;
    readingMore = true;
    readingEvery = wanted;
    void readRows(read.list, read.next, { every: wanted, where: read.where }).then(page => {
      readingMore = false;
      if (disposed || currentRead !== read) return;
      const grown = { ...read, rows: [...read.rows, ...page.rows], next: page.next };
      drawList(grown);
      titleDrawn(grown, page.rows);
    }, error => { readingMore = false; failed('More rows could not be read')(error); });
  };
  // A page's links are titled once it is drawn (list-records.ts invariant 5); the titles go on the rows still drawn from
  // that read (a reload reads a new list record, and its own titles).
  const titleDrawn = (read: Read, rows: Row[]) => {
    if (!rows.some(row => Object.keys(row.links).length)) return;
    void titleLinks(read.list, rows).then(titled => {
      const now = currentRead;
      if (disposed || !now || now.list !== read.list) return;
      const byId = new Map(titled.map(row => [row.id, row]));
      drawList({ ...now, rows: now.rows.map(row => byId.get(row.id) ?? row) });
    }, failed('Linked rows could not be named'));
  };
  const drawList = (read: Read) => {
    currentRead = read;
    const { list, rows, field_kinds: kinds } = read;
    const mediaFields = list.fields.filter(field => kinds.find(kind => kind.id === field.kind)?.media);
    for (const row of rows) for (const field of mediaFields) {
      const ref = mediaRef(row, field);
      if (ref && !fileLooks.has(ref) && !inFlightFiles.has(ref)) waitingFiles.add(ref);
    }
    void readMedia();
    // A saved view drawn another way opens that way; one that is not keeps the view the person is on.
    const savedAs = (list.views ?? []).find(saved => saved.id === (activeViewId ?? draftView?.id))?.display?.as;
    if (savedAs) drawnAs = savedAs;
    const kindOf = new Map(kinds.map(kind => [kind.id, kind]));
    const computed = (field: Field) => kindOf.get(field.kind)?.value === 'computed';
    const kept = list.fields.filter(field => !computed(field)).map(field => field.id);
    const setFields = list.fields.map(field => setFieldOf(field, kindOf.get(field.kind), kept));
    const actions = recordActionsFromRows(list.fields.flatMap(field => {
      const key = kindOf.get(field.kind)?.carries?.key;
      const action = key === 'action' ? field[key] : undefined;
      return action && typeof action === 'object' ? [{ label: field.label, ...action, id: field.id, field_id: field.id }] : [];
    }));
    const run = (action: Parameters<typeof runRecordAction>[0], record: unknown, value?: string) => {
      const row = record as Row;
      return runRecordAction(action, { id: row.id, title: row.title ?? row.id, payload: row }, value, answersOf(row));
    };
    const drawnComputed = new Map(fieldsFromRows(setFields, read, { derived, actions, run }).map(field => [field.id, field]));
    if (asked !== rows && setFields.some(field => field.derive)) {
      asked = rows;
      void deriveValues(setFields, rows).then(found => { if (asked === rows) { derived = found; drawList(read); } });
    }
    const fields: FieldDescriptor[] = list.fields.map((field, index) => {
      const kind = kindOf.get(field.kind);
      if (computed(field)) {
        const drawn = drawnComputed.get(field.id)!;
        return { ...drawn, icon: kind?.icon, kind: kind?.kind ?? 'text', ruleKind: kind?.ruleKind ?? 'text', filterable: true, sortable: true, width: 180, editable: false };
      }
      return {
        id: field.id, label: field.label, icon: kind?.icon, kind: kind?.kind ?? 'text', ruleKind: kind?.ruleKind ?? 'text',
        filterable: true, sortable: true, groupable: kind?.kind === 'tag', width: index === 0 ? 260 : 180,
        read: (row: Row) => (field.links_to ? (row.links[field.id] ?? []).map(link => link.title)
          : kind?.value === 'rule' ? ruleWords(row.values[field.id] as RuleTree) : row.values[field.id] ?? ''),
        // A link cell is changed through the record picker over the list it links to; other kinds as before.
        editable: (kind?.links ? Boolean(field.links_to) : kind?.value !== 'rule') && field.editable !== false,
        ...(kind?.record_pick && field.from ? { records: { from: field.from as RecordFrom, ...(field.new ? { made: field.new as RecordNew } : {}), source: recordSource } } : {}),
        ...(kind?.links && field.links_to ? { links: { from: { lists: [field.links_to] }, source: recordSource, current: (row: Row) => row.links[field.id] ?? [] } } : {}),
        ...(kind?.media ? { kind: 'thumbnail', render: (row: Row) => fileLook(mediaRef(row, field)), pictureUrl: (row: Row) => pictureOf(fileLooks.get(mediaRef(row, field))), pictureSource: (row: Row) => {
          const file = fileLooks.get(mediaRef(row, field));
          return file ? chooseFileViewer({ name: fileName(file), contentType: fileType(file) }) === 'picture' ? 'image' as const : 'poster' as const : null;
        } } : {}),
        ...(kind?.document ? { document: true } : {}),
        ...(field.choices ? { values: Object.fromEntries(field.choices.map(choice => [choice, {}])) } : {}),
      };
    });
    // The field linking this list to itself is how its rows nest; a view keeps a row's sub-rows there. A list without
    // one nests all the same: the field is made the first time a row is put under another.
    const nestField = list.fields.find(field => field.links_to === list.id && kindOf.get(field.kind)?.links);
    const nestId = nestField?.id ?? freeFieldId(list, UNDER_FIELD.label);
    const nesting = nestField ? nestingOf(rows, nestField.id) : { graph: emptyGraph(), field: nestId };
    // The first field whose kind holds a document is each row's notes, written in the documents editor; a list without
    // one has its notes offered (out of the table until shown) and made when a row is first given notes.
    const notesField = list.fields.find(field => kindOf.get(field.kind)?.document);
    const notesId = notesField?.id ?? freeFieldId(list, NOTES_FIELD.label);
    if (!notesField) {
      fields.push({
        id: notesId, label: NOTES_FIELD.label, icon: kindOf.get(NOTES_FIELD.kind)?.icon, kind: 'text', ruleKind: 'text', document: true,
        filterable: true, sortable: true, hiddenByDefault: true, width: 260, editable: true,
        read: (row: Row) => row.values[notesId] ?? '',
      });
    }
    // The fields a change needs that the list does not have yet are made first, in one save of the list.
    const fieldsFor = (values: string[], nests: boolean): Field[] => [
      ...(!notesField && values.includes(notesId) ? [{ id: notesId, ...NOTES_FIELD }] : []),
      ...(!nestField && nests ? [{ id: nestId, ...UNDER_FIELD, links_to: list.id }] : []),
    ];
    const withFields = async (needed: Field[]) => { if (needed.length > 0) await writing(() => changeList(list, { fields: [...list.fields, ...needed] })); };
    const keep = (put: RowPut[], remove: string[] = []) => writing(() => putRows(list, put, remove));
    configurationFields = fields.map(field => field.id);
    prepareConfiguration = async view => {
      if (!notesField && view.columns?.order?.includes(notesId)) await withFields([{id: notesId, ...NOTES_FIELD}]);
    };
    const configurationOptions = configurations.options();

    const write = async (changes: RecordChange[]) => {
      await withFields(fieldsFor(changes.flatMap(change => Object.keys(change.values ?? {})), changes.some(change => change.members)));
      await keep(changes.filter(change => !change.remove).map(change => ({
        id: change.id,
        values: { ...(change.values ?? {}), ...(change.members ? { [nestId]: change.members } : {}) },
      })), changes.filter(change => change.remove).map(change => change.id));
      screen.reload();
    };
    const reread = () => readList(list, rows.length, read.where).then(fresh => titleLinks(fresh.list, fresh.rows)).then(fresh => ({ records: fresh, nesting: nestingOf(fresh, nestId) }));
    const rowOf = (id: string) => rows.find(row => row.id === id);
    const recordOf = (row: Row) => list.managed_rows?.share_record ? `record:${list.row_type}:${row.id}` : `list:${list.id}:rows:${row.id}`;
    const fileActions = mediaFields.flatMap(field => [{ appliesTo: (row: Row) => Boolean(fileLooks.get(mediaRef(row, field))), id: `open-${field.id}`, label: `Open ${field.label}`, icon: 'ArrowUpRight', run: (ids: string[]) => {
        for (const id of ids) {
          const row = rows.find(row => row.id === id);
          const file = row && fileLooks.get(mediaRef(row, field));
          if (file) openFile({ id: file.identity, name: fileName(file), type: fileType(file) });
        }
      } }, { id: `reload-${field.id}`, label: `Reload ${field.label}`, icon: 'RotateCw', appliesTo: (row: Row) => fileLooks.get(mediaRef(row, field)) === null, run: (ids: string[]) => {
        for (const id of ids) { const row = rows.find(row => row.id === id); const ref = row && mediaRef(row, field); if (ref) { fileLooks.delete(ref); waitingFiles.add(ref); } }
        void readMedia();
      } }]);
    const options = {
      label: list.label, fields, records: rows, identify: (row: Row) => row.id, preferenceKey: `trillion-list-${list.id}`,
      ...recordFilter,
      previewFields: mediaFields.map(field => ({ id: `media-${field.id}`, label: field.label, kind: 'media', preview: true, read: (row: Row) => {
        const file = fileLooks.get(mediaRef(row, field));
        return file ? { id: file.identity, title: fileName(file), type: fileType(file), url: bytesAddress(file.identity), poster: file.poster } : null;
      } })),
      // Each row's ⋯ shares that one row (record-sharing.json parts: the list narrowed to it), by link or email.
      shareRecord: recordOf,
      aboutRecord: (row: Row) => ({ kind: 'record', id: `record:${list.row_type}:${row.id}`, record: `record:${list.row_type}:${row.id}`, title: row.title ?? list.label }),
      bulkActions: [addSelectedToTrayAction(host, rowOf, recordOf, (row: Row) => row.title ?? `Row in ${list.label}`)],
      // Opening any row inspects its canonical record; editing and sharing retain their own owners.
      // The common record menu supplies the same inspection action on every other surface.
      rowActions: fileActions,
      onOpen: (id: string) => {
        const selected = rowOf(id);
        const destination = list.managed_rows?.open_field && selected?.values[list.managed_rows.open_field];
        if (typeof destination === 'string' && destination.startsWith('/') && !destination.startsWith('//')) {openAddress(destination); return;}
        if (selected) openScreenOn('trillion.activity-trace', { item: `record:${list.row_type}:${selected.id}` }, selected.title ?? list.label);
      },
      nesting, write, reread,
      // A list longer than the pages read so far draws them and reads its next page when the shared views ask. Both are
      // given every time (undefined once every row is read): an update keeps any option it is not given.
      onReadMore: read.next ? readMore : undefined,
      status: !read.next ? undefined : readingEvery ? `Read ${rows.length.toLocaleString()} rows so far; reading the rest for the search, filter, sort or selection.`
        : `Showing the first ${rows.length.toLocaleString()} rows. More are read as you scroll.`,
      views: [{ id: 'table', label: 'Table' }, { id: 'board', label: 'Board' }, { id: 'gallery', label: 'Gallery' }], view: named ?? drawnAs,
      ...(row ? { reveal: { id: row, nonce: 1 } } : {}),
      // A kind that carries how its value is worked out (a formula, a button) is added by the person's AI (save_list), which
      // writes what it carries; the add-field form offers the kinds a name alone makes.
      customFieldKinds: kinds.filter(kind => !kind.links && !kind.carries && !kind.record_pick).map(kind => ({ id: kind.id, label: kind.label, kind: kind.id, ruleKind: kind.ruleKind })),
      onAddField: (added: { id: string; label: string; kind?: string }) => change('The field could not be added', () => writing(() => changeList(list, { fields: [...list.fields, { id: added.id, label: added.label, kind: added.kind ?? 'text' }] }))),
      onEditFieldValue: (rowId: string, fieldId: string, typed: string) => {
        const kind = fieldId === notesId && !notesField ? NOTES_FIELD.kind : list.fields.find(field => field.id === fieldId)?.kind ?? '';
        const save = async () => {
          await withFields(fieldsFor([fieldId], false));
          await keep([{ id: rowId, values: { [fieldId]: typedValue(kindOf.get(kind), typed) } }]);
        };
        // The picker retains a refused choice and its inline retry. Its caller must receive the actual write promise;
        // the other editors keep their existing screen error handling.
        if (kindOf.get(kind)?.record_pick) return save().then(() => { void screen.reload(); });
        return change('The change could not be saved', save);
      },
      // Customers, Leads, "opened the email": saved slices of these same rows, kept on the list.
      ...configurationOptions,
      savedViews: [...(list.views ?? []).map(view => ({ ...view, ...(draftView?.id === view.id ? draftView : {}), rules: draftView?.id === view.id ? draftView.rules : view.rules ?? { kind: 'group', combinator: 'and', negate: false, rules: [] } })), ...(configurationOptions.savedViews ?? [])],
      initialSavedViewId: activeViewId ?? draftView?.id ?? configurationOptions.initialSavedViewId,
      onQueryChange: changed => {
        query = changed;
        found.set(wordsToFind(changed.search));
        // A rule the door decides changes which rows are read: the list is read again, narrowed the new way.
        let again = !sameWhere(whereOf(changed.rules).where, readWhere);
        const selected = activeViewId ?? draftView?.id;
        if (selected) draftView = {id: selected, ...changed};
        if (selected && activeViewId) {
          activeViewId = null;
          // A changed query may include rows the saved server slice excluded.
          // Refill this mounted surface from the whole list without losing its editor state.
          again = true;
        }
        if (again) void screen.reload();
      },
      onSaveView: async (view: Omit<SavedRecordView, 'id'>) => {await configurations.save(view);},
      onUpdateSavedView: async (view: Partial<SavedRecordView> & {id: string}) => {
        if (configurations.has(view.id)) {await configurations.update(view); return;}
        await prepareConfiguration(view);
        const kept = list.views?.find(saved => saved.id === view.id);
        await writing(() => saveView(list, { ...kept, ...view } as View));
        activeViewId = view.id; draftView = null; await screen.reload();
      },
      onRemoveSavedView: async (viewId: string) => {
        if (configurations.has(viewId)) {await configurations.remove(viewId); return;}
        await writing(() => removeView(list, viewId));
        if (activeViewId === viewId) activeViewId = null;
        if (draftView?.id === viewId) draftView = null;
        await screen.reload();
      },
      onApplySavedView: (view: SavedRecordView) => {
        if (configurations.has(view.id)) {configurations.apply(view); return;}
        activeViewId = view.id; draftView = null; void screen.reload();
      },
      onShareSavedView: async (viewId: string) => {
        if (configurations.has(viewId)) {await configurations.share(viewId); return;}
        const legacy = list.views?.find(view => view.id === viewId);
        if (!legacy) throw new Error('This saved view is no longer available.');
        // Sharing an older embedded view makes an explicit reusable copy, while
        // its original list and existing saved-view links remain usable.
        const copy = await configurations.save({...legacy, label: `${legacy.label} (shared configuration)`} as Partial<SavedRecordView>);
        await configurations.share(copy.id);
      },
      onCopySavedViewLink: async (viewId: string) => {
        if (configurations.has(viewId)) {await configurations.copyLink(viewId); return;}
        const link = new URL(`/lists/${encodeURIComponent(id)}`, location.origin); link.searchParams.set('saved_view', viewId);
        await navigator.clipboard.writeText(link.href); notify('Saved view link copied', {kind: 'done'});
      },
      primaryAction: list.managed_rows?.create_on_screen ? undefined : { label: 'Add row', icon: 'Plus', onSelect: () => change('The row could not be added', () => keep([{ values: list.title_field ? { [list.title_field]: 'New row' } : {} }])) },
      emptyMessage: 'No rows yet. Add one, or ask your AI to fill this list.',
    };
    if (views) views.update(options); else views = mountRecordViews(host, options);
    if (!configurationsStarted) {configurationsStarted = true; void configurations.load();}
    // A saved view opened with the list whose rules the door decides reads the list again, narrowed by them.
    if (!sameWhere(whereOf(inForce().rules).where, readWhere)) void screen.reload();
  };
  // Selected rows copy whole (Trillion's own type beside text, a table and markdown), and rows pasted from another list,
  // another editor or a spreadsheet become rows here (row-clipboard.ts); a field being typed in keeps its own clipboard.
  const typing = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
  const selectedRowIds = () => new Set([...host.querySelectorAll('[data-record-id][data-selected="true"]')].map(row => row.getAttribute('data-record-id')));
  const runPaste = async (plan: PastePlan, pasted: PastedRows, read: Read) => {
    const pastedCount = pasted.from === 'trillion' ? pasted.copied.rows.length : plan.kind === 'table' ? plan.rows.length : 0;
    const done = () => { notify(clipboardWords('pasted', { count: pastedCount }), { kind: 'done' }); return screen.reload(); };
    const into = read.list;
    const keepHere = (rows: RowPut[]) => writing(() => putRows(into, rows));
    // Rows copied from this list are kept again as new rows with the values copied; rows from another list take the
    // values of the fields matched to this list's (pastePlan's map: this list's field -> the copied list's field).
    if (plan.kind === 'same-list') { await keepHere(pasted.from === 'trillion' ? pasted.copied.rows.map(copied => ({ values: copied.values })) : []); return done(); }
    if (plan.kind === 'table') { await keepHere(plan.rows); return done(); }
    const copied = pasted.from === 'trillion' ? pasted.copied.rows : [];
    const copyHere = async () => {
      await keepHere(copied.map(row => ({ values: Object.fromEntries(Object.entries(plan.copy.map).filter(([, from]) => row.values[from] !== undefined).map(([to, from]) => [to, row.values[from]])) })));
      await done();
    };
    if (!plan.link) return copyHere();
    const link = plan.link;
    notify(clipboardWords('choose', { count: pastedCount, list: pasted.from === 'trillion' ? pasted.copied.list_label : read.list.label }), {
      detail: clipboardWords('choose_detail'), timeout: 0,
      actions: [
        { id: 'link', label: clipboardWords('link'), onAction: () => keepHere(link.rows).then(done, failed(clipboardWords('failed'))) },
        { id: 'copy', label: clipboardWords('copy'), onAction: () => copyHere().catch(failed(clipboardWords('failed'))) },
      ],
    });
  };
  host.addEventListener('copy', event => {
    const read = currentRead;
    if (!read || !event.clipboardData || typing(event.target)) return;
    const chosen = selectedRowIds();
    const rows = read.rows.filter(row => chosen.has(row.id));
    if (!rows.length) return;
    event.preventDefault();
    copyRows(event.clipboardData, { list_id: read.list.id, list_label: read.list.label,
      fields: read.list.fields.map(field => ({ id: field.id, label: field.label, kind: field.kind, ...(field.links_to ? { links_to: field.links_to } : {}) })),
      rows: rows.map(row => ({ id: row.id, title: row.title, values: row.values })) });
  });
  host.addEventListener('paste', event => {
    const read = currentRead;
    if (!read || !event.clipboardData || typing(event.target)) return;
    const pasted = readPastedRows(event.clipboardData);
    const kindById = new Map(read.field_kinds.map(kind => [kind.id, kind]));
    const plan = pasted && pastePlan(pasted, read.list, (field, text) => typedValue(kindById.get(field.kind), text));
    if (!pasted || !plan) return;
    event.preventDefault();
    void runPaste(plan, pasted, read).catch(failed(clipboardWords('failed')));
  });
  const screen = loadScreen(host, {
    loading: { label: 'Loading the list', layout: loadingLayoutFor(`trillion-list-${id}`) },
    // A reload reads again as many rows as are drawn, so a change never takes away the pages already read.
    read: () => {
      const where = whereOf(inForce().rules).where;
      const drawn = sameWhere(where, readWhere) ? currentRead?.rows.length : 0;
      readWhere = where;
      readingEvery = false;
      return readList(currentRead?.list ?? id, drawn, where).then(answer => { depends = answer.depends; return answer; });
    },
    failed: refusal('This list could not load'),
    clear: () => { views?.destroy(); views = null; },
    draw: read => { drawList(read); titleDrawn(read, read.rows); },
  });
  const stopListening = onRecordsChange(() => screen.reload(), () => depends, writeKey);
  return () => { stopListening(); found.stop(); disposed = true; configurations.dispose(); currentRead = null; waitingFiles.clear(); screen.dispose(); element.replaceChildren(); };
}

