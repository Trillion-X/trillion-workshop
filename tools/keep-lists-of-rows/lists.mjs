// src/lists.mjs
//
// Purpose: a person's lists. A list is a record that describes rows (its label, its fields, which field names a row,
// which kind of record its rows are); the rows are the person's own records of that kind (src/your-records.mjs,
// `record:<row_type>:<id>`), so a list over rows a tool already keeps (customers, customer steps) shows them as they
// are, and a row put here is a record any tool reading that kind finds. A field may link to another list; its value is
// that list's row ids, read back with each linked row's name. A CRM, a list of customers, the AIs in a space or a
// reading list are each one list record: nothing here knows any of them.
//
//   GET  /lists                      { lists }                   each list with how many rows it holds
//   GET  /lists/<list>               { list, rows, field_kinds } one list, its rows with linked rows' names
//   GET  /lists/<list>?view=<view>   the same, holding only the rows its saved view's rules keep (the formula engine's)
//   POST /lists                      { id?, label, ... }         keeps a list (a new one, or its changed fields)
//   POST /lists/<list>/rows          { rows?, remove? }          keeps rows (values merge into the row) and removes rows
//                                    The same request may also name rows by who they are (`match_on`: field ids, in priority order) or
//                                    by a selection (`select`: a saved view, the rows left out, the rows added, and the values or remove),
//                                    which src/list-row-operations.mjs turns into these plain row requests first.
//   POST /lists/<list>/rows/preview  { rows?, remove? }          what the same put would do, written nowhere (previewRows)
//   POST /lists/<list>/merge         { base_id, target_id, ... } folds one row into another and follows every link to it
//   POST /lists/<list>/duplicate     { row_ids, values? }        copies rows field by field as the list's DATA says
//   POST /lists/<list>/aggregate     { view_id?, measures, group_by? }  totals over the list or a saved view, by the formula engine
//   GET  /lists/<list>/backlinks?row_id=   who links to a row, in every list
//   GET  /lists/<list>/removed?limit=&cursor=   rows removed in the last history.trash_days, newest first
//   POST /lists/<list>/rows/restore  { row_ids }                 puts removed rows back as they were, from the log
//   GET  /lists/<list>/field-at?field_id=&at=&row_ids=   one field of many rows as it was at a moment
//   POST /lists/<list>/snapshots     { view_id? }                holds a view's ids still; GET /lists/<list>/snapshots/<id>?from=&count=
//   POST /lists/<list>/views/<view>/move  { anchor_id, placement }   orders one saved view
//   GET  /lists/<list>/field-history?row_id=&field_id=   the values a keeps_history field held, as lines with who and by which road
//   POST /lists/<list>/review        { action, row_ids?, owner?, expires_days? }   sets a list up for review, or verifies, flags,
//                                    asks for verification of, or assigns rows (src/list-review.mjs, lists.json review)
//   GET  /lists/<list>/needs-review?owner=   the rows each owner must look at, with why, from the review views
//   POST /lists/<list>/rows/use      { row_ids }                 a use of rows: their heat grows (lists.json use_heat)
//   GET  /lists/<list>/cold?owner=&cursor=   rows nobody uses, leaving out rows whose review is current
//   POST /lists/<list>/proposals     { rows, remove?, editable, scopes?, evidence?, note?, proposal_id? }   an AI's change kept
//                                    for a person (src/list-proposals.mjs); GET .../proposals?status=&cursor= and .../proposals/<id> read them
//   POST /lists/<list>/proposals/<id>/decide  { decision }       approve (applied once, all or nothing), decline, withdraw, remove
//   GET  /lists/file-names?name=     which rows name a file by where it is; POST /lists/file-names { from, to } follows it
//   POST /lists/<list>/ensure        { label, ... }              makes the list once if it is missing (a form's "new <kind>" row)
//   GET  /lists/search?q=&lists=a,b&row_types=x,y&holds=people&limit=  { rows }  rows across lists, ranked by how well they match q:
//                                    [{ id, list_id, list_label, title, detail }]; a list named that does not exist is skipped;
//                                    `holds` also searches every list made of what lists.json `holds` names (people: a row type
//                                    of a person, or a field of email or phone), whatever the list is called
//
// Non-Negotiable Invariants:
//   1. Field kinds, limits and every refusal's words are DATA (src/lists.json); nothing here branches on a kind's name,
//      only on what its row says the value is (text, number, texts, row-ids, computed). A computed kind (a formula,
//      a button) keeps no value in rows: its field carries how the value is worked out, under the key its row names.
//   2. A slice of a list (Customers, Leads, people who opened an email) is a saved view on it (a name, a search and
//      filter rules), never a second list over the same people.
//   3. A row is the person's record `record:<row_type>:<id>`: writing a row merges the given values into that record,
//      so values a tool kept there that the list does not show stay as they were. A value of null clears a field.
//   4. A link names rows of the list it links to, never another person's; a link to a missing row reads as that id.
//   5. Every write is one EEAF transaction by the actor who asked; an earlier value stays in the log.
//   6. A field may name values it `settles` on: once a row holds one, a write naming another value keeps it and says
//      so (`settled` in the answer); only null clears it. Finished stays finished however many times it is asked again.
//   7. A list a part of Trillion keeps its own records in is made by `ensure` once, with its starter rows, when it is
//      missing; after that it is the person's, and nothing re-adds a row or a field they removed.
//   8. A search is bounded (limits.search_lists lists, limits.rows_per_read rows each, limits.search_most answers) and ranked
//      by title (exact, then prefix, then a word's start, then inside, then the row's other words); it reads only lists,
//      never a record kind a list does not name, and a name that is no list is skipped, not refused.
//   9. Reading what is open never depends on what is settled. A list whose field names an `open_index` (a declared index of
//      its row kind that holds only rows whose field is not settled, src/record-indexes.json) and a `starts` value is read
//      with read(id, { open: true }) from that index: the rows it holds, never the settled ones, which only grow. A row put
//      with that field unset (or cleared with null) starts at `starts`, so no open row lacks an entry. Rows written before
//      that gain it open_rows.fill_page at a time (fillOpen), the progress kept as a record; until the fill and the index
//      are both done the read retains its bounded legacy page. The idle scheduler fills old rows; reads never migrate history.
//  10. A field that names a thing is a link to it: a text, choice or tags field whose values are the names of another list's
//      rows (or that names a kind of thing by its id, a company) is moved to a link over that list at idle, its words
//      replaced by row ids (src/naming-fields.mjs, rules in lists.json `naming`). A save or a put into such a field marks
//      the lists to be looked at again; nothing a person reads by its words (title, views, public page, starts, settles) moves.
//  12. A list may declare `balanced` ({ amount_field, group_field, index }): a write that would leave any entry (the rows
//      sharing a group_field value) with amounts not adding to zero is refused inside the same transaction and nothing is
//      written. A row in such a list must have both an amount and an entry, and the lines of one entry are put together.
//  11. A field may carry limits its values keep: min and max (a number field) and max_chars (a text field). A write outside
//      them is refused in plain words and nothing is written. A limit left out is no check, and 0 is a real limit: a
//      credit limit of 0 refuses every amount above it, a field with no max accepts any.
//
//  11. A field may be `required` (a new row holds a value for it, no write clears it), may declare how text is read as a number
//      or a date (`input`, src/list-input-grammar.mjs: a text that does not fit is refused, never guessed), and a kind reduces its
//      values to a shared form for matching (`normalize`, src/list-identity.mjs). All three are DATA on the field and the kind.
//  12. A writer may give the basis of the values it sets (`basis` on a row: confidence, reasoning, sources). It is kept with the row
//      (`_basis`) and dropped when that field is written again without one.
//  13. previewRows runs the same checks and collects the writes instead of making them; it is a method of its own so no layer between a
//      caller and the store can drop an option and turn a preview into a write.
//  14. A saved view may name a path through links (`company.employees`, src/list-paths.mjs) wherever it names a field; the values are read
//      from the lists that own the linked rows for the rows being shown and are never kept in a row.
//  15. A link field may pair with the field on the list it links to that holds the way back (`pairs_with`, src/list-pairs.mjs):
//      every write, removal, restore and merge changes both sides in the same write, each side keeps its own max_links, and a
//      write is refused (`no_write_right`) when its writer may not change every list it touches (`mayWrite`, on the one write road).
//  16. A field may be `unique` (src/list-keys.mjs): each value's shared form is a key record written with the row, so a second row
//      holding it is refused by one point read; rows kept before gain their keys at idle, and a write waits for them by name.
//  17. A removal leaves a trash record and a merge a tombstone (lists.json history): removed rows are listed and put back from the
//      log exactly as they were, an old id answers where it went, and a link written to it lands on the row it became.
//  18. A list that says `stamps: true` keeps who wrote each value (src/list-stamps.mjs) and reads which a machine wrote.
//  19. A saved view is a record of its own (lists.json view_records); views a list kept inside itself are read as before.
//  20. Every write's actor carries the road it came by (`via`, src/write-via.mjs), kept once per change in the log's actor
//      context, on trash records and on stamps, and lines a person reads say it in plain words.
//  21. A field may keep the values it held (`keeps_history`, src/list-value-history.mjs) on its row, bounded, and a `history` field
//      answers value_at, previous_value, value_set_at, time_spent_in and has_been_in from them on every read.
//  22. A list that says `review_changes: true` refuses direct writes from a gated writer (an AI over MCP, lists.json proposals.gated):
//      its changes are proposals a person approves (src/list-proposals.mjs). Off unless the list says it.
//  23. Every write says what it changed: putRows answers `write_set` ({ version, records: [{ id, fields }] }, ids and the fields
//      written, src/record-depends.mjs), and the fields are noted for the store's revision frames (src/live-keys.mjs). A list
//      read answers `depends`, what the rows shown could change by, or null when a read of this list depends on records
//      outside the lists (external row sources, managed rows, rows hidden by the person's rules, measured or related fields),
//      so an open page reads it again only when a change touches it.
//  24. A starting list (one a part of Trillion holds in a store from the moment it opens, `holdStartingList`, its definition
//      in that part's DATA) is read from that DATA, shaped as `save` would keep it, until something is first kept in it: a
//      new account stores no list record for it.
//      The first write naming it (a row, a view, a change of its fields, an index's fill) keeps it first, through `save`, in
//      the same transaction; from then on it is the person's own, and a change to the DATA never alters what they kept.
//
// Security: one person's own store; a list can only name record types (`record:<type>`), never a decision, a pursuit,
// a setting or a payment.
//
import { boundedWalk, refusalWords } from '../bounded-walk.mjs';
import { makeConfigurations, ConfigurationError } from './configurations.mjs';
import { ListsError, listRefusal, listSay } from './list-refusals.mjs';
import { backlinks, duplicateRows, fileReferences, joinAnswers, mergeRows, planRowRequest, resolveRows, rewriteFileNames, withDangling } from './list-row-operations.mjs';
import { documentsFolderOf, readDocumentTypes, saveDocumentTypes } from '../documents-as-list-rows/document-properties.mjs';
import { exportListFiles, importListFiles } from './list-plain-files.mjs';
import { aggregateRows } from './list-aggregates.mjs';
import { isSourceId, pathIdsOf, planPath, sourceNamespacesOf, withPathValues } from './list-paths.mjs';
import { fieldsWritten, noteRecordsWriting } from './live-keys.mjs';
import { bindParameters, parametersOf } from './list-view-parameters.mjs';
import { listFilters, viewsWithFiltersExpanded } from './list-filters.mjs';
import { asViewed, checkRollups, withRollups } from './list-rollups.mjs';
import { viaOf, viaWords } from '../formulas/read-data/write-via.mjs';
import { checkHistoryFields, fieldHistoryOf, historyFieldsOf, historyKeptBy, historyValues, historyViewed, keepValueHistory } from '../formulas/read-data/list-value-history.mjs';
import { gatedWriter, listProposals } from './list-proposals.mjs';
import { coldRows, reviewRows, rowsNeedingReview, usedHeat } from '../review-what-a-list-says/read-data/list-review.mjs';
import { checkRelationships, relationshipFieldsOf, relationshipReader, relationshipViewed } from './list-relationships.mjs';
import { readSnapshot, snapshotPages, takeSnapshot } from './list-snapshots.mjs';
import data from './lists.json' with { type: 'json' };
import { recordText, validRecordField } from '../parts/ui/show/record-picker/record-value.ts';
import { normalizeDeclaredIndexes } from '../record-log/do-work/record-model.mjs';
import { entityIndexWritten, entityIndexWrites, entityListChanged, entityListRemoved } from './entity-mentions.mjs';
import { progressForListRow } from './work-progress.mjs';
import { markNamingDue, namesWritten } from './naming-fields.mjs';
import { handleSettlementRequest, REPORT_BASES, SETTLEMENT_SCALE, unitsOf } from './list-settlements.mjs';
import { normalizeSavedView, projectSavedView } from './read-data/saved-view-engine.mjs';
import { isOrderKey, keyBetween } from './do-work/fractional-order.ts';
import { grammarWords, inputDeclarationFits, readDate, readNumber } from './list-input-grammar.mjs';
import { keyFieldsOf, matchable, normalizerNames, withKeyValues } from './list-identity.mjs';
import { checkPairs, pairWrites } from './list-pairs.mjs';
import { addsForms, fillPage, formsOf, keyRecordId, keysMarkId, keysSignature, keyWrites, uniqueFields } from './list-keys.mjs';
import { machineWritten, stampedValue } from './list-stamps.mjs';
import { readAt } from '../record-log/do-work/record-time.mjs';
import { ListTransferError, transferRows } from './list-row-transfer.mjs';

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const KINDS = new Map(data.field_kinds.map(kind => [kind.id, kind]));
const { limits } = data;

export { ListsError, listRefusal, listSay };
const say = listSay;
const readPageLimit = requested => {
  const numeric = requested === undefined ? limits.read_page_rows : Number(requested);
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw say('bad_row', { index: 'limit' });
  return Math.min(numeric, limits.read_page_rows);
};
const decodeOrderCursor = cursor => {
  if (cursor === undefined) return null;
  if (cursor.startsWith('id:') && cursor.length > 3) return { fallback: cursor.slice(3) };
  try {
    const tuple = JSON.parse(decodeURIComponent(cursor));
    if (Array.isArray(tuple) && tuple.length === 2 && isOrderKey(tuple[0]) && typeof tuple[1] === 'string' && tuple[1]) return tuple;
  } catch { /* refused below */ }
  throw say('bad_row', { index: 'cursor' });
};
const encodeOrderCursor = (value, rowId) => encodeURIComponent(JSON.stringify([value, rowId]));

const slugOf = text => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
// A list is named by its slug ("trillion-crm") or its record id ("list:trillion-crm").
const listKey = id => {
  const slug = String(id ?? '').replace(/^list:/, '');
  if (!NAME.test(slug)) throw say('bad_id', { id: JSON.stringify(id) });
  return slug;
};
const recordId = slug => `${data.record_type}:${slug}`;

// The starting lists each store holds before it keeps them (invariant 24), by slug, each definition its owner's DATA.
const startingByStore = new WeakMap();
// Each starting list as `save` keeps it, shaped once per definition: the shape reads nothing but its DATA.
const startingShapes = new WeakMap();
/** A part of Trillion that holds `definition` (a list as `save` takes it, with its id) in the records `eeaf` names it
 *  as a starting list there (invariant 24): read from the DATA until something is first kept in it. */
export function holdStartingList(eeaf, definition) {
  if (!startingByStore.has(eeaf)) startingByStore.set(eeaf, new Map());
  startingByStore.get(eeaf).set(listKey(definition.id), definition);
}
const rowPrefix = type => `record:${type}:`;
// A row named by its record id (record:<row_type>:<id>, as a rule or a record link names it) is the same row as its id.
const ownRowId = (list, rowId) => typeof rowId === 'string' && rowId.startsWith(rowPrefix(list.row_type)) ? rowId.slice(rowPrefix(list.row_type).length) : rowId;

// What a list holds (lists.json `holds`): the rule for a name, else null; whether a list is made of it (its row type is
// one of the rule's, or any of its fields has a kind in the rule's).
const holdsNames = Object.keys(data.holds).filter(name => !name.startsWith('_')).join(', ');
const holdsRule = name => (typeof name === 'string' && !name.startsWith('_') && Object.hasOwn(data.holds, name) ? data.holds[name] : null);
const holdsList = (name, list) => {
  const rule = holdsRule(name);
  return Boolean(rule && list && (rule.row_types.includes(list.row_type) || (list.fields ?? []).some(field => rule.field_kinds.includes(field.kind))));
};

// Whether one value fits what its kind's row says the value is.
const fits = {
  text: value => typeof value === 'string',
  number: value => typeof value === 'number' && Number.isFinite(value),
  texts: value => Array.isArray(value) && value.every(item => typeof item === 'string'),
  'row-ids': value => Array.isArray(value) && value.every(item => typeof item === 'string' && item && !item.includes('/')),
  // A computed field (a formula, a button) keeps no value: it is worked out from what its field carries.
  computed: () => false,
  // A rule tree (the formula engine's filter shape): a group of rules and groups.
  rule: value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && value.kind === 'group' && Array.isArray(value.rules),
  // A check of what is true now (src/done-when.mjs): { over, match, tree, says }; which sources and operators it may name is refused there, in plain words.
  'done-rule': value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof value.over === 'string' && typeof value.match === 'string' && typeof value.says === 'string' && fits.rule(value.tree),
};
const expected = { text: 'text', number: 'a number', texts: 'a list of texts', 'row-ids': 'a list of row ids', computed: 'kept: its value is worked out, so it takes none', rule: 'a rule group { kind: "group", combinator, rules: [...] }',
  'done-rule': 'a check { over: <facts source id>, match: "all" | "any" | "none", tree: <rule group>, says: <words of what is counted> }' };
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Conditions compare JSON values, not object insertion order. null means the cleared/absent field.
const sameValue = (left, right) => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  if (!isObject(left) || !isObject(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
};
// A single text where a list of texts or ids is meant is read as that one item.
const shape = (valueKind, value) => ((valueKind === 'texts' || valueKind === 'row-ids') && typeof value === 'string' ? [value] : value);

// The two-stage limit (lists.json limit_notes): what a write used of each limit it names, as warnings for those past the
// share that still succeed. A write past the limit is refused where it is counted (`too_many`).
const nearLimits = used => Object.entries(used).flatMap(([key, count]) => {
  const note = data.limit_notes[key];
  return note && limits[key] && count >= Math.ceil(limits[key] * limits.warn_share) && count <= limits[key]
    ? [{ limit: key, used: count, of: limits[key], says: say('limit_near', { what: note.what, used: count, limit: limits[key], remedy: note.remedy }).message }] : [];
});
// A text given for a number or a date field, read as the field's declared input grammar says (src/list-input-grammar.mjs);
// anything the grammar does not apply to is returned as given, so the kind's own check still decides.
const NUMBERISH = /^[-+]?[\d.,\s]*\d[\d.,\s]*$/;
const readInput = (field, valueKind, given, rowId) => {
  if (KINDS.get(field.kind)?.record_pick && typeof given === 'string') given = recordText(given);
  if (typeof given !== 'string') return given;
  const kind = KINDS.get(field.kind);
  if (valueKind === 'number') {
    if (!field.input?.decimal && !NUMBERISH.test(given.trim())) return given;
    const read = readNumber(given, field.input);
    if (read.refused) throw say(read.refused, { row_id: rowId, field_id: field.id, text: JSON.stringify(given), decimal: JSON.stringify(read.decimal ?? '') });
    return read.value;
  }
  if (kind?.ruleKind === 'date' && field.input?.date_order) {
    const read = readDate(given, field.input);
    if (read.refused) throw say(read.refused, { row_id: rowId, field_id: field.id, text: JSON.stringify(given), order: read.order });
    return read.value;
  }
  return given;
};
// The basis a writer gives for the values it sets: why each is what it is, from what, and how sure ({ field_id: { reasoning?,
// sources?, confidence } }). It is kept beside the row (`_basis`), so a person can open why a value is what it is, and it
// is dropped when that field's value is next written without one.
const BASIS_CONFIDENCE = ['high', 'medium', 'low'];
const checkBasis = (basis, fields, written, rowId, actor, now) => {
  if (basis === undefined) return {};
  if (!isObject(basis)) throw say('bad_row_basis', { row_id: rowId, field_id: '', sources: limits.basis_sources });
  const out = {};
  for (const [fieldId, entry] of Object.entries(basis)) {
    if (!fields.has(fieldId) || !Object.hasOwn(written, fieldId) || written[fieldId] === null) throw say('unknown_field', { row_id: rowId, field_id: fieldId, list_id: 'this write' });
    const sources = entry?.sources;
    if (!isObject(entry) || !BASIS_CONFIDENCE.includes(entry.confidence)
      || (entry.reasoning !== undefined && (typeof entry.reasoning !== 'string' || entry.reasoning.length > limits.basis_chars))
      || (sources !== undefined && (!Array.isArray(sources) || sources.length > limits.basis_sources || sources.some(item => typeof item !== 'string' || item.length > limits.basis_chars))))
      throw say('bad_row_basis', { row_id: rowId, field_id: fieldId, sources: limits.basis_sources });
    out[fieldId] = { confidence: entry.confidence, ...(entry.reasoning ? { reasoning: entry.reasoning } : {}), ...(sources?.length ? { sources } : {}), by: actor?.by ?? 'lists', at: now };
  }
  return out;
};

// Each list's write count, per store: every write naming a list (its rows, its definition, its open index) adds one, so a
// reader can keep what it read of a list for as long as the count stands (src/done-when-index.mjs). Every makeLists over
// one store shares the count, so it lives beside the store rather than in the call. Each list also keeps the record ids
// its last few writes touched (`log`), so a reader can ask what changed since its count (writtenSince, openChanges).
const revisionsOf = new WeakMap();
// Runs next once value is ready: at once for a synchronous write, after its promise for a store's.
const thenOr = (value, next) => value?.then ? value.then(next) : next(value);
const runsOf = new WeakMap();

// `mayWrite(list_id, actor)` (optional) is who may change which list: every write of every list a request touches (its rows,
// the other side of a paired link, a link detached from a removed row) asks it on the one road writes take, so a pair is
// written only by someone who may write both lists. Without it, whoever reaches this store may write its lists.
export function makeLists({ eeaf, newId = () => crypto.randomUUID(), progressOfReference = () => null, hidden = null, mayWrite = null,
  transaction = fn => typeof eeaf.atomically === 'function' ? eeaf.atomically(fn) : fn(),
  writeMutation = (records, context, { alongside = [] } = {}) => eeaf.write([...records, ...alongside], context) }) {
  // A list record as the lists read it (invariant 24): as kept, or, for a starting list not kept yet, as its DATA says.
  const keptList = slug => eeaf.read(recordId(slug));
  const startingAt = id => (typeof id === 'string' && id.startsWith(`${data.record_type}:`) ? startingShape(id.slice(data.record_type.length + 1)) : null);
  const listAt = id => { const value = eeaf.read(id); return value ?? startingAt(id) ?? value; };
  // The ids of the lists, with each starting list not kept yet: unpaged in id order, paged (`before`, `limit`) newest id
  // first below `before`, as the store answers its own.
  const listIds = options => {
    // reads-ok: a person keeps at most limits.lists_per_person lists (refused past it in the write path), so the unpaged read is O(that limit).
    const kept = options === undefined ? eeaf.ids(data.record_type) : eeaf.ids(data.record_type, options);
    const extra = [...(startingByStore.get(eeaf)?.keys() ?? [])].map(recordId).filter(id => !kept.includes(id) && !keptList(id.slice(data.record_type.length + 1)));
    if (!extra.length) return kept;
    if (options?.before === undefined && options?.limit === undefined) return [...kept, ...extra].sort();
    const below = extra.filter(id => options.before === undefined || id < options.before);
    return [...kept, ...below].sort().reverse().slice(0, Math.max(1, Math.floor(Number(options.limit) || 100)));
  };
  let self = null;
  // A saved view kept as a record of its own (lists.json view_records): { list_id, view, order }. A list's views are the
  // ones it kept inside itself before, in their order, then its own records in theirs.
  const viewPrefix = slug => `${data.view_records.type}:${slug}:`;
  const viewRecordId = (slug, viewId) => `${viewPrefix(slug)}${viewId}`;
  const viewRecords = slug => {
    const ids = eeaf.ids(data.view_records.type, { prefix: viewPrefix(slug), limit: limits.views_per_list + 1 }).filter(id => id.startsWith(viewPrefix(slug)));
    return ids.map(id => ({ id, ...eeaf.read(id) })).filter(row => row.view && isOrderKey(row.order))
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
  };
  const viewsOf = (slug, stored) => {
    const own = viewRecords(slug);
    const named = new Set(own.map(row => row.view.id));
    return [...(stored?.views ?? []).filter(view => !named.has(view.id)), ...own.map(row => row.view)];
  };
  const filterOwner = () => listFilters({ eeaf, write, readList, listKey, slugOf, viewsOf: slug => viewsOf(slug, listAt(recordId(slug))) });
  const withViews = (slug, stored) => {
    const views = viewsOf(slug, stored);
    const { views: _embedded, ...rest } = stored;
    return { id: slug, ...rest, ...(views.length ? { views } : {}) };
  };
  const readList = slug => {
    const list = listAt(recordId(slug));
    if (!list) throw say('no_list', { list_id: slug });
    return withViews(slug, list);
  };
  if (!revisionsOf.has(eeaf)) revisionsOf.set(eeaf, new Map());
  const revisions = revisionsOf.get(eeaf);
  if (!runsOf.has(eeaf)) runsOf.set(eeaf, crypto.randomUUID());
  const run = runsOf.get(eeaf);
  // The one road a list write takes, so its count moves whenever the list does (a write with no list names none).
  // While previewRows runs (one synchronous call, so nothing else interleaves) no write is made: the records a write
  // would have kept are collected instead.
  let preview = null;
  // The records an outermost putRows has written so far, with the fields written, for its `write_set` (invariant 23).
  let writeSet = null;
  // A preview has nothing to roll back, so it runs outside the store's transaction (which would forget its caches on a refusal).
  const atomic = work => preview ? work() : transaction(work);
  const mustWrite = (listId, actor) => { if (mayWrite && !mayWrite(listId, actor ?? null)) throw say('no_write_right', { list_id: listId }); };
  const write = (records, context, options = {}) => {
    if (options.list_ref && !preview) keepStartingFirst(options.list_ref, records, context);
    if (options.list_ref) mustWrite(options.list_ref.slice(data.record_type.length + 1), context?.actor);
    if (preview) {
      preview.writes.push(...records);
      return { transaction_id: null };
    }
    if (options.list_ref) {
      const kept = revisions.get(options.list_ref) ?? { revision: 0, log: [] };
      kept.revision += 1;
      kept.log.push({ revision: kept.revision, ids: [...records, ...(options.alongside ?? [])].map(record => record.id) });
      if (kept.log.length > limits.changes_kept) kept.log.shift();
      revisions.set(options.list_ref, kept);
    }
    if (writeSet) {
      // What each record held before, read together: one at a time, a record not kept yet costs a read of every run.
      const before = records.length > 1 && typeof eeaf.readMany === 'function' ? eeaf.readMany(records.map(record => record.id)) : null;
      for (const record of records) writeSet.push({ id: record.id, fields: fieldsWritten(before ? before.get(record.id) : eeaf.read(record.id), record.value) });
    }
    const noted = noteRecordsWriting(eeaf, records);
    const written = writeMutation(records, context, options);
    noted?.();
    return written;
  };
  // The record ids a list's writes touched after its count `since`, or null when the kept writes no longer reach back there.
  const writtenSince = (slug, since) => {
    const kept = revisions.get(recordId(slug)) ?? { revision: 0, log: [] };
    if (since === kept.revision) return [];
    if (!kept.log.length || kept.log[0].revision > since + 1) return null;
    return kept.log.filter(entry => entry.revision > since).flatMap(entry => entry.ids);
  };
  // Opaque per-list token: a token for one list must never be accepted as another list's revision.
  const changesSince = (id, held) => {
    const slug = listKey(id);
    const list = readList(slug);
    const kept = revisions.get(recordId(slug)) ?? { revision: 0, log: [] };
    const sequence = typeof eeaf.changeSeq === 'function' ? eeaf.changeSeq() : null;
    const token = `${run}.${slug}.${kept.revision}.${sequence ?? 'unknown'}`;
    const reset = { list_id: slug, token, reset: true, row_ids: null };
    if (list.row_sources?.length) return reset; // An external row source has no sequence in this store's journal.
    const at = typeof held === 'string' ? /^([^.]+)\.([a-z0-9-]{1,64})\.(\d+)\.(\d+)$/.exec(held) : null;
    if (!at || at[1] !== run || at[2] !== slug || !Number.isSafeInteger(Number(at[3])) || Number(at[3]) > kept.revision
      || sequence === null || !Number.isSafeInteger(Number(at[4])) || Number(at[4]) > sequence || typeof eeaf.changedSince !== 'function') return reset;
    const written = writtenSince(slug, Number(at[3]));
    const changed = eeaf.changedSince(Number(at[4]));
    if (!written || !changed || written.includes(recordId(slug))) return reset;
    const prefix = rowPrefix(list.row_type);
    // Tools write these same records without entering makeLists. Use the shared store's journal too; any other
    // kind may affect linked labels or computed fields, so an unknown dependency requires the whole list again.
    const known = new Set(written);
    if (changed.some(id => !id.startsWith(prefix) && !known.has(id))) return reset;
    return { list_id: slug, token, reset: false, row_ids: [...new Set([...written, ...changed].filter(recordId => recordId.startsWith(prefix)).map(recordId => recordId.slice(prefix.length)))] };
  };
  const recentRowIds = (type, limit) => eeaf.ids(`record:${type}`, { limit })
    .reverse().map(id => id.slice(rowPrefix(type).length));
  // The field that keeps a list's open rows in a declared index (invariant 9), or null; the record that says the rows
  // written before it existed have been given their start value; whether both that and the index's own build are done.
  const openFieldOf = list => list.fields?.find(field => field.open_index && field.starts !== undefined) ?? null;
  const fillMarkId = slug => `${data.open_rows.mark_type}:${slug}`;
  const typeOfRows = list => `record:${list.row_type}`;
  const fillSignature = (list, field) => JSON.stringify([list.row_type, field.id, field.starts, field.open_index]);
  const fillState = (slug, list, field) => {
    const mark = eeaf.read(fillMarkId(slug));
    return mark?.signature === fillSignature(list, field) ? mark : { before: null, done: false };
  };
  const openReady = (slug, list, field) => fillState(slug, list, field).done === true && eeaf.indexReady(typeOfRows(list), field.open_index);
  const orderMarkId = slug => `${data.open_rows.mark_type}:ordering-${slug}`;
  const orderFieldOf = list => {
    const index = list.ordering && list.indexes?.find(candidate => candidate.name === list.ordering.index);
    const field = index?.fields?.length === 1 ? list.fields.find(candidate => candidate.id === index.fields[0]) : null;
    return field?.kind === 'text' ? field : null;
  };
  const orderSignature = (list, field) => JSON.stringify([list.row_type, list.ordering.index, field.id]);
  const orderState = (slug, list, field) => {
    const mark = eeaf.read(orderMarkId(slug));
    if (mark?.signature !== orderSignature(list, field)) return { before: null, done: false };
    return mark;
  };
  const listOrderReady = (slug, list) => {
    const field = orderFieldOf(list);
    return Boolean(field && orderState(slug, list, field).done === true
      && (typeof eeaf.indexReady !== 'function' || eeaf.indexReady(typeOfRows(list), list.ordering.index)));
  };
  const openRowIds = (list, field) => eeaf.scan(typeOfRows(list), field.open_index, { reverse: true, limit: limits.rows_per_read })
    .map(entry => entry.id.slice(rowPrefix(list.row_type).length)).sort();
  // A link to a row merged away names the row it became: its tombstone's merged_into, followed limits.tombstone_hops times.
  const trashId = (slug, rowId) => `${data.history.trash_type}:${slug}:${rowId}`;
  const tombstoneId = (slug, rowId) => `${data.history.tombstone_type}:${slug}:${rowId}`;
  const heatId = (slug, rowId) => `${data.use_heat.type}:${slug}:${rowId}`;
  const followMerge = (slug, rowId, rowPrefixOfTarget) => {
    let at = rowId;
    for (let hop = 0; hop < limits.tombstone_hops && !eeaf.read(`${rowPrefixOfTarget}${at}`); hop += 1) {
      const next = eeaf.read(tombstoneId(slug, at))?.merged_into;
      if (typeof next !== 'string' || !next) break;
      at = next;
    }
    return at;
  };
  const mergedInto = (targetSlug, ids) => {
    const target = listAt(recordId(targetSlug));
    if (!target) return ids;
    return [...new Set(ids.map(rowId => followMerge(targetSlug, rowId, rowPrefix(target.row_type))))];
  };
  // Who wrote each value, on a list that keeps it (src/list-stamps.mjs): the row's _stamps after `written` ({ field: value or null }).
  const restamp = (value, written, actor) => {
    const next = stampedValue(value, written, actor ?? { by: 'lists' }, new Date().toISOString());
    if (next._stamps) value._stamps = next._stamps; else delete value._stamps;
    return value;
  };
  // What a removed row held just before its removal, from the log (null when the log no longer keeps it). The records
  // handed in answer the row's own log; the newest change to the row decides, so no log position is needed to find it.
  const removedValue = rowRecordId => {
    if (typeof eeaf.log !== 'function') return null;
    const rows = eeaf.log({ record_id: rowRecordId });
    for (const row of [...rows].reverse()) for (const envelope of [...row.envelopes].reverse()) {
      if (envelope.id !== rowRecordId) continue;
      if (!envelope.remove || !envelope.prior?.value) return null;
      return typeof eeaf.resolved === 'function' ? eeaf.resolved(structuredClone(envelope.prior.value), rowRecordId) : structuredClone(envelope.prior.value);
    }
    return null;
  };
  const titleOf = (list, values) => {
    const title = values?.[list.title_field];
    return typeof title === 'string' && title ? title : Array.isArray(title) ? title.join(', ') : null;
  };

  // A link names a list this person keeps: one in this store (`lists`), one their placement keeps in another of their
  // stores (`elsewhere`, resolved by src/placed-lists.mjs keptList), or the same list the field already linked to
  // (`kept`, checked when that link was made).
  function checkFields(fields, lists, ownerSlug, { kept = [], elsewhere = new Set() } = {}) {
    if (!Array.isArray(fields)) throw say('bad_row', { index: 'fields' });
    if (fields.length > limits.fields_per_list) throw say('too_many', { limit: limits.fields_per_list, what: 'fields' });
    return fields.map(field => {
      const id = field?.id ?? slugOf(field?.label);
      if (!FIELD.test(id)) throw say('bad_id', { id: JSON.stringify(field?.id ?? field?.label) });
      const kind = field.kind ?? 'text';
      const row = KINDS.get(kind);
      if (!row) throw say('bad_kind', { field_id: id, kind: JSON.stringify(kind), kinds: [...KINDS.keys()].join(', ') });
      const out = { id, label: typeof field.label === 'string' && field.label ? field.label : id, kind };
      if (row.record_pick) {
        if (!validRecordField(field) || field.suggest !== undefined) throw say('bad_row', { index: `record source for ${id}` });
        out.from = structuredClone(field.from);
        if (field.new !== undefined) out.new = structuredClone(field.new);
      } else if (field.from !== undefined || field.new !== undefined) throw say('bad_row', { index: `record source for ${id}` });
      if (field.editable !== undefined) {
        if (typeof field.editable !== 'boolean') throw say('bad_row', {index: 'fields'});
        out.editable = field.editable;
      }
      if (field.required !== undefined) {
        if (typeof field.required !== 'boolean' || (field.required && (row.carries || row.value === 'rule' || row.value === 'done-rule'))) throw say('bad_row', { index: 'fields' });
        if (field.required) out.required = true;
      }
      // How text given for this field is read as a number or a date, and how its values are compared when rows are matched.
      if (field.input !== undefined) {
        const number = row.value === 'number', date = row.ruleKind === 'date';
        if (!inputDeclarationFits(field.input) || (!number && !date) || (!number && field.input.decimal !== undefined) || (!date && field.input.date_order !== undefined))
          throw say('bad_input', { field_id: id, ...grammarWords });
        out.input = { ...field.input };
      }
      if (field.duplicate !== undefined) {
        if (!data.duplicate.actions.includes(field.duplicate)) throw say('bad_duplicate_rule', { field_id: id, rule: JSON.stringify(field.duplicate), rules: data.duplicate.actions.join(', ') });
        out.duplicate = field.duplicate;
      }
      if (field.normalize !== undefined) {
        if (!normalizerNames.includes(field.normalize)) throw say('bad_row', { index: 'fields' });
        out.normalize = field.normalize;
      }
      // An identity key (src/list-keys.mjs): no two rows hold the same value in its shared form.
      // The values this field has held, kept on its row (src/list-value-history.mjs), for `history` fields to read.
      if (field.keeps_history !== undefined) {
        if (typeof field.keeps_history !== 'boolean' || (field.keeps_history && row.carries)) throw say('bad_row', { index: 'fields' });
        if (field.keeps_history) out.keeps_history = true;
      }
      // A field that is always worked out by a machine (an enrichment, a sync): its value reads as machine-written whoever last wrote it.
      if (field.machine !== undefined) {
        if (typeof field.machine !== 'boolean') throw say('bad_row', { index: 'fields' });
        if (field.machine) out.machine = true;
      }
      if (field.unique !== undefined) {
        if (typeof field.unique !== 'boolean' || (field.unique && !matchable({ ...field, kind }))) throw say('bad_unique', { field_id: id });
        if (field.unique) out.unique = true;
      }
      if (!row.links && field.link_constraints !== undefined) throw say('bad_link_constraints', { field_id: id });
      if (row.links) {
        if (!field.links_to) throw say('needs_link', { field_id: id });
        const target = listKey(field.links_to);
        const keptElsewhere = !lists.has(target) && elsewhere.has(target);
        if (!lists.has(target) && !keptElsewhere && !kept.some(prior => prior?.id === id && prior.links_to === target))
          throw say('bad_link', { field_id: id, links_to: field.links_to });
        out.links_to = target;
        // The field on the linked list that holds the way back (src/list-pairs.mjs checks both sides when the list is saved).
        if (field.pairs_with !== undefined) {
          if (typeof field.pairs_with !== 'string' || !FIELD.test(field.pairs_with) || keptElsewhere) throw say('bad_pair', { field_id: id, links_to: target, pairs_with: JSON.stringify(field.pairs_with) });
          out.pairs_with = field.pairs_with;
        }
        if (field.on_target_remove !== undefined) {
          if (field.on_target_remove !== 'detach') throw say('bad_row', { index: 'fields' });
          out.on_target_remove = field.on_target_remove;
        }
        if (field.link_constraints !== undefined) {
          const constraints = field.link_constraints;
          if (!isObject(constraints) || Object.keys(constraints).some(key => !['max_links', 'require_target', 'acyclic'].includes(key))
            || (constraints.max_links !== undefined && (!Number.isSafeInteger(constraints.max_links) || constraints.max_links < 0))
            || (constraints.require_target !== undefined && typeof constraints.require_target !== 'boolean')
            || (constraints.acyclic !== undefined && typeof constraints.acyclic !== 'boolean')
            || (constraints.acyclic === true && target !== ownerSlug)
            // A required target is checked where rows are written, which a list in another store never is.
            || (constraints.require_target === true && keptElsewhere)) throw say('bad_link_constraints', { field_id: id });
          out.link_constraints = {
            ...(constraints.max_links !== undefined ? { max_links: constraints.max_links } : {}),
            ...(constraints.require_target !== undefined ? { require_target: constraints.require_target } : {}),
            ...(constraints.acyclic !== undefined ? { acyclic: constraints.acyclic } : {}),
          };
        }
      }
      // A field the person (or their AI) says names a kind of thing: the list that keeps those things, made when missing;
      // the naming step moves the field to a link over it at idle (src/naming-fields.mjs).
      if (isObject(field.names) && isObject(field.names.list) && NAME.test(String(field.names.list.id ?? '')) && typeof field.names.list.label === 'string') out.names = { list: field.names.list };
      // Keep the declaration's explanation for a free-text field. Dropping this
      // metadata made schema reconciliation repeatedly rediscover the same gap.
      if (typeof field.free_text_because === 'string' && field.free_text_because.trim()) {
        if (field.free_text_because.length > limits.text_chars) throw say('too_long', { row_id: 'fields', field_id: id, limit: limits.text_chars });
        out.free_text_because = field.free_text_because;
      }
      if (Array.isArray(field.choices)) out.choices = field.choices.filter(choice => typeof choice === 'string');
      // Values a row keeps once it holds them (a Done that stays done): a later write naming another value leaves it.
      if (Array.isArray(field.settles)) out.settles = field.settles.filter(value => typeof value === 'string');
      // Limits a value must keep, as part of the field (invariant 10). A limit that is absent is no check; 0 is a real limit.
      for (const [key, valueKind] of [['min', 'number'], ['max', 'number'], ['max_chars', 'text']]) {
        if (field[key] === undefined || field[key] === null) continue;
        if (KINDS.get(kind).value !== valueKind || typeof field[key] !== 'number' || !Number.isFinite(field[key])
          || (key === 'max_chars' && (!Number.isSafeInteger(field[key]) || field[key] < 0))) throw say('bad_limit', { field_id: id, key });
        out[key] = field[key];
      }
      if (out.min !== undefined && out.max !== undefined && out.min > out.max) throw say('bad_limit', { field_id: id, key: 'min' });
      // Where a new row starts, and the declared index that holds the rows not settled (invariant 9).
      if (typeof field.starts === 'string' && out.choices?.includes(field.starts)) out.starts = field.starts;
      if (typeof field.open_index === 'string' && FIELD.test(field.open_index) && out.starts !== undefined) out.open_index = field.open_index;
      // A kind that carries how its value is worked out (a formula's binding, a button's action) keeps that object on
      // the field, over the kind row's defaults; which key, and the defaults, are the kind row's DATA.
      if (row.carries) {
        const carried = field[row.carries.key];
        if (!isObject(carried)) throw say('needs_carried', { field_id: id, kind, key: row.carries.key });
        out[row.carries.key] = { ...(row.carries.defaults ?? {}), ...carried };
        if (JSON.stringify(out[row.carries.key]).length > limits.text_chars) throw say('too_long', { row_id: 'fields', field_id: id, limit: limits.text_chars });
      }
      return out;
    });
  }

  // Saved views: slices of the same rows (Customers, Leads, Opened the email) as a name, a search and filter rules
  // (parts/ui/show/rule-filter rule trees), so a slice is never a second list.
  function checkViews(views, fields, ownerSlug, rowSources = null) {
    // A value a row source names itself (note.status of a folder of documents) is a field of its views (src/list-paths.mjs).
    const namespaces = sourceNamespacesOf(rowSources);
    if (!Array.isArray(views)) throw say('bad_view', { index: 'views' });
    if (views.length > limits.views_per_list) throw say('too_many', { limit: limits.views_per_list, what: 'views' });
    const known = new Set();
    return views.map((view, index) => {
      if (!view || typeof view.label !== 'string' || !view.label.trim()) throw say('bad_view', { index });
      if (JSON.stringify(view).length > limits.text_chars) throw say('bad_view', { index });
      const id = typeof view.id === 'string' && NAME.test(view.id) ? view.id : slugOf(view.label) || `view-${index + 1}`;
      if (known.has(id)) throw say('bad_view', { index });
      known.add(id);
      // A path through links (company.employees) is a field of the view when it resolves against the lists that exist.
      const named = pathIdsOf(view);
      const sourced = named.filter(path => isSourceId(path, namespaces));
      const paths = [...named.filter(path => !sourced.includes(path)).map(path => planPath({ fields }, path, slug => slug === ownerSlug ? { id: slug, fields } : (listAt(recordId(slug)) ? { id: slug, ...listAt(recordId(slug)) } : null), id).id), ...sourced];
      try { return normalizeSavedView({ ...view, id }, [...fields.map(field => field.id), ...paths, ...keyFieldsOf(fields).map(field => field.id)]); }
      catch { throw say('bad_view', { index }); }
    });
  }

  function checkManagedRows(value, fields) {
    if (value === null || value === undefined) return null;
    const allowed = new Set(['open_field', 'create_on_screen', 'share_record']);
    if (!isObject(value) || Object.keys(value).some(key => !allowed.has(key))) throw say('bad_row', {index: 'managed_rows'});
    const out = {};
    if (value.open_field !== undefined) {
      if (!fields.some(field => field.id === value.open_field)) throw say('bad_row', {index: 'managed_rows'});
      out.open_field = value.open_field;
    }
    for (const key of ['create_on_screen', 'share_record']) if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw say('bad_row', {index: 'managed_rows'});
      out[key] = value[key];
    }
    return out;
  }

  // A public list can choose a shared page presentation. The field bindings are
  // references to this list's own fields, never copied facts or executable code.
  function checkPublicPage(page, fields) {
    if (page === null || page === undefined) return null;
    if (!isObject(page) || page.layout !== 'comparison' || !isObject(page.fields)) throw say('bad_row', { index: 'public_page' });
    const available = new Set(fields.map(field => field.id));
    const roles = new Set(['product', 'category', 'summary', 'ours', 'theirs', 'better', 'price', 'our_price', 'sources', 'checked', 'product_url', 'pick_ours', 'pick_theirs', 'switching', 'faq', 'replacement_set']);
    const bindings = {};
    for (const [role, field] of Object.entries(page.fields)) {
      if (!roles.has(role) || typeof field !== 'string' || !available.has(field)) throw say('bad_row', { index: 'public_page' });
      bindings[role] = field;
    }
    if (!['product', 'summary', 'ours', 'theirs', 'better', 'sources', 'checked'].every(role => bindings[role])) throw say('bad_row', { index: 'public_page' });
    if (typeof page.own_label !== 'string' || !page.own_label.trim() || page.own_label.length > 80) throw say('bad_row', { index: 'public_page' });
    let evidence_rows;
    if (page.evidence_rows !== undefined) {
      const source = page.evidence_rows;
      const keys = ['kind_field', 'owner_field', 'role_field', 'text_field'];
      const sourceKeys = ['source_ref_field', 'source_url_field'];
      const evidenceList = typeof source?.evidence_list === 'string'
        ? listAt(recordId(listKey(source.evidence_list))) : null;
      const evidenceFields = new Set((evidenceList?.fields ?? fields).map(field => field.id));
      if (!isObject(source) || !keys.every(key => typeof source[key] === 'string' && evidenceFields.has(source[key]))
        || !available.has(source.kind_field)
        || typeof source.comparison_kind !== 'string' || !source.comparison_kind.trim()
        || typeof source.claim_kind !== 'string' || !source.claim_kind.trim()
        || (sourceKeys.some(key => source[key] !== undefined) &&
          (!sourceKeys.every(key => typeof source[key] === 'string' && evidenceFields.has(source[key]))
            || typeof source.source_kind !== 'string' || !source.source_kind.trim()))
        || (source.evidence_list !== undefined && (!evidenceList || typeof source.claim_ids_field !== 'string'
          || fields.find(field => field.id === source.claim_ids_field)?.kind !== 'tags')))
        throw say('bad_row', { index: 'public_page' });
      evidence_rows = Object.fromEntries([...keys, 'comparison_kind', 'claim_kind',
        ...(source.source_ref_field ? [...sourceKeys, 'source_kind'] : []),
        ...(source.evidence_list ? ['evidence_list', 'claim_ids_field'] : [])].map(key => [key, source[key]]));
    }
    let hero_image;
    if (page.hero_image !== undefined) {
      const image = page.hero_image;
      if (!isObject(image) || typeof image.src !== 'string' || !/^\/(?!\/)[^\s]*$/.test(image.src)
        || image.src.length > 500 || typeof image.alt !== 'string' || !image.alt.trim() || image.alt.length > 240)
        throw say('bad_row', { index: 'public_page' });
      hero_image = { src: image.src, alt: image.alt.trim() };
    }
    return { layout: page.layout, own_label: page.own_label.trim(), fields: bindings,
      ...(evidence_rows ? { evidence_rows } : {}), ...(hero_image ? { hero_image } : {}) };
  }

  // The open rows of a list written since its count `since`: { open, shut } (row ids now carrying the open field, and row ids
  // that no longer do), the same membership read(id, { open: true }) lists. Null when the kept writes cannot say so: the open
  // index is not ready, the list itself was written, or the kept writes no longer reach back to `since`.
  const openChanges = (id, since) => {
    const slug = listKey(id);
    const list = listAt(recordId(slug));
    const field = list && openFieldOf(list);
    if (!field || !openReady(slug, list, field)) return null;
    const written = writtenSince(slug, since);
    if (!written || written.includes(recordId(slug))) return null;
    const prefix = rowPrefix(list.row_type);
    const ids = [...new Set(written.filter(recordId => recordId.startsWith(prefix)))];
    const values = typeof eeaf.readMany === 'function' ? eeaf.readMany(ids) : new Map(ids.map(recordId => [recordId, eeaf.read(recordId)]));
    const open = [], shut = [];
    for (const recordId of ids) (values.get(recordId)?.[field.id] !== undefined ? open : shut).push(recordId.slice(prefix.length));
    return { open, shut };
  };

  // What `save` keeps for `input` over the list as it reads (`existing`, or null): checked and shaped, nothing written.
  // `named` is the set of list ids the person keeps, read here when not given.
  const shapeList = (input, existing, { kept_elsewhere = [], named = null } = {}) => {
    const label = input?.label ?? existing?.label;
    if (typeof label !== 'string' || !label.trim()) throw say('needs_label');
    const slug = input?.id ? listKey(input.id) : listKey(slugOf(label));
    const lists = named ?? new Set(listIds().map(id => id.slice(data.record_type.length + 1)));
    if (!lists.has(slug) && lists.size >= limits.lists_per_person) throw say('too_many', { limit: limits.lists_per_person, what: 'lists' });
    lists.add(slug);
    if (input?.field_additions !== undefined && input?.fields !== undefined) throw say('bad_row', { index: 'fields or field_additions' });
    if (input?.field_additions !== undefined && !existing) throw say('no_list', { list_id: slug });
    let fieldInput = input?.fields ?? existing?.fields ?? [{ id: 'name', label: 'Name', kind: 'text' }];
    if (input?.field_additions !== undefined) {
      if (!Array.isArray(input.field_additions)) throw say('bad_row', { index: 'field_additions' });
      const kept = existing?.fields ?? [];
      const additions = checkFields(input.field_additions, lists, slug,
        { kept, elsewhere: new Set(kept_elsewhere.map(listKey)) });
      const ids = new Set();
      const pending = [];
      for (const addition of additions) {
        if (ids.has(addition.id)) throw say('bad_row', { index: `field_additions.${addition.id}` });
        ids.add(addition.id);
        const prior = kept.find(field => field.id === addition.id);
        if (!prior) pending.push(addition);
        else if (JSON.stringify(prior) !== JSON.stringify(addition)) {
          throw say('bad_row', { index: `field_additions.${addition.id} conflicts with the existing field` });
        }
      }
      // Resolve additions against the current list in this owner call, preserving fields added by another writer
      // since the caller's last read. Repeating identical additions does not duplicate the schema.
      fieldInput = [...kept, ...pending];
    }
    const fields = checkFields(fieldInput, lists, slug,
      { kept: existing?.fields ?? [], elsewhere: new Set(kept_elsewhere.map(listKey)) });
    checkRollups(fields, other => (other === slug ? { fields } : listAt(recordId(other))));
    checkRelationships(fields);
    checkHistoryFields(fields);
    const rowType = existing?.row_type ?? (input?.row_type === undefined ? slug : String(input.row_type));
    if (!NAME.test(rowType)) throw say('bad_id', { id: JSON.stringify(input?.row_type) });
    const titleField = input?.title_field ?? existing?.title_field ?? fields[0]?.id ?? null;
    // Every view, kept inside the list or as a record of its own, is checked against the fields being saved; views given
    // here replace them all, each then kept as a record of its own in the order given.
    const rowSources = checkRowSources(input?.row_sources === null ? null : (input?.row_sources ?? existing?.row_sources ?? null));
    const views = checkViews(input?.views ?? (existing ? viewsOf(slug, existing) : []), fields, slug, rowSources);
    const embeddedIds = new Set(input?.views !== undefined ? [] : (existing?.views ?? []).map(view => view.id));
    const partners = checkPairs(slug, fields, existing?.fields, other => listAt(recordId(other)));
    const stamps = input?.stamps === undefined ? existing?.stamps === true : input.stamps;
    // How long a review lasts on this list (src/list-review.mjs), and whether an AI's changes wait for a person
    // (src/list-proposals.mjs, lists.json proposals): both off unless the list says so.
    const review = input?.review === null ? null : (input?.review ?? existing?.review ?? null);
    if (review !== null && (!isObject(review) || Object.keys(review).some(key => key !== 'expires_days') || !Number.isFinite(review.expires_days) || review.expires_days <= 0)) throw say('bad_row', { index: 'review' });
    const reviewChanges = input?.review_changes === undefined ? existing?.review_changes === true : input.review_changes;
    if (typeof reviewChanges !== 'boolean') throw say('bad_row', { index: 'review_changes' });
    if (typeof stamps !== 'boolean') throw say('bad_row', { index: 'stamps' });
    const indexes = normalizeDeclaredIndexes(input?.indexes ?? existing?.indexes, Object.fromEntries(fields.map(field => [field.id, field.kind])));
    const rawOrdering = input?.ordering === null ? null : (input?.ordering ?? existing?.ordering ?? null);
    let ordering = null;
    if (rawOrdering !== null) {
      const declaration = indexes.find(index => index.name === rawOrdering?.index);
      if (!isObject(rawOrdering) || Object.keys(rawOrdering).some(key => key !== 'index')
        || typeof rawOrdering.index !== 'string' || !declaration || declaration.fields.length !== 1
        || fields.find(field => field.id === declaration.fields[0])?.kind !== 'text') throw say('bad_order', { list_id: slug });
      ordering = { index: rawOrdering.index };
    }
    const publicPage = checkPublicPage(input?.public_page === null ? null : (input?.public_page ?? existing?.public_page), fields);
    const shareWhen = input?.share_when === null ? null : (input?.share_when ?? existing?.share_when ?? null);
    if (shareWhen !== null && (!fits.rule(shareWhen) || JSON.stringify(shareWhen).length > limits.text_chars)) throw say('bad_row', { index: 'share_when' });
    const managedRows = checkManagedRows(input?.managed_rows === null ? null : (input?.managed_rows ?? existing?.managed_rows), fields);
    const placement = checkPlacement(input?.placement, existing?.placement);
    const balanced = checkBalanced(input?.balanced === null ? null : (input?.balanced ?? existing?.balanced), fields, indexes, managedRows, slug);
    const reportBasis = input?.report_basis === null ? null : (input?.report_basis ?? existing?.report_basis ?? null);
    if (reportBasis !== null && !REPORT_BASES.includes(reportBasis)) throw say('bad_basis', { basis: JSON.stringify(reportBasis), bases: REPORT_BASES.join(', ') });
    // The saved view the list's screen opens on when it is opened without one (a person can still pick any other).
    const opensOn = input?.opens_on === null ? null : (input?.opens_on ?? existing?.opens_on ?? null);
    if (opensOn !== null && (typeof opensOn !== 'string' || !opensOn || opensOn.length > limits.text_chars)) throw say('bad_opens_on', { list_id: slug });
    const list = {
      label: label.trim(), row_type: rowType, title_field: titleField, fields,
      indexes,
      ...(ordering ? { ordering } : {}),
      ...(embeddedIds.size ? { views: views.filter(view => embeddedIds.has(view.id)) } : {}),
      ...(stamps ? { stamps } : {}),
      ...(review ? { review: { expires_days: review.expires_days } } : {}),
      ...(reviewChanges ? { review_changes: true } : {}),
      ...(publicPage ? { public_page: publicPage } : {}),
      ...(shareWhen ? { share_when: shareWhen } : {}),
      ...(managedRows ? {managed_rows: managedRows} : {}),
      ...(rowSources ? { row_sources: rowSources } : {}),
      ...(placement ? { placement } : {}),
      ...(balanced ? { balanced } : {}),
      ...(reportBasis ? { report_basis: reportBasis } : {}),
      ...(opensOn ? { opens_on: opensOn } : {}),
      ...(input?.icon ?? existing?.icon ? { icon: input?.icon ?? existing.icon } : {}),
      ...(input?.about ?? existing?.about ? { about: input?.about ?? existing.about } : {}),
    };
    return { slug, lists, fields, views, partners, list };
  };
  // A starting list as `save` would keep it from its DATA (invariant 24), its views inside it; null for any other list.
  const startingOf = slug => startingByStore.get(eeaf)?.get(slug) ?? null;
  const startingShape = slug => {
    const definition = startingOf(slug);
    if (!definition) return null;
    if (!startingShapes.has(definition)) {
      const { list, views } = shapeList({ ...definition }, null, { named: new Set() });
      startingShapes.set(definition, { ...list, ...(views.length ? { views } : {}) });
    }
    return startingShapes.get(definition);
  };
  // The first write naming a starting list not kept yet keeps the list first, as `save` keeps it (invariant 24).
  const keepStartingFirst = (listRef, records, context) => {
    const slug = listRef.slice(data.record_type.length + 1);
    const definition = startingOf(slug);
    if (!definition || records.some(record => record.id === listRef) || keptList(slug)) return;
    self.save({ ...definition }, { actor: context?.actor });
  };
  // A starting list not kept yet with no row of its type has nothing a fill would give a start value (invariant 24).
  const nothingToFill = (slug, list) => !keptList(slug) && eeaf.ids(typeOfRows(list), { limit: 1 }).length === 0;

  return self = {
    // How many writes this list has had in this store (a list named by slug or record id), and the most rows a read lists.
    revisionOf: id => revisions.get(recordId(listKey(id)))?.revision ?? 0,
    openChanges,
    changes: changesSince,
    // The store's record log position now: what a read answered from is at or after it (src/record-depends.mjs invariant 1).
    version: () => eeaf.lastLogId?.() ?? null,
    // What a read of this list (through `view`, or none) showing the rows `row_ids` depends on (invariant 23), as of the
    // `version` taken before the read; null when it depends on records outside the lists.
    dependsOf(id, { view = null, row_ids: shown = [], version = null } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      if (list.row_sources?.length || list.managed_rows || hidden?.(list.id) || list.fields.some(field => KINDS.get(field.kind)?.reads_outside)) return null;
      const members = new Map();
      // null is "any field" and absorbs every field named for the same prefix.
      const member = (prefix, fields) => {
        const earlier = members.get(prefix);
        members.set(prefix, earlier === null || fields === null ? null : [...new Set([...(earlier ?? []), ...fields])]);
      };
      const fieldsById = new Map(list.fields.map(field => [field.id, field]));
      const ids = [recordId(slug)];
      member(viewPrefix(slug), null);
      // Every list a link field reaches draws here (titles, values worked out from linked rows): any change to one counts.
      for (const field of list.fields) {
        const linked = field.links_to ? this.find(field.links_to) : null;
        if (field.links_to) ids.push(recordId(field.links_to));
        if (linked) member(rowPrefix(linked.row_type), null);
      }
      // Which rows are shown, and in what order, moves only with the fields the view filters, sorts, groups or times by,
      // the list's own ordering, and the first step of each path; a computed one moves with anything, and so does a search.
      let ownFields = null;
      if (view && !(typeof view.search === 'string' && view.search.trim())) {
        const named = new Set();
        const walk = node => { if (!isObject(node)) return; if (typeof node.field === 'string') named.add(node.field); if (Array.isArray(node.rules)) node.rules.forEach(walk); };
        walk(view.rules);
        for (const entry of [...(Array.isArray(view.sort) ? view.sort : []), ...(Array.isArray(view.groups) ? view.groups : [])]) if (typeof entry?.field === 'string') named.add(entry.field);
        if (typeof view.time?.field === 'string') named.add(view.time.field);
        const orderField = list.ordering && list.indexes?.find(index => index.name === list.ordering.index)?.fields?.[0];
        if (orderField) named.add(orderField);
        let unplanned = false;
        for (const pathId of pathIdsOf(view)) {
          named.delete(pathId);
          let plan;
          try { plan = planPath(list, pathId, other => this.find(other), view.id ?? ''); } catch { unplanned = true; continue; }
          named.add(plan.hops[0].field.id);
          plan.hops.slice(1).forEach(hop => member(rowPrefix(hop.list.row_type), [hop.field.id]));
          member(rowPrefix(plan.leafList.row_type), [plan.leaf.id]);
          for (const hop of plan.hops) ids.push(recordId(hop.list.id));
          ids.push(recordId(plan.leafList.id));
        }
        // A path this list cannot plan (a source's own value) or a computed field moves with any change.
        ownFields = unplanned || [...named].some(fieldId => KINDS.get(fieldsById.get(fieldId)?.kind)?.value === 'computed') ? null : [...named];
      }
      member(rowPrefix(list.row_type), ownFields);
      const prefix = rowPrefix(list.row_type);
      return { version, ids: [...new Set(ids)], rows: shown.map(rowId => `${prefix}${rowId}`), members: [...members].map(([memberPrefix, fields]) => ({ prefix: memberPrefix, fields })) };
    },
    openCap: limits.rows_per_read,
    field_kinds: data.field_kinds,

    // The same membership as all(), without reading unrelated lists or counting their rows. A record whose id
    // happens to use the list prefix still needs the list type and a kept definition.
    has(id) {
      const key = recordId(listKey(id));
      return (eeaf.typeOf(key) === data.record_type || Boolean(startingAt(key))) && Boolean(listAt(key));
    },

    page({before,limit=100}={}) {
      if(!Number.isInteger(limit)||limit<1||limit>100)throw Object.assign(new RangeError('Read at most100 lists per page.'),{status:400});
      const ids=listIds({...(before?{before}:{}),limit:limit+1});
      const definitions=ids.slice(0,limit).map(id=>({id,list:listAt(id)})).filter(row=>row.list);
      const counts=eeaf.countMany?.(definitions.map(({list})=>`record:${list.row_type}`));
      return {lists:definitions.map(({id,list})=>{const count=counts?.get(`record:${list.row_type}`);return {...withViews(id.slice(data.record_type.length+1),list),rows:Number.isSafeInteger(count)?Math.min(count,limits.rows_per_read):eeaf.ids(`record:${list.row_type}`,{limit:limits.rows_per_read}).length};}),next_before:ids.length>limit?ids[limit-1]:null};
    },
    // Every list, in id order, with how many rows it holds.
    all() {
      // How many rows each list holds, from the record store's own count of each type when it keeps one (the log engine;
      // the other answers none), so listing the lists never walks their rows: every list read up to limits.rows_per_read
      // ids to count them, 147,000 rows a read on the person's store on 2026-10-10.
      const definitions = listIds().map(id => ({ id, list: listAt(id) })).filter(row => row.list);
      let counts = null;
      try { counts = eeaf.countMany?.(definitions.map(({ list }) => `record:${list.row_type}`)) ?? null; } catch { counts = null; }
      const rowsOf = type => {
        let counted = null;
        try { counted = counts instanceof Map ? counts.get(type) : eeaf.count?.(type) ?? null; } catch { counted = null; }
        return Number.isSafeInteger(counted) ? Math.min(counted, limits.rows_per_read) : eeaf.ids(type, { limit: limits.rows_per_read }).length;
      };
      return {
        lists: definitions.map(({ id, list }) => ({ ...withViews(id.slice(data.record_type.length + 1), list), rows: rowsOf(`record:${list.row_type}`) })),
      };
    },

    // Rows across lists for a record picker: the lists asked for by id, plus every list whose row type is asked for (both
    // empty: any list), at most limits.search_lists of them; each row ranked by how well its title matches `q`
    // (an empty q lists them in name order). A list that does not exist is skipped.
    /** The person's record id of one row (`record:<row_type>:<id>`) when that row is kept in that list, else null: how
     *  something outside the lists (a heard voice) links to a row the person chose. */
    rowRef(list_id, id) {
      let list = null;
      try { list = typeof list_id === 'string' && typeof id === 'string' ? listAt(recordId(listKey(list_id))) : null; } catch { list = null; }
      return list && eeaf.read(`${rowPrefix(list.row_type)}${id}`) ? `${rowPrefix(list.row_type)}${id}` : null;
    },
    search({ q = '', lists: wanted = [], row_types: types = [], holds, limit } = {}) {
      const asked = [wanted, types].flat();
      if (!Array.isArray(wanted) || !Array.isArray(types) || asked.some(item => typeof item !== 'string')) throw say('bad_search', { what: 'lists or row_types that are not names', holds: holdsNames });
      if (holds !== undefined && holds !== null && holds !== '' && !holdsRule(holds)) throw say('bad_search', { what: `holds ${JSON.stringify(holds)}`, holds: holdsNames });
      const most = Math.min(Math.max(Number.parseInt(limit, 10) || limits.search_default, 1), limits.search_most);
      const ids = new Set(wanted.map(item => item.replace(/^list:/, '')).filter(item => NAME.test(item)));
      const kinds = new Set(types.filter(item => NAME.test(item)));
      const holding = holdsRule(holds) ? holds : null;
      const everything = !wanted.length && !types.length && !holding;
      const found = listIds().map(id => id.slice(data.record_type.length + 1))
        .filter(slug => everything || ids.has(slug) || kinds.has(listAt(recordId(slug))?.row_type) || (holding && holdsList(holding, listAt(recordId(slug)))))
        .slice(0, limits.search_lists);
      const needle = String(q).trim().toLowerCase();
      const words = needle.split(/\s+/).filter(Boolean);
      const scored = [];
      for (const slug of found) {
        const list = listAt(recordId(slug));
        if (!list) continue;
        for (const rowId of recentRowIds(list.row_type, limits.rows_per_read)) {
          const values = eeaf.read(`${rowPrefix(list.row_type)}${rowId}`);
          const title = values && titleOf(list, values);
          if (!title) continue;
          const lower = title.toLowerCase();
          const rest = list.fields.filter(field => field.id !== list.title_field && !KINDS.get(field.kind)?.links)
            .map(field => values[field.id]).filter(value => typeof value === 'string' && value).join(' · ');
          let score = 0;
          if (!needle) score = 1;
          else if (lower === needle) score = 100;
          else if (lower.startsWith(needle)) score = 80;
          else if (lower.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(needle))) score = 60;
          else if (lower.includes(needle)) score = 40;
          else if (words.length && words.every(word => lower.includes(word))) score = 30;
          else if (rest.toLowerCase().includes(needle)) score = 10;
          if (score) scored.push({ score, row: { id: rowId, list_id: slug, list_label: list.label, title, detail: rest.slice(0, limits.search_detail_chars) } });
        }
      }
      scored.sort((a, b) => b.score - a.score || a.row.title.localeCompare(b.row.title) || a.row.id.localeCompare(b.row.id));
      return { rows: scored.slice(0, most).map(item => item.row) };
    },

    /** The lists (as kept, with their id) that hold what `name` says (lists.json `holds`), at most limits.search_lists: how
     *  a reader of the person's people (src/voice-guesses.mjs) finds them without knowing any list's name. */
    holders(name) {
      if (!holdsRule(name)) throw say('bad_search', { what: `holds ${JSON.stringify(name)}`, holds: holdsNames });
      // reads-ok: a person keeps at most limits.lists_per_person lists, and the answer stops at limits.search_lists.
      return listIds().map(id => ({ id: id.slice(data.record_type.length + 1), list: listAt(id) }))
        .filter(({ list }) => holdsList(name, list)).slice(0, limits.search_lists).map(({ id, list }) => ({ id, ...list }));
    },

    // One list as it is kept (no rows, no count of them), or null when the person keeps no such list.
    find(id) {
      const slug = listKey(id);
      const list = listAt(recordId(slug));
      return list ? withViews(slug, list) : null;
    },

    // One row as it is kept ({ id, values }, nothing derived), or null when there is no such list or row: a point read for
    // a caller that wants one row, never the list.
    row(id, rowId) {
      const key = recordId(listKey(id));
      const list = eeaf.typeOf(key) === data.record_type || startingAt(key) ? listAt(key) : null;
      const values = list && typeof rowId === 'string' ? eeaf.read(`${rowPrefix(list.row_type)}${rowId}`) : null;
      return values ? { id: rowId, values } : null;
    },

    // Only a keyed durable cursor is read when the scheduler asks whether old rows still need their declared start.
    openFillAt(id, now = Date.now()) {
      const slug = listKey(id), list = listAt(recordId(slug));
      const field = list && openFieldOf(list);
      return field && !fillState(slug, list, field).done && !nothingToFill(slug, list) ? now : null;
    },
    // The lists whose rows still wait for their ordering, every list read once; orderingOwnerOf(id) names the list a
    // written record id belongs to (the list itself or its ordering mark), so a reader keeps this and reads again only those.
    orderingPending() {
      return listIds({ limit: limits.lists_per_person }).map(record => record.slice(data.record_type.length + 1))
        .filter(slug => this.orderingFillAt(slug) !== null);
    },
    // The same idle step also gives rows kept before a field became unique their identity keys (fillKeys), so the
    // scheduler that waits on a list's ordering waits on its keys too.
    orderingOwnerOf(id) {
      const mark = `${data.open_rows.mark_type}:ordering-`;
      const keys = `${data.open_rows.mark_type}:${data.keys.mark}`;
      return id.startsWith(`${data.record_type}:`) ? id.slice(data.record_type.length + 1) : id.startsWith(mark) ? id.slice(mark.length) : id.startsWith(keys) ? id.slice(keys.length) : null;
    },
    orderingFillAt(id, now = Date.now()) {
      if (id === undefined) return this.orderingPending().length ? now : null;
      const slug = listKey(id), list = listAt(recordId(slug));
      const field = list && orderFieldOf(list);
      return (field && !orderState(slug, list, field).done) || (list && !this.keysReady(slug)) ? now : null;
    },
    fillOrdering(id, { actor } = {}) {
      if (id === undefined) {
        const pending = listIds({ limit: limits.lists_per_person }).find(record => {
          const list = listAt(record), field = list && orderFieldOf(list);
          return (field && !orderState(record.slice(data.record_type.length + 1), list, field).done) || (list && !this.keysReady(record.slice(data.record_type.length + 1)));
        });
        return pending ? this.fillOrdering(pending.slice(data.record_type.length + 1), { actor }) : true;
      }
      const slug = listKey(id), list = listAt(recordId(slug));
      if (list && !this.keysReady(slug)) return this.fillKeys(slug, { actor });
      const field = list && orderFieldOf(list);
      if (!field) return true;
      const state = orderState(slug, list, field);
      if (state.done) return true;
      const type = typeOfRows(list), prefix = rowPrefix(list.row_type);
      const ids = eeaf.ids(type, { ...(state.before ? { before: state.before } : {}), limit: data.open_rows.fill_page });
      let head = null;
      try {
        const ready = typeof eeaf.indexReady !== 'function' || eeaf.indexReady(type, list.ordering.index);
        if (ready) head = eeaf.scan(type, list.ordering.index, { limit: 1 })[0]?.values?.[0] ?? null;
      } catch { head = null; }
      if (!head) for (const rowId of recentRowIds(list.row_type, limits.rows_per_read)) {
        const key = eeaf.read(`${prefix}${rowId}`)?.[field.id];
        if (isOrderKey(key) && (head === null || key < head)) head = key;
      }
      const records = [];
      let upper = head;
      for (const idValue of [...ids].reverse()) {
        const value = eeaf.read(idValue);
        if (!value || isOrderKey(value[field.id])) continue;
        const next = keyBetween(null, upper);
        records.push({ id: idValue, type, value: { ...value, [field.id]: next } });
        upper = next;
      }
      const done = ids.length < data.open_rows.fill_page;
      records.push({ id: orderMarkId(slug), type: data.open_rows.mark_type, value: {
        signature: orderSignature(list, field), before: ids.at(-1) ?? state.before, done,
      } });
      write(records, { actor: actor ?? { by: 'lists-order-index' } }, { list_ref: recordId(slug) });
      return done;
    },
    // Whether every row of a list has the identity keys of its unique fields (src/list-keys.mjs): true for a list with none.
    keysReady(id) {
      const slug = listKey(id), list = listAt(recordId(slug));
      if (!list || !uniqueFields(list).length) return true;
      const mark = eeaf.read(keysMarkId(slug));
      return mark?.signature === keysSignature(list) && mark.done === true;
    },
    // Gives at most open_rows.fill_page rows kept before a field became unique their keys, newest first, and keeps the cursor
    // and the rows found sharing a form (at most limits.backlinks_returned of them) in the mark. True once every row has them.
    fillKeys(id, { actor } = {}) {
      const slug = listKey(id), list = listAt(recordId(slug));
      if (!list || this.keysReady(slug)) return true;
      const held = eeaf.read(keysMarkId(slug));
      const state = held?.signature === keysSignature(list) ? held : { before: null, shared: [] };
      const ids = eeaf.ids(typeOfRows(list), { ...(state.before ? { before: state.before } : {}), limit: data.open_rows.fill_page });
      const rows = typeof eeaf.readMany === 'function' ? eeaf.readMany(ids) : new Map(ids.map(rowId => [rowId, eeaf.read(rowId)]));
      const page = fillPage({ list, slug, page: ids.map(rowId => ({ id: rowId, value: rows.get(rowId) })), read: recordIdValue => eeaf.read(recordIdValue), prefix: rowPrefix(list.row_type) });
      const done = ids.length < data.open_rows.fill_page;
      write([...page.records, { id: keysMarkId(slug), type: data.open_rows.mark_type, value: {
        signature: keysSignature(list), before: ids.at(-1) ?? state.before, done, shared: [...(state.shared ?? []), ...page.shared].slice(0, limits.backlinks_returned),
      } }], { actor: actor ?? { by: 'lists-key-index' } }, { list_ref: recordId(slug) });
      return done;
    },
    // Which row holds each value in a unique field, by one point read per value: { ready, holders: [{ value, row_id }] }
    // (row_id null when no row holds it). Not ready while the field's keys are being prepared, so a caller reads the rows.
    keyHolders(id, { field_id, values } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      const field = uniqueFields(list).find(item => item.id === field_id);
      if (!field || !Array.isArray(values) || values.length > limits.rows_per_write) throw say('bad_match', { list_id: slug, what: JSON.stringify(field_id) });
      if (!this.keysReady(slug)) return { list_id: slug, field_id, ready: false, holders: [] };
      const prefix = rowPrefix(list.row_type);
      return { list_id: slug, field_id, ready: true, holders: values.map(value => {
        const holders = formsOf(field, value).map(form => eeaf.read(keyRecordId(slug, field.id, form))?.row_id)
          .filter(rowId => rowId && formsOf(field, eeaf.read(`${prefix}${rowId}`)?.[field.id]).some(form => formsOf(field, value).includes(form)));
        return { value, row_id: [...new Set(holders)].length === 1 ? holders[0] : null, ...(new Set(holders).size > 1 ? { row_ids: [...new Set(holders)] } : {}) };
      }) };
    },

    // Where references to rows of one list point now (`refs`: { row_id } or { key: { field_id, value } }): each answers
    // { address: "<list>/<row>", row_id, state: found | merged | removed | unknown, merged_into? }. A row merged away answers
    // the row it became (followed limits.tombstone_hops times), a removed one says so, and a unique key answers the one row
    // holding it (several holders answer unknown with their ids), so any reference resolves to a real id in one call.
    resolve(id, { refs } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      if (!Array.isArray(refs) || !refs.length || refs.length > limits.resolve_refs) throw say('bad_ref', { limit: limits.resolve_refs, index: 'refs' });
      const prefix = rowPrefix(list.row_type);
      const answer = (rowId, extra = {}) => ({ address: `${slug}/${rowId}`, row_id: rowId, ...extra });
      return { list_id: slug, resolved: refs.map((ref, index) => {
        if (typeof ref?.row_id === 'string' && ref.row_id && !ref.row_id.includes('/')) {
          if (eeaf.read(`${prefix}${ref.row_id}`)) return answer(ref.row_id, { state: 'found' });
          const now = followMerge(slug, ref.row_id, prefix);
          if (now !== ref.row_id && eeaf.read(`${prefix}${now}`)) return answer(now, { state: 'merged', merged_into: now, was: ref.row_id });
          return answer(ref.row_id, { state: eeaf.read(trashId(slug, ref.row_id)) ? 'removed' : 'unknown' });
        }
        if (typeof ref?.key?.field_id === 'string') {
          const held = this.keyHolders(slug, { field_id: ref.key.field_id, values: [ref.key.value] });
          const one = held.holders[0];
          if (!held.ready) return { state: 'unknown', key: ref.key, ready: false };
          return one?.row_id ? answer(one.row_id, { state: 'found', key: ref.key }) : { state: 'unknown', key: ref.key, ...(one?.row_ids ? { row_ids: one.row_ids } : {}) };
        }
        throw say('bad_ref', { limit: limits.resolve_refs, index });
      }) };
    },

    // Gives at most open_rows.fill_page old rows the declared start value, newest first, and keeps the cursor.
    // True once every row has it; the record-log's existing maintainer separately brings the named index current.
    fillOpen(id, { actor } = {}) {
      const slug = listKey(id), list = listAt(recordId(slug));
      const field = list && openFieldOf(list);
      if (!field || nothingToFill(slug, list)) return true;
      const state = fillState(slug, list, field);
      if (state.done) return true;
      const type = typeOfRows(list);
      const page = eeaf.ids(type, { ...(state.before !== null ? { before: state.before } : {}), limit: data.open_rows.fill_page });
      const starts = page.flatMap(id => {
        const value = eeaf.read(id);
        return value && value[field.id] === undefined ? [{ id, type, value: { ...value, [field.id]: field.starts } }] : [];
      });
      const done = page.length < data.open_rows.fill_page;
      write([...starts, { id: fillMarkId(slug), type: data.open_rows.mark_type, value: {
        signature: fillSignature(list, field), before: page.at(-1) ?? state.before, done,
      } }], { actor: actor ?? { by: 'lists-open-index' } }, { list_ref: recordId(slug) });
      return done;
    },

    // One list, its rows (newest ids last) and, for each link field, the linked rows' names. A caller that wants some of
    // the rows says so: `keep(values)` leaves out a row before anything is made of it, and `only` (field ids) keeps
    // just those fields of each row and reads no linked rows. `limit` plus `cursor` opts into an additive bounded page;
    // without them existing callers retain their current result. A page reports whether every candidate row was read,
    // and stops at the configured row/value limits without splitting a value. A caller that wants only the open rows
    // says `open` (invariant 9): they are read from the list's open index, none of the settled rows are loaded, and until
    // the index is ready the rows are the list's as before (the caller's `keep` still leaves the settled ones out).
    read(id, { keep: wanted, only, open = false, order = false, row_ids: namedRowIds, limit: requestedLimit, cursor } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      const requestedRowIds = Array.isArray(namedRowIds) ? namedRowIds.map(rowId => ownRowId(list, rowId)) : namedRowIds;
      const hide = hidden?.(list.id) ?? null;
      const keep = hide ? (values, rowId) => !hide(values, rowId) && (!wanted || wanted(values, rowId)) : wanted;
      const openField = open ? openFieldOf(list) : null;
      const orderConfig = order ? list.ordering : null;
      if (order && orderConfig) this.fillOrdering(slug);
      const uniqueRowIds = Array.isArray(requestedRowIds) ? new Set(requestedRowIds) : null;
      const paged = requestedLimit !== undefined || cursor !== undefined || order;
      const pageLimit = paged ? readPageLimit(requestedLimit) : null;
      if (requestedRowIds !== undefined && (!Array.isArray(requestedRowIds) || requestedRowIds.length > limits.rows_per_read
        || requestedRowIds.some(rowId => typeof rowId !== 'string' || !rowId || rowId.length > 200 || rowId.includes('/'))
        || uniqueRowIds.size !== requestedRowIds.length))
        throw say('bad_row', { index: 'row_ids' });
      if (paged && (requestedRowIds !== undefined || open)) throw say('bad_row', { index: 'row_ids or open with cursor or limit' });
      if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 600 || cursor.includes('/'))) throw say('bad_row', { index: 'cursor' });
      let orderReady = false;
      let orderedEntries = null;
      let orderTuple = null;
      if (order) {
        if (!orderConfig) throw say('bad_order', { list_id: slug });
        orderTuple = decodeOrderCursor(cursor);
        orderReady = !orderTuple?.fallback && listOrderReady(slug, list);
        if (orderReady) orderedEntries = eeaf.scan(typeOfRows(list), orderConfig.index, {
          ...(orderTuple ? { after: orderTuple[0], after_id: `${rowPrefix(list.row_type)}${orderTuple[1]}` } : {}),
          limit: pageLimit,
        });
      }
      const pagedIds = orderReady
        ? orderedEntries.map(entry => entry.id.slice(rowPrefix(list.row_type).length))
        : paged ? eeaf.ids(typeOfRows(list), { ...(cursor !== undefined ? { before: `${rowPrefix(list.row_type)}${orderTuple?.fallback ?? cursor}` } : {}), limit: pageLimit }).map(id => id.slice(rowPrefix(list.row_type).length)) : null;
      const rowIds = requestedRowIds ?? (orderReady ? pagedIds : pagedIds?.slice().reverse()) ?? (openField && openReady(slug, list, openField) ? openRowIds(list, openField) : recentRowIds(list.row_type, limits.rows_per_read));
      const linkFields = only ? [] : list.fields.filter(field => field.links_to);
      // Each linked list is read once for the whole page, not once per cell.
      const linked = new Map();
      for (const field of linkFields) {
        if (linked.has(field.links_to)) continue;
        const target = listAt(recordId(field.links_to));
        linked.set(field.links_to, target ? { ...target, id: field.links_to } : null);
      }
      const readMany = ids => typeof eeaf.readMany === 'function'
        ? eeaf.readMany(ids)
        : new Map(ids.map(id => [id, eeaf.read(id)]));
      let keptRows;
      let page;
      // The named rows' values as this read already read them, so a row it leaves out is not read again below.
      let namedValues = null;
      if (paged) {
        keptRows = [];
        let usedBytes = 0;
        let scanned = 0;
        let lastScanned = null;
        let byteLimited = false;
        let oversizedRow = false;
        for (const rowId of pagedIds) {
          const values = readMany([`${rowPrefix(list.row_type)}${rowId}`]).get(`${rowPrefix(list.row_type)}${rowId}`);
          scanned++;
          lastScanned = rowId;
          if (!values || (keep && !keep(values, rowId))) continue;
          const rowBytes = JSON.stringify(values).length * 2;
          if (keptRows.length && usedBytes + rowBytes > limits.read_page_value_bytes) { byteLimited = true; scanned--; lastScanned = pagedIds[scanned - 1] ?? null; break; }
          keptRows.push({ id: rowId, values });
          usedBytes += rowBytes;
          if (rowBytes > limits.read_page_value_bytes) { oversizedRow = true; byteLimited = true; break; }
        }
        const rowsRemain = orderReady
          ? orderedEntries.length === pageLimit && lastScanned !== null
          : lastScanned !== null && eeaf.ids(typeOfRows(list), { before: `${rowPrefix(list.row_type)}${lastScanned}`, limit: 1 }).length > 0;
        const hasMore = (byteLimited && !oversizedRow) || rowsRemain;
        const lastEntry = orderReady && lastScanned !== null ? orderedEntries.find(entry => entry.id === `${rowPrefix(list.row_type)}${lastScanned}`) : null;
        const nextCursor = !hasMore ? null : orderReady && lastEntry ? encodeOrderCursor(lastEntry.values[0], lastScanned) : order ? `id:${lastScanned}` : lastScanned;
        page = { limit: pageLimit, scanned, returned: keptRows.length, value_bytes: usedBytes, next_cursor: nextCursor, complete: !hasMore, byte_limited: byteLimited, oversized_row: oversizedRow };
      } else {
        // A title-only read has no selected values or computed fields. With no row filter, the current ids
        // establish membership; open only the declared title through the record owner's logical field reader.
        // Hidden/keep predicates still receive complete values, and explicit row_ids retain their existing path.
        const ids = rowIds.map(rowId => `${rowPrefix(list.row_type)}${rowId}`);
        const rowValues = Array.isArray(only) && only.length === 0 && !keep && requestedRowIds === undefined
          && typeof eeaf.fields?.fieldsOf === 'function'
          ? eeaf.fields.fieldsOf(typeOfRows(list), ids, [list.title_field], { groupRoots: true, includeId: false, logicalFields: true })
          : readMany(ids);
        if (requestedRowIds !== undefined) namedValues = rowValues;
        keptRows = rowIds.flatMap(rowId => {
          const values = rowValues.get(`${rowPrefix(list.row_type)}${rowId}`);
          return !values || (keep && !keep(values, rowId)) ? [] : [{ id: rowId, values }];
        });
      }
      const linkedRowIds = new Map();
      let linkedCount = 0;
      for (const field of linkFields) {
        const target = linked.get(field.links_to);
        if (!target) continue;
        const ids = linkedRowIds.get(field.links_to) ?? new Set();
        for (const { values } of keptRows) {
          const value = shape('row-ids', values[field.id]);
          if (Array.isArray(value)) for (const linkId of value) {
            const key = `${rowPrefix(target.row_type)}${linkId}`;
            if (!ids.has(key)) {
              if (paged && ++linkedCount > limits.read_page_links) throw say('page_links_too_large');
              ids.add(key);
            }
          }
        }
        linkedRowIds.set(field.links_to, ids);
      }
      let linkedBytes = 0;
      const linkedValues = new Map([...linkedRowIds].map(([listId, ids]) => {
        if (!paged) return [listId, readMany([...ids])];
        const target = linked.get(listId);
        const titles = new Map();
        for (const key of ids) {
          const values = readMany([key]).get(key);
          const title = (values && titleOf(target, values)) ?? key.slice(rowPrefix(target.row_type).length);
          linkedBytes += JSON.stringify(title).length * 2;
          if (linkedBytes > limits.read_page_value_bytes) throw say('page_links_too_large');
          titles.set(key, title);
        }
        return [listId, titles];
      }));
      if (page) page.linked_value_bytes = linkedBytes;
      const relationshipFields = relationshipFieldsOf(list, only);
      const relate = relationshipFields.length ? relationshipReader(eeaf) : null;
      const historyFields = historyFieldsOf(list, only);
      const readAtMs = Date.now();
      const rows = [];
      for (const { id: rowId, values: kept } of keptRows) {
        const links = {};
        for (const field of linkFields) {
          const target = linked.get(field.links_to);
          const value = shape('row-ids', kept[field.id]);
          if (!Array.isArray(value)) continue;
          links[field.id] = value.map(linkId => {
            const linkedValue = target && linkedValues.get(field.links_to)?.get(`${rowPrefix(target.row_type)}${linkId}`);
            const title = paged ? linkedValue ?? linkId : (linkedValue && titleOf(target, linkedValue)) ?? linkId;
            return { id: linkId, title };
          });
        }
        const values = only ? Object.fromEntries(only.filter(field => field in kept).map(field => [field, kept[field]])) : { ...kept };
        for (const field of list.fields) {
          if (KINDS.get(field.kind)?.carries?.key === 'measure' && (!only || only.includes(field.id))) values[field.id] = progressForListRow(field.measure, kept, progressOfReference);
        }
        // Relationship fields: worked out from the records naming this row (src/list-relationships.mjs), never kept.
        if (relationshipFields.length) Object.assign(values, relate(`${rowPrefix(list.row_type)}${rowId}`, relationshipFields));
        // History fields: worked out from the values a field of this row has held (src/list-value-history.mjs), never kept.
        if (historyFields.length) Object.assign(values, historyValues(kept, historyFields, readAtMs));
        rows.push({ id: rowId, values, title: titleOf(list, kept), links, ...(list.stamps ? { machine_written: machineWritten(kept, list.fields) } : {}) });
      }
      // A row named by an id it no longer has (merged into another) answers where it went.
      const found = new Set(keptRows.map(row => row.id));
      // The named rows not found, and then their tombstones, each read together: a row not kept yet costs a read of every
      // run when read alone. Only a row whose tombstone names where it went is followed (followMerge).
      const readTogether = ids => (ids.length > 1 && typeof eeaf.readMany === 'function' ? eeaf.readMany(ids) : new Map(ids.map(id => [id, eeaf.read(id)])));
      const unfound = (requestedRowIds ?? []).filter(rowId => !found.has(rowId)).map(rowId => `${rowPrefix(list.row_type)}${rowId}`);
      const stood = new Map([...(namedValues ? unfound.filter(id => namedValues.has(id)).map(id => [id, namedValues.get(id)]) : []),
        ...readTogether(unfound.filter(id => !namedValues?.has(id)))]);
      const gone = (requestedRowIds ?? []).filter(rowId => !found.has(rowId) && !stood.get(`${rowPrefix(list.row_type)}${rowId}`));
      const tombstones = readTogether(gone.map(rowId => tombstoneId(slug, rowId)));
      const redirects = gone.filter(rowId => { const next = tombstones.get(tombstoneId(slug, rowId))?.merged_into; return typeof next === 'string' && next; })
        .map(rowId => ({ id: rowId, merged_into: followMerge(slug, rowId, rowPrefix(list.row_type)) })).filter(row => row.merged_into !== row.id);
      return { list: viewsWithFiltersExpanded(list, filterOwner().byId(slug)), field_kinds: data.field_kinds, rows: paged && !orderReady ? rows.reverse() : rows, ...(page ? { page } : {}), ...(redirects.length ? { redirects } : {}),
        ...(order ? { ordering: { ready: orderReady, index: orderConfig.index } } : {}) };
    },

    // Keeps a list: a new one, or an existing one with the fields, label, icon or title field given.
    // kept_elsewhere: lists this person keeps in another of their stores that the fields may link to (src/placed-lists.mjs).
    save(input, { actor, kept_elsewhere = [] } = {}) {
      // What the person keeps of this list (null for a starting list not kept yet), and the list as it reads.
      const kept = input?.id ? keptList(listKey(input.id)) : null;
      const existing = kept ?? (input?.id ? startingShape(listKey(input.id)) : null);
      // Removing a list takes away the list only: its rows are the person's records and stay for whatever else reads them.
      if (input?.remove === true) {
        if (!existing) throw say('no_list', { list_id: input.id });
        write([{ id: recordId(listKey(input.id)), type: data.record_type, value: null }], { actor: actor ?? { by: 'lists' } }, { list_ref: recordId(listKey(input.id)) });
        entityListRemoved(eeaf, listKey(input.id));
        return { removed: listKey(input.id) };
      }
      const { slug, lists, fields, views, partners, list } = shapeList(input, existing, { kept_elsewhere });
      const context = { actor: actor ?? { by: 'lists' } };
      atomic(() => {
        const viewWrites = [];
        if (input?.views !== undefined) {
          const given = new Set(views.map(view => view.id));
          for (const row of viewRecords(slug)) if (!given.has(row.view.id)) viewWrites.push({ id: row.id, type: data.view_records.type, value: null });
          let order = null;
          for (const view of views) viewWrites.push({ id: viewRecordId(slug, view.id), type: data.view_records.type, value: { list_id: slug, view, order: order = keyBetween(order, null) } });
        }
        write([{ id: recordId(slug), type: data.record_type, value: list }, ...viewWrites], context, { list_ref: recordId(slug) });
        // The other side of a pair names this field back in the same write (src/list-pairs.mjs).
        for (const partner of partners) write([{ id: recordId(partner.id), type: data.record_type, value: partner.list }], context, { list_ref: recordId(partner.id) });
      });
      entityListChanged(eeaf, slug, kept, list);
      // Identity keys of rows kept before a field became unique are filled a page at a time; a list with no rows has none to fill.
      if (uniqueFields(list).length && !this.keysReady(slug)) this.fillKeys(slug, { actor });
      // A field that may name another list's rows is looked at again at idle (src/naming-fields.mjs).
      if (actor?.by !== 'naming-fields' && namesWritten(list, [{ values: Object.fromEntries(fields.map(field => [field.id, true])) }])) markNamingDue(eeaf);
      const warnings = nearLimits({ fields_per_list: fields.length, lists_per_person: lists.size, views_per_list: views.length });
      return { list: withViews(slug, list), ...(partners.length ? { paired: partners.map(partner => partner.id) } : {}), ...(warnings.length ? { warnings } : {}) };
    },

    // A list a part of Trillion keeps its own records in (capability checks, voices, the places Trillion speaks): made
    // once, when it is missing, with each of its `starters` rows ({ id, values }) that is not already a record; once it
    // exists it is never written here again, so the list and every row the person or their AI changed or removed stay
    // as they left them.
    ensure({ id, starters = [], ...definition }, { actor } = {}) {
      const slug = listKey(id);
      if (listAt(recordId(slug))) return { list_id: slug, kept: [] };
      // A list kept in another store answers its save as a promise: the starter rows wait for that save, never run ahead of it.
      return thenOr(this.save({ id: slug, ...definition }, { actor }), () => {
        const missing = starters.filter(row => !eeaf.read(`${rowPrefix(definition.row_type)}${row.id}`));
        return missing.length ? this.putRows(slug, { rows: missing }, { actor }) : { list_id: slug, kept: [] };
      });
    },

    // One saved view at a time, kept as a record of its own (lists.json view_records): adding or changing it writes that
    // record only, never the list or its other views. A view the list kept inside itself moves to its own record when saved.
    saveView(id, input, { actor } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      const viewId = input?.id ? listKey(input.id) : listKey(slugOf(input?.label));
      const existing = (list.views ?? []).find(view => view.id === viewId);
      const candidate = { ...existing, ...input, id: viewId };
      const views = checkViews(existing ? list.views.map(view => view.id === viewId ? candidate : view) : [...(list.views ?? []), candidate], list.fields, slug, list.row_sources);
      const view = views.find(item => item.id === viewId);
      filterOwner().checkViewUses(slug, view);
      const own = viewRecords(slug);
      const order = own.find(row => row.view.id === viewId)?.order ?? keyBetween(own.at(-1)?.order ?? null, null);
      const stored = listAt(recordId(slug));
      const records = [{ id: viewRecordId(slug, viewId), type: data.view_records.type, value: { list_id: slug, view, order } }];
      if ((stored.views ?? []).some(item => item.id === viewId)) records.push({ id: recordId(slug), type: data.record_type, value: { ...stored, views: stored.views.filter(item => item.id !== viewId) } });
      write(records, { actor: actor ?? { by: 'lists' } }, { list_ref: recordId(slug) });
      const warnings = nearLimits({ views_per_list: views.length });
      return { list_id: slug, view, ...(warnings.length ? { warnings } : {}) };
    },

    removeView(id, viewId, { actor } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      const wanted = listKey(viewId);
      if (!(list.views ?? []).some(view => view.id === wanted)) throw say('no_view', { list_id: slug, view_id: wanted, views: (list.views ?? []).map(view => view.id).join(', ') || 'none' });
      const stored = listAt(recordId(slug));
      const record = (stored.views ?? []).some(view => view.id === wanted)
        ? { id: recordId(slug), type: data.record_type, value: { ...stored, views: stored.views.filter(view => view.id !== wanted) } }
        : { id: viewRecordId(slug, wanted), type: data.view_records.type, value: null };
      write([record], { actor: actor ?? { by: 'lists' } }, { list_ref: recordId(slug) });
      return { list_id: slug, removed: wanted };
    },

    // Saved filters, each a resource of its own that views and other filters use (src/list-filters.mjs).
    filters(id) { return filterOwner().filters(id); },
    saveFilter(id, input, { actor } = {}) { return filterOwner().save(id, input, { actor }); },
    removeFilter(id, input, { actor } = {}) { return filterOwner().remove(id, input, { actor }); },

    // Puts one view before or after another (`placement`: before or after `anchor_id`). The views a list kept inside itself
    // first gain records of their own, in the order they had, so every view has a place to be moved between.
    moveView(id, { view_id, anchor_id, placement } = {}, { actor } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      const ids = (list.views ?? []).map(view => view.id);
      if (!ids.includes(view_id) || !ids.includes(anchor_id) || view_id === anchor_id || !['before', 'after'].includes(placement))
        throw say('bad_view_move', { list_id: slug, views: ids.join(', ') || 'none' });
      const stored = listAt(recordId(slug));
      const records = [];
      let orders = new Map(viewRecords(slug).map(row => [row.view.id, row.order]));
      if ((stored.views ?? []).length) {
        let order = null;
        orders = new Map();
        for (const view of list.views) {
          orders.set(view.id, order = keyBetween(order, null));
          records.push({ id: viewRecordId(slug, view.id), type: data.view_records.type, value: { list_id: slug, view, order } });
        }
        const { views: _embedded, ...rest } = stored;
        records.push({ id: recordId(slug), type: data.record_type, value: rest });
      }
      const others = ids.filter(viewId => viewId !== view_id);
      const at = others.indexOf(anchor_id) + (placement === 'after' ? 1 : 0);
      const order = keyBetween(at > 0 ? orders.get(others[at - 1]) : null, at < others.length ? orders.get(others[at]) : null);
      const view = list.views.find(item => item.id === view_id);
      const index = records.findIndex(record => record.id === viewRecordId(slug, view_id));
      const moved = { id: viewRecordId(slug, view_id), type: data.view_records.type, value: { list_id: slug, view, order } };
      if (index >= 0) records[index] = moved; else records.push(moved);
      write(records, { actor: actor ?? { by: 'lists' } }, { list_ref: recordId(slug) });
      return { list_id: slug, views: readList(slug).views.map(item => item.id) };
    },

    // Keeps rows (each { id?, values }): values merge into the row's record, null clears a field; and removes rows.
    // A field that `settles` on a value keeps it once a row holds it: a write naming another value leaves it as it is
    // and the answer names it under `settled`, so asking the same thing again can never undo what was finished;
    // null clears it, which is how it is reopened on purpose.
    putRows(id, input = {}, options = {}) {
      if (writeSet || preview) return this.keepRows(id, input, options);
      writeSet = [];
      try {
        const answer = this.keepRows(id, input, options);
        // A record written twice by one call (a row and the other side of its pair) is named once, with every field written.
        const byId = new Map();
        for (const { id: recordId, fields } of writeSet) {
          const earlier = byId.get(recordId);
          byId.set(recordId, { id: recordId, fields: earlier && (earlier.fields === null || fields === null) ? null : earlier ? [...new Set([...earlier.fields, ...fields])] : fields });
        }
        const records = [...byId.values()];
        return { ...answer, write_set: { version: eeaf.lastLogId?.() ?? null, records } };
      } finally { writeSet = null; }
    },
    // putRows itself, without its write_set: the write an outer putRows, a preview or a composed operation makes.
    keepRows(id, { rows: namedRows = [], remove: namedRemove = [] } = {}, { actor } = {}) {
      const mark = eeaf.changeMark?.() ?? null;
      try { return atomic(() => {
      const slug = listKey(id);
      const list = readList(slug);
      // A list whose AI changes wait for a person refuses a gated writer's direct write (src/list-proposals.mjs).
      if (list.review_changes && gatedWriter(actor)) throw say('needs_review', { list_id: slug });
      if (!Array.isArray(namedRows) || !Array.isArray(namedRemove) || namedRows.length + namedRemove.length > limits.rows_per_write) throw say('too_many', { limit: limits.rows_per_write, what: 'rows' });
      const near = nearLimits({ rows_per_write: namedRows.length + namedRemove.length });
      for (const row of namedRows) if (isObject(row) && row.values !== undefined) { const walked = boundedWalk(row.values); if (!walked.ok) throw new ListsError(refusalWords(walked)); }
      let rows = namedRows.map(row => isObject(row) && typeof row.id === 'string' ? { ...row, id: ownRowId(list, row.id) } : row);
      const remove = namedRemove.map(rowId => ownRowId(list, rowId));
      // Check at the same synchronous transaction boundary as the mutation, before either ordinary or
      // configuration-owned writes. A stale reader cannot publish, complete or overwrite an edited row.
      const conflicts = [];
      const conditionFields = new Map(list.fields.map(field => [field.id, field]));
      const conditionalIds = new Set();
      for (const [index, row] of rows.entries()) if (row && (Object.hasOwn(row, 'if_values') || Object.hasOwn(row, 'if_absent'))) {
        if ((Object.hasOwn(row, 'if_values') && !isObject(row.if_values))
          || (Object.hasOwn(row, 'if_absent') && row.if_absent !== true)
          || (Object.hasOwn(row, 'if_absent') && Object.hasOwn(row, 'if_values'))
          || typeof row.id !== 'string' || !row.id || row.id.length > 200 || row.id.includes('/')
          || conditionalIds.has(row.id) || remove.includes(row.id)
          || rows.filter(other => other?.id === row.id).length !== 1) throw say('bad_row', { index });
        conditionalIds.add(row.id);
        if (row.if_absent === true) {
          const current = eeaf.read(`${rowPrefix(list.row_type)}${row.id}`);
          if (current) conflicts.push({ row_id: row.id, found: true, fields: [] });
          continue;
        }
        for (const [fieldId, raw] of Object.entries(row.if_values)) {
          const field = conditionFields.get(fieldId);
          if (!field) throw say('unknown_field', { row_id: row.id, field_id: fieldId, list_id: slug });
          const kind = KINDS.get(field.kind).value;
          if (raw !== null && !fits[kind](shape(kind, raw))) throw say('bad_value', { row_id: row.id, field_id: fieldId, expected: expected[kind] });
          if (JSON.stringify(raw).length > limits.text_chars) throw say('too_long', { row_id: row.id, field_id: fieldId, limit: limits.text_chars });
        }
        const current = eeaf.read(`${rowPrefix(list.row_type)}${row.id}`);
        const changed = Object.entries(row.if_values).filter(([fieldId, raw]) => !sameValue(current?.[fieldId] ?? null,
          raw === null ? null : KINDS.get(conditionFields.get(fieldId).kind).record_pick ? recordText(raw) : shape(KINDS.get(conditionFields.get(fieldId).kind).value, raw))).map(([fieldId]) => fieldId);
        if (!current || changed.length) conflicts.push({ row_id: row.id, found: Boolean(current), fields: changed });
      }
      const conflictedIds = new Set(conflicts.map(conflict => conflict.row_id));
      rows = rows.filter(row => !conflictedIds.has(row?.id));
      const managed = makeConfigurations({eeaf, writeMutation: (records, context) => write(records, context, {list_ref: recordId(slug)})})
        .mutateListRows(list, {rows, remove}, {actor: actor ?? {by: 'lists'}});
      if (managed) return { ...managed, ...(conflicts.length ? { conflicts } : {}) };

      const fields = new Map(list.fields.map(field => [field.id, field]));
      const prefix = rowPrefix(list.row_type);
      // Every row this write names, as it stands before anything is written, read together once: a row not kept yet
      // costs a membership read of every run of the store each time it is read, so a write of many new rows asked the
      // store a read a row, and again for its changes. Reads after the write (and of other records) ask the store.
      const namedIds = [...new Set([...rows.map(row => row?.id), ...remove].filter(rowId => typeof rowId === 'string').map(rowId => `${prefix}${rowId}`))];
      const stood = namedIds.length > 1 && typeof eeaf.readMany === 'function' ? eeaf.readMany(namedIds) : new Map();
      const readStood = rowRecordId => (stood.has(rowRecordId) ? stood.get(rowRecordId) : eeaf.read(rowRecordId));
      const settled = [];
      const keepsHistory = historyKeptBy(list).length > 0;
      const orderField = list.ordering && list.indexes?.find(index => index.name === list.ordering.index)?.fields?.[0];
      let orderTail = null;
      if (orderField) {
        try {
          const ready = typeof eeaf.indexReady !== 'function' || eeaf.indexReady(typeOfRows(list), list.ordering.index);
          if (ready) orderTail = eeaf.scan(typeOfRows(list), list.ordering.index, { reverse: true, limit: 1 })[0]?.values?.[0] ?? null;
        } catch { orderTail = null; }
        if (!orderTail) for (const existingId of recentRowIds(list.row_type, limits.rows_per_read)) {
          const key = eeaf.read(`${prefix}${existingId}`)?.[orderField];
          if (isOrderKey(key) && (orderTail === null || key > orderTail)) orderTail = key;
        }
      }
      const writes = rows.map((row, index) => {
        if (!row || typeof row !== 'object' || !row.values || typeof row.values !== 'object' || Array.isArray(row.values)) throw say('bad_row', { index });
        const rowId = row.id ?? newId();
        if (typeof rowId !== 'string' || !rowId || rowId.length > 200 || rowId.includes('/')) throw say('bad_row', { index });
        const before = readStood(`${prefix}${rowId}`);
        const value = { ...(before ?? {}) };
        // The fields this write sets or clears: a value written anew no longer has the basis it was written with.
        const written = {};
        for (const [fieldId, raw] of Object.entries(row.values)) {
          const field = fields.get(fieldId);
          if (!field) throw say('unknown_field', { row_id: rowId, field_id: fieldId, list_id: slug });
          if (raw === null) {
            if (field.required && before) throw say('required_cleared', { row_id: rowId, field_id: fieldId, list_id: slug });
            delete value[fieldId];
            written[fieldId] = null;
            continue;
          }
          const valueKind = KINDS.get(field.kind).value;
          const read = readInput(field, valueKind, shape(valueKind, raw), rowId);
          if (!fits[valueKind](read)) throw say('bad_value', { row_id: rowId, field_id: fieldId, expected: expected[valueKind] });
          // A link to a row merged into another is a link to the row it became (lists.json history).
          const given = valueKind === 'row-ids' && field.links_to ? mergedInto(field.links_to, read) : read;
          if (JSON.stringify(given).length > limits.text_chars) throw say('too_long', { row_id: rowId, field_id: fieldId, limit: limits.text_chars });
          if ((field.min !== undefined && given < field.min) || (field.max !== undefined && given > field.max)
            || (field.max_chars !== undefined && given.length > field.max_chars)) throw say('out_of_range', { row_id: rowId, field_id: fieldId, min: field.min ?? 'no least', max: field.max ?? 'no most', max_chars: field.max_chars ?? 'no most' });
          if (field.settles?.includes(value[fieldId]) && given !== value[fieldId]) {
            settled.push({ row_id: rowId, field_id: fieldId, kept: value[fieldId], said: say('settled', { row_id: rowId, field_id: fieldId, value: value[fieldId] }).message });
            continue;
          }
          value[fieldId] = given;
          written[fieldId] = given;
        }
        // A row never lacks the field that starts it (a cleared one starts again), so the open index misses none (invariant 9).
        for (const field of list.fields) if (field.starts !== undefined && value[field.id] === undefined) value[field.id] = field.starts;
        // A new row holds every value its list requires; a row kept before the list required one stays editable without it.
        if (!before) for (const field of list.fields) {
          const held = value[field.id];
          if (field.required && (held === undefined || held === null || held === '' || (Array.isArray(held) && !held.length))) throw say('missing_required', { row_id: rowId, field_id: field.id, list_id: slug });
        }
        const basis = checkBasis(row.basis, fields, written, rowId, actor, new Date().toISOString());
        if (value._basis || Object.keys(basis).length) {
          const basisKept = { ...(value._basis ?? {}) };
          for (const fieldId of Object.keys(written)) delete basisKept[fieldId];
          Object.assign(basisKept, basis);
          if (Object.keys(basisKept).length) value._basis = basisKept; else delete value._basis;
        }
        if (list.stamps) restamp(value, written, actor);
        if (keepsHistory) keepValueHistory(list, value, { before, at: new Date().toISOString(), actor });
        // The row a copy was made from (src/list-row-operations.mjs duplicateRows).
        if (typeof row.copied_from === 'string' && row.copied_from && !row.copied_from.includes('/')) value._copied_from = row.copied_from;
        // Rows folded into this one by a merge (src/list-row-operations.mjs), so where an old id went stays on the row.
        if (Array.isArray(row.merged_from) && row.merged_from.every(item => typeof item === 'string' && item && !item.includes('/')))
          value._merged_from = [...new Set([...(value._merged_from ?? []), ...row.merged_from])];
        if (orderField && !isOrderKey(value[orderField])) {
          value[orderField] = keyBetween(orderTail, null);
          orderTail = value[orderField];
        }
        return { id: `${prefix}${rowId}`, type: `record:${list.row_type}`, value, rowId, ...(Array.isArray(row.merged_from) ? { merging: row.merged_from } : {}) };
      });
      const removed = remove.filter(rowId => typeof rowId === 'string' && readStood(`${prefix}${rowId}`));
      const removedIds = new Set(removed.map(rowId => `${prefix}${rowId}`));
      // What the write changes, row by row (a removed row ends as null): the other side of every paired link it changes
      // is written with it (src/list-pairs.mjs), and so are the identity keys its unique fields hold (src/list-keys.mjs).
      const changedRows = () => [...writes.map(entry => ({ recordId: entry.id, rowId: entry.rowId, before: readStood(entry.id), after: removedIds.has(entry.id) ? null : entry.value, merging: entry.merging })),
        ...removed.filter(rowId => !writes.some(entry => entry.rowId === rowId)).map(rowId => ({ recordId: `${prefix}${rowId}`, rowId, before: readStood(`${prefix}${rowId}`), after: null }))];
      const now = new Date().toISOString();
      // A row the other side of a pair changes is stamped, and its field's history kept, like one this write names.
      const touch = (holderList, value, fieldId, before) => keepValueHistory(holderList, holderList.stamps ? restamp(value, { [fieldId]: value[fieldId] ?? null }, actor) : value, { before, at: now, actor });
      // A pair whose other list keeps its rows in another store is written by src/placed-lists.mjs, not by this write.
      const keptApart = field => field.links_to !== slug && (listAt(recordId(field.links_to))?.placement?.database ?? null) !== (list.placement?.database ?? null);
      const pairs = pairWrites({ list, slug, rows: changedRows(), read: id => eeaf.read(id), listOf: other => listAt(recordId(other)), prefixOf: holder => rowPrefix(holder.row_type), touch, keptApart });
      for (const [rowRecordId, value] of pairs.same) {
        const entry = writes.find(item => item.id === rowRecordId);
        if (entry) entry.value = value;
        else writes.push({ id: rowRecordId, type: `record:${list.row_type}`, value, rowId: rowRecordId.slice(prefix.length), paired: true });
      }
      // Every list the write changes is asked before anything is written (the one write road asks again).
      for (const listId of [slug, ...pairs.others.map(other => other.slug)]) mustWrite(listId, actor ?? { by: 'lists' });
      const finalRows = changedRows();
      if (addsForms(list, finalRows) && !this.keysReady(slug)) throw say('unique_index_building', { list_id: slug });
      const keys = keyWrites({ list, slug, rows: finalRows, read: id => eeaf.read(id), prefix });
      if (keys.taken) throw say('not_unique', { ...keys.taken, list_id: slug });
      // A removed row leaves a trash record (restore_list_rows puts it back from the log); a merged row leaves a tombstone.
      const trash = removed.map(rowId => ({ id: trashId(slug, rowId), type: data.history.trash_type, value: { list_id: slug, row_id: rowId, removed_at: now, by: actor?.by ?? 'lists', ...(actor?.via ? { via: actor.via } : {}) } }));
      // A removal also lets go of this list's oldest trash records past history.trash_days (limits.trash_purged_per_write at a time):
      // they are no longer listed, so the list's trash stays as small as the days it keeps. A row put back later still comes back from the log.
      if (removed.length && eeaf.indexDeclared?.(data.history.trash_type, 'list-removed')) {
        const expired = new Date(Date.now() - data.history.trash_days * 86_400_000).toISOString();
        for (const entry of eeaf.scan(data.history.trash_type, 'list-removed', { equal: [slug], limit: limits.trash_purged_per_write })) {
          if (entry.values[1] < expired && !trash.some(record => record.id === entry.id)) trash.push({ id: entry.id, type: data.history.trash_type, value: null });
        }
      }
      const tombstones = rows.flatMap(row => Array.isArray(row?.merged_from) && typeof row.id === 'string' ? row.merged_from.filter(item => typeof item === 'string' && item && !item.includes('/') && item !== row.id)
        .map(old => ({ id: tombstoneId(slug, old), type: data.history.tombstone_type, value: { list_id: slug, row_id: old, merged_into: row.id, at: now } })) : []);
      // Constrained links are checked against the final batch view. The overlay makes same-batch creates,
      // updates and removals visible without enumerating rows; target and ancestor checks stay point reads.
      const prospective = new Map(writes.map(write => [write.id, write.value]));
      const finalRow = rowRecordId => removedIds.has(rowRecordId) ? null
        : prospective.has(rowRecordId) ? prospective.get(rowRecordId) : eeaf.read(rowRecordId);
      const constrained = list.fields.filter(field => field.link_constraints);
      const finalLinks = [];
      for (const [rowRecordId, rowValue] of prospective) {
        if (removedIds.has(rowRecordId)) continue;
        for (const field of constrained) {
          const constraints = field.link_constraints;
          const targetList = listAt(recordId(field.links_to));
          const targetPrefix = targetList && rowPrefix(targetList.row_type);
          const targets = shape('row-ids', rowValue[field.id]);
          const ids = Array.isArray(targets) ? targets.filter(targetId => typeof targetId === 'string') : [];
          // Only an opted-in detach operation removes an edge from the prospective graph.
          const keptIds = field.links_to === slug && field.on_target_remove === 'detach'
            ? ids.filter(targetId => !removedIds.has(`${prefix}${targetId}`)) : ids;
          if (constraints.max_links !== undefined && keptIds.length > constraints.max_links)
            throw say('link_too_many', { row_id: rowRecordId.slice(prefix.length), field_id: field.id, limit: constraints.max_links });
          if (constraints.require_target) for (const targetId of keptIds) {
            if (!targetPrefix || !finalRow(`${targetPrefix}${targetId}`)) throw say('link_target_missing', { row_id: rowRecordId.slice(prefix.length), field_id: field.id, target_id: targetId });
          }
          if (constraints.acyclic) finalLinks.push({ rowRecordId, field, targets: keptIds });
        }
      }
      for (const { rowRecordId: sourceId, field, targets } of finalLinks) {
        const pending = targets.map(targetId => ({ id: `${prefix}${targetId}`, exit: false }));
        const active = new Set([sourceId]);
        const visited = new Set();
        while (pending.length) {
          const { id: currentId, exit } = pending.pop();
          if (exit) { active.delete(currentId); visited.add(currentId); continue; }
          if (active.has(currentId)) throw say('link_cycle', { row_id: sourceId.slice(prefix.length), field_id: field.id });
          if (visited.has(currentId)) continue;
          const current = finalRow(currentId);
          if (!current) continue;
          active.add(currentId);
          pending.push({ id: currentId, exit: true });
          const parents = shape('row-ids', current[field.id]);
          if (Array.isArray(parents)) for (const parentId of parents) {
            if (typeof parentId === 'string' && !(field.on_target_remove === 'detach' && removedIds.has(`${prefix}${parentId}`)))
              pending.push({ id: `${prefix}${parentId}`, exit: false });
          }
        }
      }
      if (list.balanced) refuseUnbalanced(eeaf, list, slug, new Map([...writes.map(write => [write.id, write.value]), ...[...removedIds].map(recordKey => [recordKey, null])]));
      const context = { actor: actor ?? { by: 'lists' } };
      const initial = writes.map(({ rowId, paired: _paired, merging: _merging, ...write }) => write);
      const writeBatch = (sourceSlug, sourceList, records, extra = []) => {
        if (!records.length && !extra.length) return;
        const named = entityIndexWrites(eeaf, sourceSlug, sourceList, new Map(records.map(write => [write.id, write.value])));
        write(records, context, { list_ref: recordId(sourceSlug), alongside: [...named, ...extra] });
        if (!preview) entityIndexWritten(eeaf, named);
      };
      // Apply caller changes first within the transaction. Detachment then removes only deleted targets from the
      // latest row value, preserving unrelated same-request updates and any other links in a multi-link field.
      writeBatch(slug, list, initial, [...keys.records, ...tombstones]);
      for (const other of pairs.others) writeBatch(other.slug, other.list, other.records);
      let pending = new Map();
      const flush = source => {
        if (!pending.size) return;
        const records = [];
        for (const [rowId, targets] of pending) {
          const recordIdValue = `${rowPrefix(source.row_type)}${rowId}`;
          const value = eeaf.read(recordIdValue);
          if (!value) continue;
          let changed = false;
          const next = { ...value };
          for (const [fieldId, gone] of targets) {
            const current = shape('row-ids', next[fieldId]);
            if (!Array.isArray(current)) continue;
            const remaining = current.filter(target => !gone.has(target));
            if (remaining.length === current.length) continue;
            changed = true;
            if (remaining.length) next[fieldId] = remaining;
            else delete next[fieldId];
          }
          if (changed) records.push({ id: recordIdValue, type: `record:${source.row_type}`, value: next });
        }
        pending = new Map();
        writeBatch(source.id, source, records);
      };
      const queue = (source, field, holderId, targetId) => {
        if (holderId.startsWith(`${rowPrefix(list.row_type)}`) && removedIds.has(holderId)) return;
        const rowId = holderId.startsWith(rowPrefix(source.row_type)) ? holderId.slice(rowPrefix(source.row_type).length) : null;
        if (!rowId) return;
        let fields = pending.get(rowId);
        if (!fields) pending.set(rowId, fields = new Map());
        let targets = fields.get(field.id);
        if (!targets) fields.set(field.id, targets = new Set());
        targets.add(targetId);
        if (pending.size >= limits.rows_per_write) flush(source);
      };
      if (removedIds.size) {
        let definitionsBefore;
        for (;;) {
          const definitions = eeaf.ids(data.record_type, { limit: limits.read_page_rows, ...(definitionsBefore ? { before: definitionsBefore } : {}) });
          for (const recordIdValue of definitions) {
            const sourceSlug = recordIdValue.slice(data.record_type.length + 1);
            const sourceValue = eeaf.read(recordIdValue);
            if (!sourceValue) continue;
            const source = { id: sourceSlug, ...sourceValue };
            for (const field of source.fields ?? []) {
              if (field.links_to !== slug || (field.on_target_remove !== 'detach' && !field.link_constraints?.require_target)) continue;
              const targetRowIds = new Set(removed);
              // The store's record of what holds what answers who links to the removed rows when it is complete
              // (linkHolders, kept by every write of this same transaction); while it is being built, or where the store
              // keeps none, a declared source field is read once in bounded pages, independent of the deletion batch size.
              const indexed = this.linkHolders(source.id, { field_id: field.id, target_list: slug, row_ids: removed });
              if (indexed.complete) {
                for (const holder of indexed.holders) {
                  const holderId = `${rowPrefix(source.row_type)}${holder.row_id}`;
                  if (removedIds.has(holderId)) continue;
                  if (field.on_target_remove !== 'detach') throw say('link_target_missing', { row_id: holder.row_id, field_id: field.id, target_id: holder.target });
                  queue(source, field, holderId, holder.target);
                }
                flush(source);
                continue;
              }
              let cursor;
              do {
                const page = this.read(source.id, { only: [field.id], limit: limits.read_page_rows, ...(cursor ? { cursor } : {}) });
                for (const row of page.rows) {
                  const holderId = `${rowPrefix(source.row_type)}${row.id}`;
                  if (removedIds.has(holderId)) continue;
                  const linked = shape('row-ids', row.values[field.id]);
                  if (Array.isArray(linked)) for (const targetRowId of linked) {
                    if (!targetRowIds.has(targetRowId)) continue;
                    if (field.on_target_remove !== 'detach')
                      throw say('link_target_missing', { row_id: row.id, field_id: field.id, target_id: targetRowId });
                    queue(source, field, holderId, targetRowId);
                  }
                }
                const next = page.page?.complete ? null : page.page?.next_cursor;
                if (!page.page?.complete && (!next || next === cursor)) throw new Error('The Lists read returned an incomplete page without an advancing cursor.');
                cursor = next;
              } while (cursor);
              flush(source);
            }
          }
          if (definitions.length < limits.read_page_rows) break;
          const before = definitions.at(-1);
          if (!before || before === definitionsBefore) throw new Error('The list definitions read did not advance its cursor.');
          definitionsBefore = before;
        }
      }
      const deletions = removed.map(rowId => ({ id: `${prefix}${rowId}`, type: `record:${list.row_type}`, value: null }));
      writeBatch(slug, list, deletions, trash);
      if (!preview && actor?.by !== 'naming-fields' && namesWritten(list, rows)) markNamingDue(eeaf);
      const pairedRows = [...writes.filter(write => write.paired).map(write => ({ list_id: slug, row_id: write.rowId })),
        ...pairs.others.flatMap(other => other.records.map(record => ({ list_id: other.slug, row_id: record.id.slice(rowPrefix(other.list.row_type).length) })))];
      return { list_id: slug, ...(pairedRows.length ? { paired: pairedRows } : {}), kept: writes.filter(write => !removedIds.has(write.id) && !write.paired).map(write => ({ id: write.rowId, values: preview ? write.value : eeaf.read(write.id) })), removed, ...(settled.length ? { settled } : {}), ...(conflicts.length ? { conflicts } : {}), ...(near.length ? { warnings: near } : {}) };
      }); } catch (error) { if (!preview) eeaf.forgetCached?.(error, mark); throw error; }
    },

    // What putRows would do with the same request, answered without writing anything: the rows it would keep (and which
    // are new), the rows it would remove, the rows of other lists it would also change (links detached from a removed
    // row), what it would leave settled or in conflict. A request it would refuse comes back as `ok: false` with the
    // refusal's words and what it was about (`refused`: code, row_id, field_id, and for a missing value the fields the
    // list requires), so the caller can mend it and ask again. It is a method of its own, never an option of putRows, so
    // no layer between a caller and the store can drop the option and turn a preview into a write.
    previewRows(id, input = {}, { actor } = {}) {
      if (!isObject(input) || Object.keys(input).some(key => key !== 'rows' && key !== 'remove')) throw say('bad_preview');
      if (preview) throw new Error('A preview is already running.');
      preview = { writes: [] };
      const planned = preview;
      try {
        const slug = listKey(id);
        let answer;
        try { answer = this.putRows(slug, input, { actor }); }
        catch (error) {
          if (!(error instanceof ListsError) && !(error instanceof ConfigurationError)) throw error;
          const detail = error instanceof ListsError ? error.detail ?? {} : { code: error.code };
          const required = detail.code === 'missing_required' ? readList(slug).fields.filter(field => field.required).map(field => ({ field_id: field.id, label: field.label, kind: field.kind })) : undefined;
          return { list_id: slug, dry_run: true, ok: false, refused: { message: error.message, ...detail, ...(required ? { required_fields: required } : {}) } };
        }
        if (answer?.then) throw new Error('A preview needs a list owner that writes at once.');
        const list = readList(slug);
        const prefix = rowPrefix(list.row_type);
        const keptIds = new Set((answer.kept ?? []).map(row => `${prefix}${row.id}`));
        const removedIds = new Set((answer.removed ?? []).map(rowId => `${prefix}${rowId}`));
        return {
          list_id: slug, dry_run: true, ok: true,
          would_keep: (answer.kept ?? []).map(row => ({ id: row.id, created: !eeaf.read(`${prefix}${row.id}`), values: row.values })),
          would_remove: answer.removed ?? [],
          would_also_change: planned.writes.filter(record => !keptIds.has(record.id) && !removedIds.has(record.id)).map(record => ({ record: record.id, removed: record.value === null })),
          ...(answer.settled ? { settled: answer.settled } : {}), ...(answer.conflicts ? { conflicts: answer.conflicts } : {}),
        };
      } finally { preview = null; }
    },

    // The rows of a list removed in the last history.trash_days, newest first: { rows: [{ id, title, removed_at, by }],
    // next_cursor }. Read from the trash records' declared index (src/record-indexes.json), a page at a time; a row kept
    // again since (put back, or written anew) is not listed.
    removedRows(id, { limit, cursor } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      const most = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : limits.read_page_rows, 1), limits.trash_listed);
      let after = null;
      if (cursor !== undefined) {
        try { after = JSON.parse(cursor); } catch { after = null; }
        if (!Array.isArray(after) || after.length !== 2 || after.some(part => typeof part !== 'string')) throw say('bad_row', { index: 'cursor' });
      }
      const since = new Date(Date.now() - data.history.trash_days * 86_400_000).toISOString();
      const entries = eeaf.scan(data.history.trash_type, 'list-removed', { equal: [slug], ...(after ? { to: after[0] } : {}), reverse: true, limit: most + limits.rows_per_write + 1 })
        .filter(entry => !after || entry.values[1] < after[0] || (entry.values[1] === after[0] && entry.id < after[1]));
      const prefix = rowPrefix(list.row_type);
      const rows = [];
      let last = null;
      for (const entry of entries) {
        if (entry.values[1] < since || rows.length >= most) break;
        last = entry;
        const trash = eeaf.read(entry.id);
        if (!trash || eeaf.read(`${prefix}${trash.row_id}`)) continue;
        rows.push({ id: trash.row_id, title: titleOf(list, removedValue(`${prefix}${trash.row_id}`)) ?? trash.row_id, removed_at: trash.removed_at, by: trash.by, said: viaWords(trash) });
      }
      const more = rows.length >= most && entries.length > entries.indexOf(last) + 1;
      return { list_id: slug, rows, next_cursor: more ? JSON.stringify([last.values[1], last.id]) : null };
    },

    // Puts removed rows back exactly as they were before their removal, from the log (src/list-history: a removal keeps
    // what it removed): { restored, not_restored: [{ row_id, reason }] }. A row kept again since stays as it is; a row whose
    // history is no longer kept cannot come back. The other side of its paired links and its identity keys come back with it.
    restoreRows(id, { row_ids } = {}, { actor } = {}) {
      const mark = eeaf.changeMark?.() ?? null;
      try { return atomic(() => {
        const slug = listKey(id);
        const list = readList(slug);
        if (!Array.isArray(row_ids) || !row_ids.length || row_ids.length > limits.rows_per_write || row_ids.some(rowId => typeof rowId !== 'string' || !rowId || rowId.includes('/')))
          throw say('bad_restore', { limit: limits.rows_per_write });
        const prefix = rowPrefix(list.row_type);
        const restored = [], notRestored = [], trash = [];
        for (const rowId of [...new Set(row_ids)]) {
          const rowRecordId = `${prefix}${rowId}`;
          if (eeaf.read(rowRecordId)) { notRestored.push({ row_id: rowId, reason: 'kept' }); continue; }
          const held = eeaf.read(trashId(slug, rowId));
          const value = removedValue(rowRecordId);
          if (!value) { notRestored.push({ row_id: rowId, reason: 'history_gone' }); continue; }
          restored.push({ recordId: rowRecordId, rowId, before: null, after: value });
          if (held) trash.push({ id: trashId(slug, rowId), type: data.history.trash_type, value: null });
        }
        const touch = (holderList, value, fieldId) => (holderList.stamps ? restamp(value, { [fieldId]: value[fieldId] ?? null }, actor) : value);
        // A pair whose other list keeps its rows in another store is written by src/placed-lists.mjs, not by this write.
        const keptApart = field => field.links_to !== slug && (listAt(recordId(field.links_to))?.placement?.database ?? null) !== (list.placement?.database ?? null);
        const pairs = pairWrites({ list, slug, rows: restored, read: recordIdValue => eeaf.read(recordIdValue), listOf: other => listAt(recordId(other)), prefixOf: holder => rowPrefix(holder.row_type), touch, keptApart });
        const rows = restored.map(row => ({ ...row, after: pairs.same.get(row.recordId) ?? row.after }));
        if (addsForms(list, rows) && !this.keysReady(slug)) throw say('unique_index_building', { list_id: slug });
        const keys = keyWrites({ list, slug, rows, read: recordIdValue => eeaf.read(recordIdValue), prefix });
        if (keys.taken) throw say('not_unique', { ...keys.taken, list_id: slug });
        const records = [...rows.map(row => ({ id: row.recordId, type: `record:${list.row_type}`, value: row.after })),
          ...[...pairs.same].filter(([recordIdValue]) => !rows.some(row => row.recordId === recordIdValue)).map(([recordIdValue, value]) => ({ id: recordIdValue, type: `record:${list.row_type}`, value }))];
        const context = { actor: actor ?? { by: 'lists' } };
        if (records.length) {
          const named = entityIndexWrites(eeaf, slug, list, new Map(records.map(record => [record.id, record.value])));
          write(records, context, { list_ref: recordId(slug), alongside: [...named, ...keys.records, ...trash] });
          if (!preview) entityIndexWritten(eeaf, named);
        }
        for (const other of pairs.others) write(other.records, context, { list_ref: recordId(other.slug) });
        return { list_id: slug, restored: rows.map(row => row.rowId), not_restored: notRestored };
      }); } catch (error) { eeaf.forgetCached?.(error, mark); throw error; }
    },

    // One field of many rows as it was at a moment (`at`: an ISO time or a log row id), from the log the store keeps
    // (parts/record-log record-time readAt): { values: [{ row_id, value, existed, complete, kept_from }] }. A row whose
    // changes since `at` are no longer all kept says complete: false and how far back it can be read.
    // With no `row_ids` it reads the column: the list's rows a page at a time (`limit` at most limits.field_at_rows, `cursor`
    // from the last answer's next_cursor), so one field of every row at a moment is a loop of these calls, not a list of ids.
    fieldAt(id, { row_ids, field_id, at, limit, cursor } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      let next = null;
      if (row_ids === undefined || row_ids === null) {
        if (!list.fields.some(field => field.id === field_id) || typeof at !== 'string' || !at) throw say('bad_field_at', { list_id: slug, limit: limits.field_at_rows });
        const page = this.read(slug, { limit: Math.min(Number.isInteger(limit) && limit > 0 ? limit : limits.field_at_rows, limits.field_at_rows), ...(cursor === undefined || cursor === null ? {} : { cursor }), only: [] });
        row_ids = page.rows.map(row => row.id);
        next = page.page?.next_cursor ?? null;
        if (!row_ids.length) return { list_id: slug, field_id, at, values: [], next_cursor: next };
      }
      if (!list.fields.some(field => field.id === field_id) || typeof at !== 'string' || !at || !Array.isArray(row_ids) || !row_ids.length
        || row_ids.length > limits.field_at_rows || row_ids.some(rowId => typeof rowId !== 'string' || !rowId || rowId.includes('/')))
        throw say('bad_field_at', { list_id: slug, limit: limits.field_at_rows });
      if (typeof eeaf.log !== 'function' || typeof eeaf.storedRecord !== 'function') throw say('history_unavailable', { list_id: slug });
      const prefix = rowPrefix(list.row_type);
      let values;
      try {
        values = [...new Set(row_ids)].map(rowId => {
          const then = readAt(eeaf, `${prefix}${rowId}`, at);
          return { row_id: rowId, value: then.value?.[field_id] ?? null, existed: then.value !== null, complete: then.complete, ...(then.complete ? {} : { kept_from: then.kept_from }) };
        });
      } catch (error) {
        if (/neither a time nor a log row id/.test(error.message)) throw say('bad_field_at', { list_id: slug, limit: limits.field_at_rows });
        throw error;
      }
      return { list_id: slug, field_id, at, values, ...(next === null ? {} : { next_cursor: next }) };
    },

    // The values one field of one row has held, as lines a person reads (src/list-value-history.mjs): { complete, steps:
    // [{ value, from, until, by, said }] }, for a field that says keeps_history: true. One point read.
    fieldHistory(id, { row_id, field_id } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      if (typeof row_id !== 'string' || !row_id || row_id.includes('/')) throw say('bad_row', { index: 'row_id' });
      return fieldHistoryOf(list, slug, row_id, eeaf.read(`${rowPrefix(list.row_type)}${row_id}`), field_id);
    },

    // Changes an AI proposes and a person decides (src/list-proposals.mjs): kept beside the list, applied once.
    proposeChanges(id, input = {}, { actor } = {}) { return listProposals({ eeaf, write, transaction, readList, rowPrefix, lists: this }).propose(listKey(id), input, { actor }); },
    proposals(id, options = {}) { return listProposals({ eeaf, write, transaction, readList, rowPrefix, lists: this }).proposals(listKey(id), options); },
    proposal(id, { proposal_id } = {}) { return listProposals({ eeaf, write, transaction, readList, rowPrefix, lists: this }).proposal(listKey(id), proposal_id); },
    decideProposal(id, { proposal_id, decision } = {}, { actor } = {}) { return listProposals({ eeaf, write, transaction, readList, rowPrefix, lists: this }).decide(listKey(id), proposal_id, { decision }, { actor }); },

    // A use of rows (opened, read for an answer): each row's heat grows by use_heat.add, at most once per min_gap
    // (src/list-review.mjs usedHeat), kept as one small record beside the row. { used: [ids], already_warm: [ids] }.
    noteUse(id, { row_ids } = {}, { actor } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      if (!Array.isArray(row_ids) || !row_ids.length || row_ids.length > limits.rows_per_write || row_ids.some(rowId => typeof rowId !== 'string' || !rowId || rowId.includes('/')))
        throw say('bad_row', { index: 'row_ids' });
      const now = Date.now();
      const records = [];
      const warm = [];
      for (const rowId of new Set(row_ids)) {
        if (!eeaf.read(`${rowPrefix(list.row_type)}${rowId}`)) continue;
        const next = usedHeat(eeaf.read(heatId(slug, rowId)), now);
        if (next) records.push({ id: heatId(slug, rowId), type: data.use_heat.type, value: { list_id: slug, row_id: rowId, ...next } });
        else warm.push(rowId);
      }
      if (records.length) write(records, { actor: actor ?? { by: 'lists' } });
      return { list_id: slug, used: records.map(record => record.value.row_id), already_warm: warm };
    },
    // Each row's kept heat record ({ heat, at } or absent), by point reads.
    heatOf(id, { row_ids } = {}) {
      const slug = listKey(id);
      readList(slug);
      if (!Array.isArray(row_ids) || row_ids.length > limits.rows_per_read) throw say('bad_row', { index: 'row_ids' });
      const heats = {};
      for (const rowId of row_ids) {
        const kept = typeof rowId === 'string' && !rowId.includes('/') ? eeaf.read(heatId(slug, rowId)) : null;
        if (kept) heats[rowId] = { heat: kept.heat, at: kept.at };
      }
      return { list_id: slug, heats };
    },

    // The rows of this list whose link field `field_id` names each of `row_ids` of `target_list`, from the store's own
    // record of what holds what (participation, kept on every write): { complete, holders: [{ target, row_id }] }, or
    // complete: false when that record is still being built or a target has more holders than limits.backlinks_returned,
    // so the caller reads the rows instead (src/list-row-operations.mjs backlinks).
    linkHolders(id, { field_id, target_list, row_ids } = {}) {
      const slug = listKey(id);
      const list = readList(slug);
      const field = list.fields.find(item => item.id === field_id && KINDS.get(item.kind)?.links && item.links_to === target_list);
      if (!field || !Array.isArray(row_ids) || row_ids.length > limits.rows_per_write) throw say('bad_row', { index: 'row_ids' });
      // Only a store whose model keeps this link field as participation (src/record-model.json declared_by) can answer.
      const declared = typeof eeaf.holdersOf === 'function' && typeof eeaf.model === 'function'
        && eeaf.model({ type: typeOfRows(list) }).kinds[0]?.parts?.some(part => part.role === field.id);
      if (!declared) return { list_id: slug, complete: false, holders: [] };
      const target = listAt(recordId(field.links_to));
      const prefix = rowPrefix(list.row_type);
      const holders = [];
      let complete = true;
      for (const rowId of row_ids) {
        const page = eeaf.holdersOf(target ? `${rowPrefix(target.row_type)}${rowId}` : rowId, { role: field.id, limit: limits.backlinks_returned });
        complete &&= page.complete !== false && !page.next;
        for (const holder of page.holders) if (holder.id.startsWith(prefix)) holders.push({ target: rowId, row_id: holder.id.slice(prefix.length) });
      }
      return { list_id: slug, complete, holders: [...new Map(holders.map(holder => [`${holder.target}\u0000${holder.row_id}`, holder])).values()] };
    },

    // A view's rows held still (lists.json snapshots): the ids given are kept as one record, which lasts snapshots.minutes;
    // a list keeps at most limits.snapshots_kept, the oldest going first. Answers { snapshot_id, total, expires_at }.
    keepSnapshot(id, { view_id = null, ids, complete = true } = {}, { actor } = {}) {
      const slug = listKey(id);
      readList(slug);
      if (!Array.isArray(ids) || ids.length > limits.snapshot_rows || ids.some(rowId => typeof rowId !== 'string')) throw say('bad_snapshot', { limit: limits.snapshot_rows });
      const created = new Date();
      const snapshotId = newId();
      const value = { list_id: slug, ...(typeof view_id === 'string' ? { view_id } : {}), ids, complete: complete === true, created_at: created.toISOString(), expires_at: new Date(created.getTime() + data.snapshots.minutes * 60_000).toISOString() };
      const older = eeaf.scan(data.snapshots.type, 'list-snapshots', { equal: [slug], limit: limits.snapshots_kept + 1 });
      const gone = older.filter((entry, index) => index < older.length - limits.snapshots_kept + 1 || (eeaf.read(entry.id)?.expires_at ?? '') < value.created_at)
        .map(entry => ({ id: entry.id, type: data.snapshots.type, value: null }));
      write([{ id: `${data.snapshots.type}:${snapshotId}`, type: data.snapshots.type, value }, ...gone], { actor: actor ?? { by: 'lists' } });
      return { list_id: slug, snapshot_id: snapshotId, total: ids.length, complete: value.complete, expires_at: value.expires_at };
    },
    readSnapshot(id, { snapshot_id } = {}) {
      const slug = listKey(id);
      const held = typeof snapshot_id === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(snapshot_id) ? eeaf.read(`${data.snapshots.type}:${snapshot_id}`) : null;
      if (!held || held.list_id !== slug) throw say('no_snapshot', { list_id: slug, snapshot_id: JSON.stringify(snapshot_id) });
      if (held.expires_at < new Date().toISOString()) throw say('snapshot_expired', { snapshot_id, minutes: data.snapshots.minutes });
      return held;
    },

    // Removes this store's copies of rows that now live in another store (src/placed-lists.mjs, after a move): only the
    // rows named, at most rows_per_write, and nothing that links to them changes, because the rows themselves live on
    // where the list now keeps them.
    retire(id, rowIds = [], { actor } = {}) {
      const mark = eeaf.changeMark?.() ?? null;
      try { return transaction(() => {
        const slug = listKey(id);
        const list = readList(slug);
        if (!Array.isArray(rowIds) || rowIds.length > limits.rows_per_write) throw say('bad_row', { index: 'retire' });
        const prefix = rowPrefix(list.row_type);
        const records = rowIds.filter(rowId => typeof rowId === 'string' && rowId && !rowId.includes('/') && eeaf.read(`${prefix}${rowId}`))
          .map(rowId => ({ id: `${prefix}${rowId}`, type: `record:${list.row_type}`, value: null }));
        if (records.length) {
          const named = entityIndexWrites(eeaf, slug, list, new Map(records.map(record => [record.id, record.value])));
          write(records, { actor: actor ?? { by: 'lists' } }, { list_ref: recordId(slug), alongside: named });
          entityIndexWritten(eeaf, named);
        }
        return { list_id: slug, retired: records.map(record => record.id.slice(prefix.length)) };
      }); } catch (error) { eeaf.forgetCached?.(error, mark); throw error; }
    },

    // Move one row between the supplied neighbours using the list's declared single-field order index.
    // The field stores fractional keys, so one move writes one row regardless of list size. Neighbours are
    // checked against the live index inside the same transaction; stale drag/drop requests fail closed.
    moveRow(id, { row_id, index, before_id = null, after_id = null, anchor_id, placement } = {}, { actor } = {}) {
      const mark = eeaf.changeMark?.() ?? null;
      try { return transaction(() => {
        const slug = listKey(id);
        const list = readList(slug);
        const declared = (list.indexes ?? []).find(candidate => candidate.name === index);
        if (!declared || declared.fields.length !== 1) throw say('bad_order', { list_id: slug });
        const fieldId = declared.fields[0];
        const field = list.fields.find(candidate => candidate.id === fieldId);
        if (!field || field.kind !== 'text') throw say('bad_order', { list_id: slug });
        const validRowId = value => value === null || (typeof value === 'string' && value && value.length <= 200 && !value.includes('/'));
        if (!validRowId(row_id) || row_id === null || !validRowId(before_id) || !validRowId(after_id)
          || (anchor_id === undefined && before_id === null && after_id === null) || before_id === row_id || after_id === row_id
          || (before_id !== null && before_id === after_id)) throw say('bad_order', { list_id: slug });
        const type = typeOfRows(list);
        const prefix = rowPrefix(list.row_type);
        if (typeof eeaf.indexReady === 'function' && !eeaf.indexReady(type, index)) throw say('order_index_building', { list_id: slug });
        if (list.ordering?.index === index && !listOrderReady(slug, list)) throw say('order_index_building', { list_id: slug });
        const readKey = rowId => {
          const value = eeaf.read(`${prefix}${rowId}`);
          if (!value) throw say('stale_order', { list_id: slug });
          const key = value[fieldId];
          if (!isOrderKey(key)) throw say('stale_order', { list_id: slug });
          return key;
        };
        if (anchor_id !== undefined) {
          if (typeof anchor_id !== 'string' || !anchor_id || anchor_id.length > 200 || anchor_id.includes('/')
            || !['before', 'after'].includes(placement) || anchor_id === row_id) throw say('bad_order', { list_id: slug });
          const anchorKey = readKey(anchor_id);
          if (placement === 'before') {
            const previous = eeaf.scan(type, index, { before: anchorKey, reverse: true, limit: 3 })
              .filter(entry => entry.id !== `${prefix}${row_id}`);
            after_id = previous[0]?.id.slice(prefix.length) ?? null;
            before_id = anchor_id;
          } else {
            const following = eeaf.scan(type, index, { after: anchorKey, after_id: `${prefix}${anchor_id}`, limit: 3 })
              .filter(entry => entry.id !== `${prefix}${row_id}`);
            after_id = anchor_id;
            before_id = following[0]?.id.slice(prefix.length) ?? null;
          }
        }
        const movedKey = readKey(row_id);
        const beforeKey = before_id === null ? null : readKey(before_id);
        const afterKey = after_id === null ? null : readKey(after_id);
        if (beforeKey !== null && afterKey !== null && afterKey >= beforeKey) throw say('stale_order', { list_id: slug });

        const nextKey = keyBetween(afterKey, beforeKey);
        if (movedKey === nextKey) return { list_id: slug, row_id, order: movedKey, moved: false };

        // Check the destination against the live tuple order after removing this row. The id tie-breaker matters
        // when concurrent writers have assigned equal fractional keys. `after_id` is the previous row and
        // `before_id` the next row.
        const intervening = after_id === null
          ? eeaf.scan(type, index, { before: beforeKey, reverse: true, limit: 3 })
          : eeaf.scan(type, index, {
            after: afterKey,
            after_id: `${prefix}${after_id}`,
            limit: 3,
          });
        const remaining = intervening.filter(entry => entry.id !== `${prefix}${row_id}`);
        if (after_id === null) {
          if (remaining.length) throw say('stale_order', { list_id: slug });
        } else if (before_id === null) {
          if (remaining.length) throw say('stale_order', { list_id: slug });
        } else if (remaining[0]?.id !== `${prefix}${before_id}`) {
          throw say('stale_order', { list_id: slug });
        }
        const current = eeaf.read(`${prefix}${row_id}`);
        const value = { ...current, [fieldId]: nextKey };
        const record = { id: `${prefix}${row_id}`, type, value };
        const named = entityIndexWrites(eeaf, slug, list, new Map([[record.id, value]]));
        write([record], { actor: actor ?? { by: 'lists' } }, { list_ref: recordId(slug), alongside: named });
        entityIndexWritten(eeaf, named);
        return { list_id: slug, row_id, order: nextKey, moved: true };
      }); } catch (error) { eeaf.forgetCached?.(error, mark); throw error; }
    },
  };
}

// ---- Rows from a source outside the person's records ----
// A list may also show rows another owner keeps (the service's own checks, read where they are published), read at
// request time from a row source: a capability the owner wiring hands in by name (`sources`: name → read), never one
// this file names. The sources a list shows are declared by the list (`row_sources: [{ source, of? }]`, kept like any
// field of it) or, for a list a part of Trillion keeps, by that part's DATA (`declared(listId)`). A read pages the
// person's own rows first and then each source's rows in order; a search and a saved view see them like any row. A
// source row is the source's: it is never written into the person's records; a source that keeps its own rows' changes
// (`read.write`) is handed a write that names them, and one that names its values by namespace (src/lists.json
// source_namespaces) says their kinds (`read.fields`).
//   read({ list, source, limit, cursor, row_ids }) → { rows: [{ id, values, title? }], next_cursor }   (async)
//   read.fields({ list, source, ids }) → [{ id, label, kind }]                                           (async, optional)
//   read.write({ list, source, rows, remove }) → { list_id, kept, removed }                              (async, optional)
const SOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SOURCE_CURSOR = 'src~';
// `of` narrows a source to the rows of one thing it keeps (the parts of one job, src/work-item-rows.mjs), by that thing's id.
const SOURCE_OF_CHARS = 200;
function checkRowSources(rows) {
  if (rows === null || rows === undefined) return null;
  if (!Array.isArray(rows) || rows.length > limits.row_sources_per_list || rows.some(row => !isObject(row) || Object.keys(row).some(key => key !== 'source' && key !== 'of') || !SOURCE_NAME.test(row.source ?? '')
    || (row.of !== undefined && (typeof row.of !== 'string' || !row.of.trim() || row.of.length > SOURCE_OF_CHARS))))
    throw say('bad_row', { index: 'row_sources' });
  return rows.length ? rows.map(row => ({ source: row.source, ...(row.of === undefined ? {} : { of: row.of.trim() }) })) : null;
}
const sourceRowId = (source, id) => `${source}~${id}`;

const PLACED_DATABASE = /^[a-zA-Z0-9_-]{1,100}$/;
// Where a list's rows are kept (src/placed-lists.mjs owns every change of it): `database` is the store that answers for
// the rows (none: this store); `moving` names the store they are being copied to and how far the copy has come;
// `retiring` names the store they were copied from, whose copies are being removed; `earlier` names each store the
// rows were kept in before, and until when, so their history before that time is found there. Only the steps of a
// move change it: start (moving set), advance (its cursor), flip (database becomes moving.to, retiring the old one) and
// retired (retiring cleared). An ordinary save that sends the same placement, or none, keeps it.
const PLACEMENT_KEYS = new Set(['database', 'moving', 'retiring', 'earlier']);
const placedName = value => value === undefined || PLACED_DATABASE.test(value);
const placementShape = given => isObject(given) && Object.keys(given).every(key => PLACEMENT_KEYS.has(key)) && placedName(given.database)
  && (given.moving === undefined || (isObject(given.moving) && PLACED_DATABASE.test(given.moving.to ?? '') && given.moving.to !== given.database
    && (given.moving.cursor === null || (typeof given.moving.cursor === 'string' && given.moving.cursor.length <= 1000))
    && Number.isSafeInteger(given.moving.copied) && given.moving.copied >= 0))
  && (given.retiring === undefined || (isObject(given.retiring) && placedName(given.retiring.database) && typeof given.retiring.until === 'string'))
  && (given.earlier === undefined || (Array.isArray(given.earlier) && given.earlier.length <= limits.placement_earlier
    && given.earlier.every(row => isObject(row) && placedName(row.database) && typeof row.until === 'string')))
  && !(given.moving && given.retiring) && Object.keys(given).length > 0;
const samePlacement = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// A list that refuses any write leaving a group of signed lines not adding to zero (invariant 12): the amount field is a
// number, the group field names the entry, and a declared index on the group field finds an entry's lines.
function checkBalanced(given, fields, indexes, managedRows, slug) {
  if (given === undefined || given === null) return null;
  const byId = new Map(fields.map(field => [field.id, field]));
  const index = isObject(given) ? indexes.find(candidate => candidate.name === given.index) : null;
  if (!isObject(given) || Object.keys(given).some(key => !['amount_field', 'group_field', 'index'].includes(key))
    || KINDS.get(byId.get(given.amount_field)?.kind)?.value !== 'number' || !byId.has(given.group_field) || given.amount_field === given.group_field
    || !index || index.fields.length !== 1 || index.fields[0] !== given.group_field || managedRows) throw say('bad_balanced', { list_id: slug });
  return { amount_field: given.amount_field, group_field: given.group_field, index: given.index };
}

// Throws unless every entry this write touches still adds to zero once the write is applied (all lines present, summed in
// whole units). `after` maps each written or removed row's record id to its new value, or null when removed.
function refuseUnbalanced(eeaf, list, slug, after) {
  const { amount_field: amountField, group_field: groupField, index } = list.balanced;
  const type = `record:${list.row_type}`;
  if (typeof eeaf.indexReady === 'function' && !eeaf.indexReady(type, index)) throw say('balanced_index_building', { list_id: slug });
  const prefix = rowPrefix(list.row_type);
  const groups = new Set();
  for (const [recordKey, value] of after) {
    for (const held of [eeaf.read(recordKey), value]) if (typeof held?.[groupField] === 'string' && held[groupField]) groups.add(held[groupField]);
    if (value && (unitsOf(value[amountField]) === null || typeof value[groupField] !== 'string' || !value[groupField]))
      throw say('balanced_incomplete', { row_id: recordKey.slice(prefix.length), list_id: slug });
  }
  for (const group of groups) {
    const seen = new Set();
    let sum = 0;
    for (const { id: recordKey } of eeaf.scan(type, index, { equal: [group], all: true })) {
      seen.add(recordKey);
      const held = after.has(recordKey) ? after.get(recordKey) : eeaf.read(recordKey);
      if (held?.[groupField] === group) sum += unitsOf(held[amountField]) ?? 0;
    }
    for (const [recordKey, held] of after) if (!seen.has(recordKey) && held?.[groupField] === group) sum += unitsOf(held[amountField]) ?? 0;
    if (sum !== 0) throw say('unbalanced_write', { group, sum: sum / SETTLEMENT_SCALE, list_id: slug });
  }
}

function checkPlacement(given, kept) {
  if (given === undefined || given === null || samePlacement(given, kept)) return kept ?? null;
  if (!placementShape(given)) throw say('bad_row', { index: 'placement' });
  const settled = place => place && !place.moving && !place.retiring;
  const legal = !kept ? (settled(given) && given.database !== undefined) || (given.moving && given.database === undefined && !given.earlier)
    : settled(kept) && given.moving ? given.database === kept.database && samePlacement(given.earlier, kept.earlier)
      : kept.moving && given.moving ? given.database === kept.database && given.moving.to === kept.moving.to && given.moving.copied >= kept.moving.copied
        : kept.moving && given.retiring ? given.database === kept.moving.to && given.retiring.database === kept.database
          : kept.retiring && settled(given) ? given.database === kept.database && samePlacement(given.earlier, kept.earlier)
            : false;
  if (!legal) throw say('bad_row', { index: 'placement' });
  return structuredClone(given);
}

/** `lists` with its reads and searches also showing the rows each list's row sources give (see above). */
export function withRowSources(lists, { sources = {}, declared = () => null } = {}) {
  const sourcesOf = list => (declared(list.id) ?? list.row_sources ?? []).filter(row => typeof sources[row.source] === 'function');
  const shape = (list, source, row) => ({ id: sourceRowId(source.source, row.id), values: row.values ?? {}, title: (list.title_field && row.values?.[list.title_field]) ?? row.title ?? row.id, links: {}, source: source.source });
  const fromSource = async (list, index, { limit, cursor, row_ids } = {}) => {
    const source = sourcesOf(list)[index];
    const wanted = row_ids?.filter(id => id.startsWith(`${source.source}~`)).map(id => id.slice(source.source.length + 1));
    if (row_ids && !wanted.length) return { rows: [], next_cursor: null };
    const answer = await sources[source.source]({ list, source, limit: Math.min(limit ?? limits.rows_per_read, limits.rows_per_read), cursor: cursor ?? null, ...(wanted ? { row_ids: wanted } : {}) });
    return { rows: (answer?.rows ?? []).slice(0, limit ?? limits.rows_per_read).map(row => shape(list, source, row)), next_cursor: answer?.next_cursor ?? null };
  };
  const decode = cursor => {
    if (typeof cursor !== 'string' || !cursor.startsWith(SOURCE_CURSOR)) return null;
    const [index, ...rest] = cursor.slice(SOURCE_CURSOR.length).split('~');
    return { index: Number(index), cursor: rest.join('~') || null };
  };
  const wrapped = Object.create(lists);
  // Rows read from a source are not in this store's records: a read of such a list depends on more than they say.
  wrapped.dependsOf = (id, options) => {
    const list = lists.find(id);
    return list && sourcesOf(list).length ? null : lists.dependsOf(id, options);
  };
  wrapped.changes = (id, since) => {
    const result = lists.changes(id, since);
    const list = lists.find(id);
    return list && sourcesOf(list).length ? { ...result, reset: true, row_ids: null } : result;
  };
  wrapped.read = async (id, options = {}) => {
    const list = lists.find(id);
    if (!list || !sourcesOf(list).length) return lists.read(id, options);
    const at = decode(options.cursor);
    const paged = options.limit !== undefined || options.cursor !== undefined || options.order;
    const own = at ? { ...(await lists.read(id, { ...options, cursor: undefined, limit: 1 })), rows: [], page: { limit: options.limit ?? limits.read_page_rows, returned: 0, complete: true, next_cursor: null } } : await lists.read(id, options);
    if (paged && own.page && !own.page.complete) return own;
    const named = sourcesOf(list);
    const rows = [...own.rows];
    let index = at?.index ?? 0, cursor = at?.cursor ?? null, next = null;
    // A page stops where its limit is reached and says where to go on; a whole read follows each source's own cursor
    // to its end, bounded like any whole read (rows_per_read).
    while (index < named.length) {
      const room = (paged ? (own.page?.limit ?? limits.read_page_rows) : limits.rows_per_read) - rows.length;
      if (room <= 0) { if (paged) next = `${SOURCE_CURSOR}${index}~${cursor ?? ''}`; break; }
      const page = await fromSource(list, index, { limit: room, cursor, row_ids: options.row_ids });
      const kept = options.keep ? page.rows.filter(row => options.keep(row.values, row.id)) : page.rows;
      rows.push(...kept);
      if (page.next_cursor && page.rows.length) {
        if (paged) { next = `${SOURCE_CURSOR}${index}~${page.next_cursor}`; break; }
        cursor = page.next_cursor;
        continue;
      }
      index += 1; cursor = null;
    }
    return { ...own, rows, ...(own.page ? { page: { ...own.page, returned: rows.length, next_cursor: next, complete: next === null } } : {}) };
  };
  wrapped.search = async input => {
    const answer = await lists.search(input);
    const q = String(input?.q ?? '').trim().toLowerCase();
    const wanted=(input?.lists??[]).map(name=>name.replace(/^list:/,'')), types=input?.row_types??[];
    const names = wanted.length && !types.length && !input?.holds ? wanted : ((await lists.all()).lists ?? []).map(list => list.id);
    const scoped = names.map(name => lists.find(name)).filter(list => list &&
      (!(wanted.length || types.length || input?.holds) || wanted.includes(list.id) || types.includes(list.row_type) || holdsList(input?.holds, list)));
    const found = [];
    for (const list of scoped.slice(0, limits.search_lists)) {
      for (let index = 0; index < sourcesOf(list).length; index += 1) {
        for (const row of (await fromSource(list, index, { limit: limits.rows_per_read })).rows) {
          if (String(row.title).toLowerCase().includes(q)) found.push({ id: row.id, list_id: list.id, list_label: list.label, title: row.title, detail: null });
        }
      }
    }
    const most = Math.min(Number(input?.limit) || limits.search_default, limits.search_most);
    return { ...answer, rows: [...answer.rows, ...found].slice(0, most) };
  };
  // The kind of each value a list's sources name themselves (note.status), from the source that keeps them.
  wrapped.sourceFields = async (list, ids) => {
    const out = [];
    for (const source of sourcesOf(list)) if (typeof sources[source.source].fields === 'function') out.push(...await sources[source.source].fields({ list, source, ids }));
    return out;
  };
  // A write naming rows a source keeps goes to that source when it writes its own rows (`write`: a folder of documents
  // keeps each changed property in the document), all of them to one source; any other such write is refused.
  const sourceWrite = (id, input = {}) => {
    const list = lists.find(id);
    const named = list ? sourcesOf(list) : [];
    const ids = [...(input.rows ?? []).map(row => row?.id), ...(input.remove ?? [])].filter(rowId => typeof rowId === 'string');
    const touched = named.filter(source => ids.some(rowId => rowId.startsWith(`${source.source}~`)));
    if (!touched.length) return null;
    const [source] = touched;
    const own = ids.filter(rowId => !rowId.startsWith(`${source.source}~`));
    if (touched.length > 1 || own.length || typeof sources[source.source].write !== 'function') throw say('bad_row', { index: 'a row another owner keeps' });
    const strip = rowId => rowId.slice(source.source.length + 1);
    return () => sources[source.source].write({ list, source, rows: (input.rows ?? []).map(row => ({ ...row, id: strip(row.id) })), remove: (input.remove ?? []).map(strip) });
  };
  wrapped.putRows = (id, input = {}, options) => {
    const write = sourceWrite(id, input);
    return write ? write() : lists.putRows(id, input, options);
  };
  // The owner below's one synchronous local write (src/placed-lists.mjs localWrite); a write a source keeps is not local.
  wrapped.localWrite = (method, ...args) => {
    if (method === 'putRows' && sourceWrite(args[0], args[1])) return null;
    return typeof lists.localWrite === 'function' ? lists.localWrite(method, ...args) : null;
  };
  return wrapped;
}

/** Several owners' row sources as one, for withRowSources: every name each gives, and the first DATA declaration of a list. */
export const joinRowSources = (...parts) => ({
  sources: Object.assign({}, ...parts.map(part => part.sources ?? {})),
  declared: id => parts.map(part => part.declared?.(id) ?? null).find(rows => rows !== null) ?? null,
});

export const isListsPath = path => path === '/lists' || path.startsWith('/lists/');

// One list read through one of its saved views: the rows its rules keep, by the formula engine's row filter
// (filterRows({ tree, fields, rows }) → { matches }), each field compared as its kind's rule kind says (ruleKindOf).
// `parameters` are the values its rules ask for when read (src/list-view-parameters.mjs).
export async function readThroughView(lists, id, viewId, { filterRows, ruleKindOf, readRecord, evaluateBinding, now }, row_ids, pageOptions = {}, parameters = {}) {
  const answer = await lists.read(id, { ...(row_ids === undefined ? {} : { row_ids }), ...pageOptions });
  const saved = (answer.list.views ?? []).find(row => row.id === viewId);
  if (!saved) throw say('no_view', { list_id: answer.list.id, view_id: viewId, views: (answer.list.views ?? []).map(row => row.id).join(', ') || 'none' });
  const view = bindParameters(saved, parameters);
  // A path through links the view names is read from the lists that own the linked rows, for the rows being shown.
  // A value a row source names itself (note.status) has the kind that source says (withRowSources sourceFields).
  const namespaces = sourceNamespacesOf(answer.list.row_sources);
  const viewIds = pathIdsOf(view);
  const sourced = viewIds.filter(path => isSourceId(path, namespaces));
  const paths = viewIds.filter(path => !sourced.includes(path)).map(path => planPath(answer.list, path, slug => lists.find(slug), viewId));
  const sourceFields = sourced.length ? (await lists.sourceFields?.(answer.list, sourced)) ?? [] : [];
  // The shared form of a field (website~key) the view names is worked out for the rows being shown (src/list-identity.mjs).
  const named = JSON.stringify(view);
  const keyFields = keyFieldsOf(answer.list.fields).filter(field => named.includes(JSON.stringify(field.id)));
  const fields = [...answer.list.fields.map(field => historyViewed(relationshipViewed(asViewed(field)), answer.list.fields)), ...paths.map(plan => ({ id: plan.id, label: plan.label, kind: plan.kind })), ...sourceFields, ...keyFields.map(({ of: _of, ...field }) => field)];
  const rows = withKeyValues(await withPathValues(lists, paths, await withRollups(lists, answer.list, answer.rows, { evaluateBinding })), keyFields);
  const projection = await projectSavedView({ view, fields, rows, filterRows, ruleKindOf, readRecord, evaluateBinding, now: now?.() ?? Date.now() });
  return {
    ...answer,
    ...(answer.page ? { page: { ...answer.page, returned: projection.rows.length } } : {}),
    view: projection.view, view_fields: projection.fields, groups: projection.groups, rows: projection.rows,
    total: answer.page ? null : projection.total,
  };
}

// One list read with its rollup fields worked out (src/list-rollups.mjs) by the formula engine, when there is one.
export async function readWithRollups(lists, id, options, evaluateBinding) {
  const answer = await lists.read(id, options);
  return { ...answer, rows: await withRollups(lists, answer.list, answer.rows, { evaluateBinding }) };
}
// The views of a list as list_list_views answers them: each with the parameters its rules ask for when read.
export const viewsWithParameters = views => views.map(view => {
  const asked = parametersOf(view);
  return asked.length ? { ...view, parameters: asked } : view;
});

// A list read with what it depends on (invariant 23): the version is taken before the read, so what was read is at or
// after it and a change made while the read awaited is never taken for one already seen.
async function withDepends(lists, id, viewId, read) {
  const version = typeof lists.version === 'function' ? lists.version() : null;
  const answer = await read();
  if (typeof lists.dependsOf !== 'function') return answer;
  const view = viewId === null ? null : (answer.list?.views ?? []).find(row => row.id === viewId) ?? null;
  return { ...answer, depends: lists.dependsOf(id, { view, row_ids: (answer.rows ?? []).map(row => row.id), version }) };
}

const pageOptionsFrom = url => {
  const cursor = url.searchParams.get('cursor');
  const order = url.searchParams.get('order');
  if (order !== null && !['true', 'false'].includes(order)) throw say('bad_row', { index: 'order' });
  const requested = url.searchParams.has('limit') ? readPageLimit(url.searchParams.get('limit')) : null; // reads-ok: the shared readPageLimit rejects invalid integers and caps to limits.read_page_rows.
  return requested === null && cursor === null && order !== 'true' ? {} : {
    ...(order !== null ? { order: order === 'true' } : {}),
    limit: requested === null ? limits.read_page_rows : Number(requested),
    ...(cursor !== null ? { cursor } : {}),
  };
};

// The person's /lists routes; the actor is the app that asked (the workspace page, or an AI's tool call). `views`
// ({ filterRows, ruleKindOf }) lets a read go through one of a list's saved views.
export async function handleListsRequest(lists, request, views = null, { files = null } = {}) {
  // A folder of documents and a list's plain files live in the person's Namespace (`files`: src/document-properties.mjs namespaceFiles).
  const namespace = () => { if (!files) throw Object.assign(new Error('Documents and plain files are unavailable here.'), { status: 501 }); return files; };
  const url = new URL(request.url);
  const path = url.pathname;
  const via = viaOf({ recorder: { app: request.headers.get('x-trillion-app'), app_basis: 'client_declared' } });
  const actor = { by: request.headers.get('x-trillion-app') || 'lists', ...(via ? { via } : {}) };
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (request.method === 'GET' && parts.length === 1) return Response.json(await lists.all());
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'views') {
      const list = await lists.find(parts[1]);
      if (!list) await lists.read(parts[1]); // retain the existing missing-list error
      return Response.json({ list_id: parts[1], views: viewsWithParameters(list.views ?? []) });
    }
    // reads-ok: removedRows caps the limit it is given at limits.trash_listed (src/lists.json), so the request cannot widen it.
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'removed') return Response.json(await lists.removedRows(parts[1], { ...(url.searchParams.has('limit') ? { limit: readPageLimit(url.searchParams.get('limit')) } : {}), ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) }));
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'filters') return Response.json(await lists.filters(parts[1]));
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'field-at') return Response.json(await lists.fieldAt(parts[1], { field_id: url.searchParams.get('field_id'), at: url.searchParams.get('at'), row_ids: JSON.parse(url.searchParams.get('row_ids') ?? 'null'), ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}), ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) }));
    // reads-ok: readSnapshot caps count at limits.snapshot_page_rows (src/lists.json), so the request cannot widen it.
    if (request.method === 'GET' && parts.length === 4 && parts[2] === 'snapshots') return Response.json(await readSnapshot(lists, parts[1], { snapshot_id: parts[3], from: Number(url.searchParams.get('from') ?? 0), count: Number(url.searchParams.get('count') ?? limits.snapshot_page_rows) }));
    if (request.method === 'GET' && parts.length === 2 && parts[1] === 'resolve') return Response.json(await resolveRows(lists, { refs: JSON.parse(url.searchParams.get('refs') ?? 'null') }));
    if (request.method === 'GET' && parts.length === 2 && parts[1] === 'file-names') return Response.json(await fileReferences(lists, { name: url.searchParams.get('name') }));
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'document-types') return Response.json(await readDocumentTypes(namespace(), documentsFolderOf(await lists.find(parts[1]), parts[1])));
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'backlinks') return Response.json(await backlinks(lists, parts[1], url.searchParams.get('row_id')));
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'changes') {
      return Response.json(lists.changes(parts[1], url.searchParams.get('since') ?? undefined));
    }
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'field-history') return Response.json(await lists.fieldHistory(parts[1], { row_id: url.searchParams.get('row_id'), field_id: url.searchParams.get('field_id') }));
    // reads-ok: rowsNeedingReview reads at most review.scan_rows rows a view and lists at most review.rows_listed (src/lists.json).
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'needs-review') return Response.json(await rowsNeedingReview(lists, parts[1], { ...(url.searchParams.has('owner') ? { owner: url.searchParams.get('owner') } : {}) },
      { readView: views ? options => readThroughView(lists, options.list_id, options.view_id, views, undefined, { limit: options.limit, ...(options.cursor ? { cursor: options.cursor } : {}) }) : undefined }));
    // reads-ok: coldRows reads at most use_heat.scan_rows rows a call and answers a cursor (src/lists.json).
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'cold') return Response.json(await coldRows(lists, parts[1], { ...(url.searchParams.has('owner') ? { owner: url.searchParams.get('owner') } : {}), ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) }));
    // reads-ok: proposals caps the limit it is given at proposals.listed_most (src/lists.json).
    if (request.method === 'GET' && parts.length === 3 && parts[2] === 'proposals') return Response.json(await lists.proposals(parts[1], { ...(url.searchParams.has('status') ? { status: url.searchParams.get('status') } : {}), ...(url.searchParams.has('limit') ? { limit: readPageLimit(url.searchParams.get('limit')) } : {}), ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) }));
    if (request.method === 'GET' && parts.length === 4 && parts[2] === 'proposals') return Response.json(await lists.proposal(parts[1], { proposal_id: parts[3] }));
    if (request.method === 'GET' && parts.length === 4 && parts[2] === 'views' && views) {
      const rowIds = url.searchParams.get('row_ids');
      return Response.json(await withDepends(lists, parts[1], parts[3], () => readThroughView(lists, parts[1], parts[3], views,
        rowIds === null ? undefined : JSON.parse(rowIds), pageOptionsFrom(url), JSON.parse(url.searchParams.get('parameters') ?? '{}'))));
    }
    if (request.method === 'GET' && parts.length === 2 && url.searchParams.get('view') && views) {
      const rowIds = url.searchParams.get('row_ids');
      return Response.json(await withDepends(lists, parts[1], url.searchParams.get('view'), () => readThroughView(lists, parts[1], url.searchParams.get('view'), views,
        rowIds === null ? undefined : JSON.parse(rowIds), pageOptionsFrom(url), JSON.parse(url.searchParams.get('parameters') ?? '{}'))));
    }
    // A screen opening a list without naming a view (`opening=1`) reads it through the view the list opens on, when it
    // names one that is still saved, and is told which (`opened_view`); any other read is unchanged.
    if (request.method === 'GET' && parts.length === 2 && url.searchParams.get('opening') === '1' && views && parts[1] !== 'search') {
      const opens = (await lists.read(parts[1], { row_ids: [] })).list;
      if (opens.opens_on && (opens.views ?? []).some(view => view.id === opens.opens_on)) {
        const rowIds = url.searchParams.get('row_ids');
        return Response.json({ ...await withDepends(lists, parts[1], opens.opens_on, () => readThroughView(lists, parts[1], opens.opens_on, views,
          rowIds === null ? undefined : JSON.parse(rowIds), pageOptionsFrom(url))), opened_view: opens.opens_on });
      }
    }
    if (request.method === 'GET' && parts.length === 2 && parts[1] === 'search') {
      const names = key => (url.searchParams.get(key) ?? '').split(',').map(item => item.trim()).filter(Boolean);
      // reads-ok: search caps the limit it is given at limits.search_most (src/lists.json), so the request cannot widen it.
      return Response.json(await lists.search({ q: url.searchParams.get('q') ?? '', lists: names('lists'), row_types: names('row_types'), holds: url.searchParams.get('holds') ?? undefined, limit: url.searchParams.get('limit') }));
    }
    if (request.method === 'GET' && parts.length === 2) {
      const rowIds = url.searchParams.get('row_ids');
      return Response.json(await withDepends(lists, parts[1], null, () => readWithRollups(lists, parts[1], { ...(rowIds === null ? {} : { row_ids: JSON.parse(rowIds) }), ...pageOptionsFrom(url) }, views?.evaluateBinding)));
    }
    if (request.method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 });
    const raw = await request.text();
    if (raw.length > 1_000_000) throw new ListsError('Request too large');
    const input = JSON.parse(raw || '{}');
    if (parts.length === 1) return Response.json(lists.save(input, { actor }));
    if (parts.length === 2 && parts[1] === 'file-names') return Response.json(await rewriteFileNames(lists, input, { actor }));
    if (parts.length === 2 && parts[1] === 'import-files') return Response.json(await importListFiles(lists, { folder: input.folder, list_id: input.list_id, match_on: input.match_on, after: input.after }, { files: namespace(), actor }));
    if (parts.length === 3 && parts[2] === 'export-files') return Response.json(await exportListFiles(lists, parts[1], { folder: input.folder, cursor: input.cursor }, { files: namespace() }));
    if (parts.length === 3 && parts[2] === 'document-types') return Response.json(await saveDocumentTypes(namespace(), documentsFolderOf(await lists.find(parts[1]), parts[1]), input));
    if (parts.length === 4 && parts[2] === 'rows' && parts[3] === 'restore') return Response.json(await lists.restoreRows(parts[1], input, { actor }));
    if (parts.length === 3 && parts[2] === 'snapshots') return Response.json(await takeSnapshot(lists, parts[1], input, { actor, readView: views ? options => readThroughView(lists, options.list_id, options.view_id, views, undefined, { limit: options.limit, ...(options.cursor ? { cursor: options.cursor } : {}) }) : undefined }));
    if (parts.length === 5 && parts[2] === 'views' && parts[4] === 'move') return Response.json(lists.moveView(parts[1], { ...input, view_id: parts[3] }, { actor }));
    if (parts.length === 4 && parts[2] === 'settlement') return handleSettlementRequest(lists, parts[1], parts[3], input);
    if (parts.length === 4 && parts[2] === 'rows' && parts[3] === 'copy') {
      try { return Response.json(await transferRows(lists, parts[1], input.to_list_id, input, { actor })); }
      catch (error) { if (error instanceof ListTransferError) return Response.json({ error: error.message }, { status: 400 }); throw error; }
    }
    if (parts.length === 4 && parts[2] === 'rows' && parts[3] === 'move') return Response.json(lists.moveRow(parts[1], input, { actor }));
    if (parts.length === 4 && parts[2] === 'rows' && parts[3] === 'preview') return Response.json(await lists.previewRows(parts[1], input, { actor }));
    if (parts.length === 3 && parts[2] === 'aggregate') return Response.json(await aggregateRows(lists, parts[1], input, { evaluateBinding: views?.evaluateBinding, readSnapshot: snapshotPages(lists),
      readView: views ? options => readThroughView(lists, options.list_id, options.view_id, views, undefined, { limit: options.limit, ...(options.cursor ? { cursor: options.cursor } : {}) }) : undefined }));
    if (parts.length === 3 && parts[2] === 'merge') return Response.json(await mergeRows(lists, parts[1], input, { actor }));
    if (parts.length === 3 && parts[2] === 'review') return Response.json(await reviewRows(lists, parts[1], input, { actor }));
    if (parts.length === 4 && parts[2] === 'rows' && parts[3] === 'use') return Response.json(await lists.noteUse(parts[1], input, { actor }));
    if (parts.length === 3 && parts[2] === 'proposals') return Response.json(await lists.proposeChanges(parts[1], input, { actor }));
    if (parts.length === 5 && parts[2] === 'proposals' && parts[4] === 'decide') return Response.json(await lists.decideProposal(parts[1], { ...input, proposal_id: parts[3] }, { actor }));
    if (parts.length === 3 && parts[2] === 'duplicate') return Response.json(await duplicateRows(lists, parts[1], input, { actor }));
    if (parts.length === 3 && parts[2] === 'rows') {
      // Rows named by who they are (match_on) or by a selection (select) become plain row requests first.
      const plan = await planRowRequest(lists, parts[1], input, { readView: views ? options => readThroughView(lists, options.list_id, options.view_id, views, undefined, { limit: options.limit, ...(options.cursor ? { cursor: options.cursor } : {}) }) : undefined });
      const answers = [];
      for (const one of plan.requests) answers.push(await lists.putRows(parts[1], one, { actor }));
      return Response.json(await withDangling(lists, parts[1], joinAnswers(answers, plan)));
    }
    if (parts.length === 3 && parts[2] === 'ensure') return Response.json(lists.ensure({ ...input, id: parts[1] }, { actor }));
    if (parts.length === 3 && parts[2] === 'filters') return Response.json(await lists.saveFilter(parts[1], input, { actor }));
    if (parts.length === 4 && parts[2] === 'filters') return Response.json(input.remove === true ? await lists.removeFilter(parts[1], { filter_id: parts[3] }, { actor }) : await lists.saveFilter(parts[1], { ...input, id: parts[3] }, { actor }));
    if (parts.length === 3 && parts[2] === 'views') return Response.json(lists.saveView(parts[1], input, { actor }));
    if (parts.length === 4 && parts[2] === 'views') return Response.json(input.remove === true ? lists.removeView(parts[1], parts[3], { actor }) : lists.saveView(parts[1], { ...input, id: parts[3] }, { actor }));
    return Response.json({ error: 'Not found' }, { status: 404 });
  } catch (error) {
    const refusal = listRefusal(error);
    if (refusal) return Response.json(refusal.body, { status: refusal.status });
    const known = error instanceof SyntaxError;
    return Response.json({ error: error.message }, { status: known ? 400 : Number.isInteger(error?.status) ? error.status : 500 });
  }
}
