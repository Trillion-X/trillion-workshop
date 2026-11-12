// parts/visual-database/read-data/visual-database-input-from-list.ts
//
// PURPOSE
//   Any Trillion list (the shared record views' fields and the records they read) as the visual-database model's
//   input, so a visual-database view (timeline, swimlanes, outline, tree, summary) draws that list. This is the
//   records seam of the port: in Bitfield the model read published records and descriptor records; in Trillion each
//   list already holds its records and describes its fields, so their values are read here once and handed over.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list is named: what each field is for comes from how the list describes it (its kind, the values it
//      declares, whether it groups), never from its id.
//   2. The list's own screen owns its records: a field is offered for editing only when the list hands `write` and
//      the field is not marked uneditable (nor a date, which these views draw as an instant), and every edit reaches
//      the list through do-work/list-record-writer.ts.
//   3. One role assignment (`listFieldRoles`) decides both which views a list is offered and how each draws it.
//   4. Nesting has one model: a list that nests its records hands its group graph (parts/ui/show/group/group-graph:
//      groups with ordered members), and a record sits under each record whose group holds it, in that group's
//      memberOrder; records are handed over in that order (depth first), which is the order the views draw siblings
//      in. A field of kind `parent` is read only when the list hands no graph.
//   5. The zoom step the list hands (`detail`) never changes what a view needs to draw: at the name alone, a field keeps
//      its part only when it is the record's name, its nesting, its lane (what ticks it done), or a part the view needs.

import type { DecodeVisualDatabaseInput } from './visual-database';
import { nestedByIdentity, type GroupGraph } from '../../turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from '../../turn-frames-into-slides/read-data/visual-layer-types.ts';

/** The shape of a list's field this reads (parts/ui/show/record-views FieldDescriptor). */
export interface ListField {
  id: string;
  label: string;
  kind?: string;
  ruleKind?: string;
  groupable?: boolean;
  read?: (record: any) => unknown;
  factValue?: (record: any) => unknown;
  /** A thumbnail field's picture as an address a gallery can load (null when the record has none). */
  pictureUrl?: (record: any) => string | null;
  values?: Record<string, { label?: string; tone?: string; parent?: string }>;
  /** The value a new record starts at (a choice field's starting value). */
  starts?: string;
  /** The values a record keeps once it holds them (a Done that stays done): the values that mean it is done. */
  settles?: readonly string[];
  /** False for a field whose value the list works out or links (it is never typed into). */
  editable?: boolean;
  /** The field holds a document (written and read as markdown): the first such field is each record's notes, edited
   * with the documents editor in every view that opens a record. */
  document?: boolean;
  /** The field holds the ids of other records of the list (the records it came from or leads to): drawn by their
   * names, never their ids. */
  links?: { direction: string };
}

/** One change the list keeps (parts/ui/show/record-views RecordChange): values set on a record (a new one when
 * `create`), `members` the records nested under it, in order, or the record taken away (`remove`). */
export interface ListRecordChange {
  id: string;
  create?: boolean;
  values?: Record<string, unknown>;
  members?: string[];
  remove?: boolean;
}

export interface ListContext {
  records: readonly any[];
  /** Opens one record by its identity (a view's press on a record). */
  open?: (id: string) => void;
  fields: readonly ListField[];
  label: string;
  identify: (record: any) => string;
  /** How the list's records nest: each group is the record it names, its members the records under it. */
  nesting?: ListNesting;
  /** Keeps changes made in a view; without it every view only reads. */
  write?: (changes: ListRecordChange[]) => Promise<void>;
  /** Reads the list again from where it is kept (its records and nesting), so a change is checked against the list
   * itself and not against what the page last drew. */
  reread?: () => Promise<Pick<ListContext, 'records' | 'nesting'>>;
  /** The list's zoom step (parts/ui/show/record-views detail-levels.json): how many facts each record shows beside its
   * name, 0 the name alone and null every one. */
  detail?: { fields: number | null };
  /** The list's own Group by, outermost first (parts/ui/show/record-views GroupLevel): a list view sits its records
   * under these fields' values. */
  groupLevels?: readonly { field: string }[];
}

export interface ListNesting {
  graph: GroupGraph;
  /** The record identity an address names (a group's own address, or a member's). Default: its `id` part. */
  identityOf?: (ref: AddressRef) => string | null;
  /** The field the nesting is kept in, when it is one. It is the rows' structure, never a fact drawn beside a name. */
  field?: string;
}

/** One view offered to every list (source-data/views-offered-to-every-list.json). */
export interface OfferedViewRow {
  id: string;
  label: string;
  icon?: string;
  kind: string;
  needs: readonly string[];
  /** Roles a list may fill that the view draws when it does, without making them a condition for offering it. */
  wants?: readonly string[];
  zoom?: string;
  /** For a checklist: the value tones that mean an item is done (a field's declared values carry tones). */
  done_tones?: readonly string[];
  /** For a checklist: the value names that mean an item is done, for a list whose values carry no tone (a choice
   * field "Status" with a value "Done"), compared without case. */
  done_values?: readonly string[];
  /** A list view that says above its records how many of them are done (the Checklist). */
  progress?: boolean;
}

export interface ListFieldRoles {
  title?: ListField;
  date?: ListField;
  span?: ListField;
  dependency?: { field: ListField; direction: 'from' | 'to' };
  lane?: ListField;
  group?: ListField;
  link?: ListField;
  /** The field holding each record's notes as a document. */
  body?: ListField;
  /** The field holding each record's picture (a thumbnail field): a gallery draws it as the tile. */
  image?: ListField;
  /** The field whose values say whether an item is done, and which of its values do (a checklist ticks them). */
  done?: { field: ListField; values: readonly string[] };
  numbers: readonly ListField[];
}

const NUMBER_KINDS = new Set(['number', 'bytes', 'duration']);
/** A linking field's additional payload key with the ids it references, for views that draw relationships. */
export const LINK_IDS = ':ids';
// The rule kinds whose value is several values at once (the shared rule filter's `tags`: a list's tags and links).
const MANY_KINDS = new Set(['tags']);
const isDate = (field: ListField) => field.kind === 'date' || field.ruleKind === 'date';
const holdsMany = (field: ListField) => MANY_KINDS.has(field.ruleKind ?? '');
const declaresValues = (field: ListField) => Boolean(field.values && Object.keys(field.values).length > 0);

/** The values of a field that mean an item is done. A field that declares `settles` is the declared owner of that answer:
 * done on exactly those values, the ones a row keeps once it holds them. Only a field that declares no `settles` falls
 * back to the done rule of views-offered-to-every-list.json `done`: a value carrying one of the done tones, or named (by
 * id or label, without case) one of the done words. */
export function doneValuesOf(field: Pick<ListField, 'values' | 'settles'>, done: Pick<OfferedViewRow, 'done_tones' | 'done_values'>): string[] {
  if (Array.isArray(field.settles)) return [...field.settles];
  const tones = new Set(done.done_tones ?? []);
  const names = new Set((done.done_values ?? []).map(name => name.toLowerCase()));
  return Object.entries(field.values ?? {})
    .filter(([id, value]) => (value.tone && tones.has(value.tone)) || names.has(id.toLowerCase()) || names.has((value.label ?? '').toLowerCase()))
    .map(([id]) => id);
}

/** What each field is for: the first names a record; the first date places it in time; fields that declare their
 * values and may group sort records into lanes (the first) and swimlanes (the second, or the first when it is the
 * only one); a field of kind `parent` holds the record it sits under; number-like fields are summed. */
export function listFieldRoles(fields: readonly ListField[], done: Pick<OfferedViewRow, 'done_tones' | 'done_values'> = {}): ListFieldRoles {
  const image = fields.find(field => field.kind === 'thumbnail');
  const [title, ...rest] = fields.filter(field => field !== image);
  const doneValues = (field: ListField) => doneValuesOf(field, done);
  const doneField = rest.find(field => doneValues(field).length > 0);
  const linking = rest.find(field => field.links);
  const grouping = rest.filter(field => field.groupable !== false && declaresValues(field) && !isDate(field));
  return {
    title,
    date: rest.find(isDate),
    span: rest.filter(isDate)[1],
    ...(linking?.links ? { dependency: { field: linking, direction: linking.links.direction as 'from' | 'to' } } : {}),
    lane: grouping[0],
    group: grouping[1] ?? grouping[0],
    link: rest.find(field => field.kind === 'parent'),
    body: rest.find(field => field.document === true),
    image,
    ...(doneField ? { done: { field: doneField, values: doneValues(doneField) } } : {}),
    numbers: rest.filter(field => NUMBER_KINDS.has(field.ruleKind ?? '')),
  };
}

/** Whether a list with these fields can draw this view; a list that nests its records has the link a tree draws. */
export function listCanDraw(row: OfferedViewRow, fields: readonly ListField[], nested = false): boolean {
  const roles = listFieldRoles(fields, row) as unknown as Record<string, unknown>;
  return row.needs.every(role => Boolean(roles[role]) || (role === 'link' && nested));
}

const readOf = (field: ListField, record: any) => (field.read ? field.read(record) : record?.[field.id]);

function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(plain).filter(item => item !== null && item !== '');
  if (typeof value === 'object') {
    const named = (value as any).label ?? (value as any).name ?? (value as any).title ?? (value as any).id;
    return named === undefined ? null : String(named);
  }
  return value;
}

/** A date field's value as a calendar instant: the fact it compares when it has one (milliseconds), else its value. */
function dateOf(field: ListField, record: any): string | null {
  const fact = field.factValue ? field.factValue(record) : undefined;
  const value = typeof fact === 'number' ? new Date(fact) : readOf(field, record);
  if (typeof value === 'string') return Number.isFinite(Date.parse(value)) ? value : null;
  const date = value instanceof Date ? value : typeof value === 'number' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/** A field's declared values as the model's domain. A value the list marks done (roles.done) carries the success tone,
 * the one way the ported surface knows an item is done (field-editors completionLane), even when the list names it
 * "Done" and gives it no tone. */
function domainOf(field: ListField, doneValues: ReadonlySet<string>) {
  if (!declaresValues(field)) return undefined;
  return {
    values: Object.entries(field.values!).map(([id, value], order) => ({
      id, label: value.label ?? id, order, ...(doneValues.has(id) ? { tone: 'success' } : value.tone ? { tone: value.tone } : {}),
    })),
    open: true,
  };
}

const ROLE_SLOTS: readonly (keyof Omit<ListFieldRoles, 'numbers' | 'done' | 'dependency' | 'span'>)[] = ['title', 'date', 'lane', 'link', 'body', 'image'];

/** The list as visual-database input: one record row per record (its identity as the address), one field descriptor
 * per field with the role it plays, and the one view this row draws. */
/** Each record's parents and the records under each record, in order, read from the list's group graph. */
export function nestingFromGroupGraph(nesting: ListNesting): { parents: Map<string, string[]>; children: Map<string, string[]> } {
  return nestedByIdentity(nesting.graph, nesting.identityOf);
}

/** The payload field holding the record a record sits under: none (null), one (its id) or several (their ids), the
 * shapes the surface itself writes when it adds a record under another. */
export const NESTED_UNDER = 'nested-under';
const underValue = (parents: readonly string[]): string | string[] | null => (parents.length === 0 ? null : parents.length === 1 ? parents[0]! : [...parents]);

/** Records in the order a nested list reads: each record that sits under none, in the list's order, then the records
 * under it in their order, depth first; a record under several shows where it is first reached. */
function nestedOrder(records: readonly any[], identify: (record: any) => string, nested: ReturnType<typeof nestingFromGroupGraph>): any[] {
  const byId = new Map(records.map(record => [identify(record), record]));
  const out: any[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    out.push(byId.get(id));
    for (const child of nested.children.get(id) ?? []) visit(child);
  };
  for (const record of records) if (!(nested.parents.get(identify(record)) ?? []).some(parent => byId.has(parent))) visit(identify(record));
  for (const record of records) visit(identify(record));
  return out;
}

/** Each record's payload as the visual-database model reads it: every field's value, and where it nests. */
export function listRecordPayloads(context: ListContext): { id: string; payload: Record<string, unknown> }[] {
  const nested = context.nesting ? nestingFromGroupGraph(context.nesting) : null;
  const ordered = nested ? nestedOrder(context.records, context.identify, nested) : context.records;
  // A field linking records names each by the list's own name for it (its first field), an id the list does not hold
  // as itself.
  const [title] = context.fields;
  const byId = new Map(context.records.map(record => [context.identify(record), record]));
  const named = (value: unknown): unknown => {
    const one = (id: unknown) => {
      const linked = byId.get(String(id));
      const name = linked && title ? plain(readOf(title, linked)) : null;
      return typeof name === 'string' && name ? name : id;
    };
    return Array.isArray(value) ? value.map(one) : value === null || value === undefined ? value : one(value);
  };
  return ordered.map(record => {
    const id = context.identify(record);
    const payload: Record<string, unknown> = {};
    for (const field of context.fields) {
      payload[field.id] = field.pictureUrl ? field.pictureUrl(record) : isDate(field) ? dateOf(field, record) : plain(field.links ? named(readOf(field, record)) : readOf(field, record));
      if (field.links) payload[`${field.id}${LINK_IDS}`] = plain(readOf(field, record));
    }
    if (nested) payload[NESTED_UNDER] = underValue(nested.parents.get(id) ?? []);
    return { id, payload };
  });
}

export function visualDatabaseInputFromList(context: ListContext, row: OfferedViewRow): DecodeVisualDatabaseInput {
  const roles = listFieldRoles(context.fields, row);
  const doneOf = (field: ListField) => new Set(roles.done?.field === field ? roles.done.values : []);
  const nested = Boolean(context.nesting);
  const writable = Boolean(context.write);
  if (nested) roles.link = undefined;
  const roleOf = new Map<string, string>();
  for (const slot of ROLE_SLOTS) {
    const field = roles[slot];
    if (field && !roleOf.has(field.id)) roleOf.set(field.id, slot);
  }
  const wants = new Set(row.wants ?? []);
  if (wants.has('span') && roles.span && !roleOf.has(roles.span.id)) roleOf.set(roles.span.id, 'span');
  const dependency = wants.has('dependency') ? roles.dependency : undefined;
  const groupFieldId = roles.group && roles.group !== roles.lane ? roles.group.id : null;
  if (groupFieldId) roleOf.set(groupFieldId, 'group');
  // At the zoom step that shows the name alone, every part a view draws as a fact beside the name (a date, people, a
  // second grouping) is dropped unless the view needs it to draw at all.
  const nameAlone = context.detail?.fields === 0;
  const keeps = new Set<string>(['title', 'link', 'lane', 'body', ...row.needs, ...wants]);
  const partOf = (field: ListField): string => {
    if (field.id === context.nesting?.field) return 'nesting';
    const part = roleOf.get(field.id) ?? (holdsMany(field) ? 'badge' : 'none');
    return nameAlone && !keeps.has(part) ? 'none' : part;
  };
  const descriptors = [
    { id: 'record-id', label: 'Id', role: 'id', paths: [['id']], editable: false },
    ...context.fields.map(field => ({
      id: field.id,
      label: field.label,
      // A field holding several values (people on a task, its tags) that plays no other part draws as chips on each row.
      role: partOf(field),
      paths: [['payload', field.id]],
      editable: writable && field.editable !== false && (!isDate(field) || wants.has('reschedule')),
      ...(isDate(field) ? { shape: 'temporal' } : NUMBER_KINDS.has(field.ruleKind ?? '') ? { shape: 'number' } : holdsMany(field) ? { shape: 'multi' } : {}),
      ...(domainOf(field, doneOf(field)) ? { domain: domainOf(field, doneOf(field)) } : {}),
      groupable: field.groupable !== false,
    })),
    // A list whose one grouping field sorts both lanes and swimlanes reads it twice: once as the lane, once as the group.
    ...(roles.group && roles.group === roles.lane && !(nameAlone && !keeps.has('group'))
      ? [{ id: `${roles.group.id}-swimlane`, label: roles.group.label, role: 'group', paths: [['payload', roles.group.id]], editable: false, groupable: false }]
      : []),
    ...(dependency
      ? [{ id: `${dependency.field.id}${LINK_IDS}`, label: dependency.field.label, role: `dependency-${dependency.direction}`, paths: [['payload', `${dependency.field.id}${LINK_IDS}`]], editable: false, groupable: false }]
      : []),
    ...(nested
      ? [
        { id: NESTED_UNDER, label: 'Under', role: 'link', paths: [['payload', NESTED_UNDER]], editable: writable, groupable: false },
      ]
      : []),
  ];
  const records = listRecordPayloads(context).map(({ id, payload }) => ({ id, address: id, payload }));
  return {
    records,
    fields: { descriptors },
    views: { views: [{ ...viewDescriptor(row, roles, context.label, nested), ...sectionsOf(context) }] },
    actions: { actions: [] },
  };
}

/** The one view this row draws. Every view carries the list's time axis and its summary: a view reads what its kind
 * reads (a timeline its date field, a summary its metrics) and leaves the rest. */
function viewDescriptor(row: OfferedViewRow, roles: ListFieldRoles, label: string, nested: boolean) {
  // The summary: the records sorted by the field that says where each stands (what marks it done, else its first
  // grouping), then each number-like field's total and average. A list with no such field counts its records.
  const overviewField = roles.done?.field ?? roles.lane ?? roles.group;
  const numbers = roles.numbers.map(field => ({
    id: `${field.id}-totals`, atom: 'stat-strip', label: field.label, values: [
      { id: `${field.id}-sum`, label: 'Total', aggregation: { op: 'sum', fieldId: field.id }, format: 'decimal' },
      { id: `${field.id}-average`, label: 'Average', aggregation: { op: 'average', fieldId: field.id }, format: 'decimal' },
    ],
  }));
  const count = { id: 'count', atom: 'snapshot-card', label, values: [{ id: 'count', label, aggregation: { op: 'count' }, format: 'integer' }], presentation: { emphasis: 'dominant' } };
  return {
    id: row.id, label: row.label, kind: row.kind, order: 0,
    ...(row.icon ? { icon: row.icon } : {}),
    ...(roles.date ? { dateField: roles.date.id } : {}),
    ...(row.zoom ? { zoom: row.zoom } : {}),
    ...(row.progress ? { progress: true } : {}),
    ...(overviewField ? { overview: { field: overviewField.id } } : {}),
    ...topologyOf(roles, nested, overviewField),
    metrics: overviewField ? numbers : [count, ...numbers],
  };
}

/** The fields the list is grouped by that it describes, as the view's sections. */
function sectionsOf(context: ListContext) {
  const sections = (context.groupLevels ?? []).map(level => level.field).filter(id => context.fields.some(field => field.id === id));
  return sections.length ? { sections } : {};
}

/** The list as a node graph (the shared node-graph's topology descriptor): each record a node named by its title and
 * coloured by where it stands, and a line from each record to the records it sits under (the list's nesting, else its
 * field of kind `parent`). A list with neither has nodes and no lines. */
function topologyOf(roles: ListFieldRoles, nested: boolean, standing: ListField | undefined) {
  const under = nested ? NESTED_UNDER : roles.link?.id;
  return {
    topology: {
      nodeSources: [{ id: 'id', ...(roles.title ? { label: `payload.${roles.title.id}` } : {}), ...(standing ? { status: `payload.${standing.id}` } : {}) }],
      ...(under ? { edgeSources: [{ from: `payload.${under}`, to: 'id' }] } : {}),
    },
  };
}
