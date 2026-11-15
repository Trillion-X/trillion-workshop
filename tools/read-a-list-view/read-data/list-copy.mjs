// tools/read-a-list-view/read-data/list-copy.mjs
//
// Purpose: a list that is the original and a folder that is its copy, kept the same in both directions. A row source
// declared `original: "list"` is not only read into the list: what any AI writes into the list (through the person's
// door, from a web chat, a phone or a service) is written into the folder for apps that read only files, and what an
// app writes into the folder is written into the list. A refresh of such a source is this sync.
//
// How each document is settled, with no state kept anywhere but the rows themselves: a row made from a file keeps the
// identity of that file (the source's copy `identity` field, file.identity for documents). So for one document:
//   - the folder's text equals the list's text: nothing to do (a changed file fact or frontmatter value still writes);
//   - the file is still the one the row was made from: the list changed, so the folder gets the list's text;
//   - the list's text is still the file the row was made from: the file changed, so the list gets the file's rows;
//   - both changed: the side changed last wins (the file's modified time against the row's newest version time,
//     records:history), and the other side's text is written as a version of the row first, so neither is lost;
//   - only a row, made from a file whose text it still holds: the file was removed, so the rows are removed;
//   - only a row the list changed or wrote (no file yet): the folder gets it;
//   - only a file: a new file, so the list gets it; unless the row's history ends in a removal of that same file's
//     text, which means the list removed it, so the file is removed;
//   - a row the list's own rows hold (written by any AI under any id) when the source adopts them: it becomes a file
//     named by `copy_name` from its values, then the file's rows replace it, so every AI then reads one row.
// A copy's own fields are those under `properties_prefix` (a document's frontmatter), or, when the copy names
// `list_only` (rows of a file that holds many, json-items), every field but those and the meta prefixes: the list's
// own fields (a check's switch) are kept on the row and never reach the file.
//
// Non-Negotiable Invariants:
//   1. Every row effect carries the native owner's exact expected type/value (or expected absence). Unknown outcomes
//      retain the original tuple. A file publication's actual concurrency boundary belongs to its change owner;
//      require_atomic is forwarded without downgrade and unsupported publication is refused, not called CAS.
//   2. Nothing is removed from the list for a file the source has not answered: rows of documents not seen are judged
//      only after the source answered its last page, as in a one-way refresh.
//   3. A run with `paths` settles only those documents (the write a file-writing app just made); without, every one.
//   4. No list, field, folder or tool is named here: the source declaration and list-view.json `row_sources` name them.
//   5. dry_run plans the same and writes nothing, so a first run on a person's real list can be read before it acts.
//   6. A restore never becomes a removal. When the account was restored from an older copy of its state, it holds a
//      restore generation stamped with its time (list-view.json `restore` names the record and its time field). A
//      removal judged from a row version older than that time is not trusted: the folder may hold newer copies than
//      the restored rows. A file whose row history ends in such an older removal is carried back up to the list
//      (carried_after_restore), and a row whose file is gone keeps its rows (kept_after_restore). Removals written
//      after the restore are judged as always.
//
//   syncRowSource({ list, type, source, sources, paths?, dry_run?, source_answer_bytes?, key, signal? }, door)
//     → { source, original: "list", documents, unchanged, pushed, pulled, adopted, removed_rows, removed_files,
//         carried_after_restore, kept_after_restore, conflicts: [{ document, kept, because }],
//         refused: [{ document, because }], planned? }
//     door: { list, run, write, read?(type, id), history?(id) → { versions: [{ value, deleted, at }] } }
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { projectedValues, sourcePages, valueIdentity, writeAll, SOURCE_MARK } from './list-view.mjs';
import data from './list-view.json' with { type: 'json' };

const say = (code, words) => Object.assign(new Error(words), { code });
const at = (value, path) => path.split('.').reduce((held, part) => (held == null ? held : held[part]), value);
const utf8 = new TextEncoder();
const textIdentity = text => makeHashCodeHexFromBytes(utf8.encode(text));
// A value from a template placeholder made one safe name segment: lower case, letters, digits and dashes.
const segment = value => String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const MOST_NAME_TRIES = 9;
// A refusal by the folder's change tool (a local tool's own error, or a door run that failed) is that document's
// refusal, reported; anything else (the door unreachable) ends the run, and the next run settles the document again.
const folderRefused = error => ['tool_failed', 'document_changed', 'bad_input', 'not_a_document', 'not_written'].includes(error.code);
const conflicted = error => error.code === 'document_changed' || /changed after it was read/.test(error.message);

/** The copy field names: the source tool's defaults (list-view.json `copy`) under the source's own content names. */
function copyNames(source) {
  const named = { ...source.served.copy, ...(source.content && typeof source.content === 'object' ? source.content : {}) };
  for (const key of ['field', 'parent_field', 'index_field', 'count_field', 'identity_field', 'changed_field']) {
    if (typeof named[key] !== 'string' || !named[key]) throw say('bad_list', `The copy of ${source.id} names no ${key}.`);
  }
  if (!Array.isArray(named.owned_prefixes) || !named.owned_prefixes.length) throw say('bad_list', `The copy of ${source.id} names no owned_prefixes.`);
  if (named.list_only !== undefined && (!Array.isArray(named.list_only) || named.list_only.some(field => typeof field !== 'string' || !field))) {
    throw say('bad_list', `The copy of ${source.id} names list_only as something other than field names.`);
  }
  // A copy whose rows hold its fields bare (list_only named: a row of many in one file) owns every field but the
  // list's own ones and its meta prefixes; any other copy owns the fields under its prefixes.
  const contentFields = new Set(['field', 'parent_field', 'index_field', 'count_field', 'identity_field', 'changed_field',
    'complete_field', 'source_field', 'section_field', 'offset_field'].map(key => named[key]).filter(value => typeof value === 'string'));
  const meta = field => contentFields.has(field) || named.owned_prefixes.some(prefix => field.startsWith(prefix));
  return { ...named,
    own: Array.isArray(named.list_only) ? field => !named.list_only.includes(field) && !meta(field) : field => field.startsWith(named.properties_prefix),
    kept: Array.isArray(named.list_only) ? field => !meta(field) && named.list_only.includes(field) : field => !meta(field) };
}

// One document from its rows (the whole document, or its numbered parts): its text when every part is there.
function documentOf(rows, names) {
  const sorted = [...rows].sort((a, b) => (Number(a.value[names.index_field] ?? 1) - Number(b.value[names.index_field] ?? 1)));
  const first = sorted[0].value;
  const parts = Number(first[names.count_field] ?? 1);
  const whole = Number.isSafeInteger(parts) && parts > 0 && sorted.length === parts && sorted.every((row, index) => Number(row.value[names.index_field] ?? 1) === index + 1 &&
    Number(row.value[names.count_field] ?? 1) === parts && row.value[names.identity_field] === first[names.identity_field] &&
    typeof row.value[names.field] === 'string');
  const text = whole ? sorted.map(row => row.value[names.field]).join('') : null;
  return { rows: sorted, first, text, textIdentity: text === null ? null : textIdentity(text),
    baseline: first[names.identity_field] ?? null, changed: first[names.changed_field] ?? null };
}

const properties = (values, names) => Object.fromEntries(Object.entries(values).filter(([key]) => names.own(key)));
const sameValues = (a, b) => valueIdentity(a) === valueIdentity(b);

export async function syncRowSource(input, door) {
  const { list, type, record_prefix: recordPrefix = `${type}:`, source, sources, paths, dry_run: dryRun = false, key, signal } = input;
  const names = copyNames(source);
  const change = source.served.change;
  const prefixOf = id => `${recordPrefix}${id}${SOURCE_MARK}`;
  const recordId = name => `${prefixOf(source.id)}${encodeURIComponent(name)}`;
  const nameOf = record => {
    const own = decodeURIComponent(record.id.slice(prefixOf(source.id).length));
    return typeof record.value?.[names.parent_field] === 'string' ? record.value[names.parent_field] : own;
  };
  const report = { source: source.id, original: 'list', documents: 0, unchanged: 0, pushed: 0, pulled: 0, adopted: 0,
    removed_rows: 0, removed_files: 0, carried_after_restore: 0, kept_after_restore: 0, conflicts: [], refused: [],
    ...(dryRun ? { planned: [] } : {}) };
  // When the account was last restored from an older copy of its state (list-view.json `restore`): the time its
  // restore generation was stamped, or null when it never was.
  const restore = data.restore;
  const stamped = typeof door.read === 'function' ? await door.read(restore.record_type, restore.record) : null;
  const restoredAt = Number.isFinite(Date.parse(at(stamped, restore.restored_at))) ? Date.parse(at(stamped, restore.restored_at)) : null;
  let writeIndex = 0;
  const snapshots = new Map();
  const plan = (action, document) => { if (dryRun && report.planned.length < data.limits.planned_shown) report.planned.push({ action, document }); };
  const write = async records => {
    if (!records.length || dryRun) return [];
    // These are fresh effects from this admitted read. Conditional refusal never refreshes the body or key;
    // transport/unknown errors still end the run with the original request tuple unchanged.
    const guarded = records.map(record => ({ ...record, expected: snapshots.has(record.id)
      ? { type, value: structuredClone(snapshots.get(record.id)) } : null }));
    const refused = await writeAll(door, guarded, `${key}:${writeIndex++}`, signal);
    for (const record of records) if (!refused.includes(record.id)) {
      if (record.value === null) snapshots.delete(record.id);
      else snapshots.set(record.id, structuredClone(record.value));
    }
    for (const id of refused) report.refused.push({ document: id, because: 'the door refused its values' });
    return refused;
  };
  const changeInput = Object.fromEntries(Object.entries(change.input).map(([field, template]) => {
    const exact = /^\{(\w+)\}$/.exec(template);
    return [field, exact ? source[exact[1]] : template];
  }).filter(([, value]) => value !== undefined && value !== ''));
  const changeFiles = request => door.run(change.tool, { ...changeInput, ...request });

  // ---- the list's side ----------------------------------------------------------------------------------------------
  const held = new Map(), own = [], documentNames = new Map();
  const otherPrefixes = sources.filter(one => one.id !== source.id).map(one => prefixOf(one.id));
  const take = record => {
    if (record.id.startsWith(prefixOf(source.id))) {
      const name = nameOf(record);
      if (!paths || paths.includes(name)) {
        if (documentNames.has(record.id) && documentNames.get(record.id) !== name) {
          throw say('records_unanswered', `Listing ${record.id} answered different document owners.`);
        }
        documentNames.set(record.id, name);
        snapshots.set(record.id, structuredClone(record.value));
        (held.get(name) ?? held.set(name, []).get(name)).push(record);
      }
    } else if (!paths && source.adopt_own_rows && !otherPrefixes.some(prefix => record.id.startsWith(prefix)) && record.value) {
      snapshots.set(record.id, structuredClone(record.value));
      own.push(record);
    }
  };
  const listing = paths ? paths.map(name => recordId(name)) : [recordPrefix];
  for (const prefix of listing) {
    const cursors = new Set();
    for (let after = null; ;) {
      signal?.throwIfAborted();
      const page = await door.list({ type, prefix, limit: data.limits.door_page_rows, ...(after ? { after } : {}) });
      if (!Array.isArray(page?.records)) throw say('records_unanswered', `Listing ${prefix} answered no records.`);
      for (const record of page.records) take(record);
      if (page.next === undefined) throw say('records_unanswered', `Listing ${prefix} answered no continuation or terminal null.`);
      if (page.next === null || !page.records.length) break;
      if (cursors.has(page.next)) throw say('source_cursor_stalled', `Listing ${prefix} did not advance its cursor.`);
      cursors.add(page.next);
      after = page.next;
    }
  }

  // ---- reading the folder -------------------------------------------------------------------------------------------
  const scoped = paths ? { ...source, paths } : source;
  const fileRowsOf = async name => {
    const rows = [];
    for await (const page of sourcePages(door, { ...source, paths: [name] }, input.source_answer_bytes, signal)) rows.push(...page);
    return rows;
  };
  const asRecords = rows => rows.map(row => ({ id: recordId(row.id), value: projectedValues(source, row) }));
  const sourceNameOf = row => {
    const parent = row.values[names.parent_field];
    // A multipart row without its parent cannot establish which held document is present. Refuse the source
    // before effects rather than mistaking that original for a file the source did not answer.
    if ((parent !== undefined && (typeof parent !== 'string' || !parent)) || (parent === undefined &&
      (Object.hasOwn(row.values, names.count_field) || Object.hasOwn(row.values, names.index_field) ||
        typeof row.values[names.field] !== 'string' || typeof row.values[names.identity_field] !== 'string' || !row.values[names.identity_field]))) {
      throw say('source_unanswered', `The row source ${source.id} answered a document part without an identifiable parent.`);
    }
    return parent ?? row.id;
  };
  const sourceDocument = (rows, name) => {
    if (!rows.length || new Set(rows.map(row => row.id)).size !== rows.length || rows.some(row => sourceNameOf(row) !== name ||
      (documentNames.has(recordId(row.id)) && documentNames.get(recordId(row.id)) !== name))) return null;
    const file = documentOf(rows.map(row => ({ value: row.values })), names);
    return file.text !== null && typeof file.baseline === 'string' && file.baseline ? file : null;
  };
  const refuseSource = (name, rows) => report.refused.push({ document: name,
    because: `the folder answered ${rows.length} parts without one complete document, source identity and record ownership` });
  // Bind a record id to its admitted document for the whole run. Accepted value snapshots may advance, but they
  // must never turn a part of another original into this document's own publication or later absence deletion.
  const claimSource = (rows, name) => { for (const row of rows) documentNames.set(recordId(row.id), name); };

  // The file's rows written over the list's rows of that document: values outside the copy's own prefixes that the
  // list's rows hold (a field an AI added in the list) stay on the row of the same id. Rows the file no longer has go.
  const push = async (fileRows, listRows = [], name) => {
    // Also applies to fresh reads after a pull or adoption: a missing or invalid readback never removes originals.
    if (!sourceDocument(fileRows, name)) { refuseSource(name, fileRows); return 0; }
    claimSource(fileRows, name);
    const before = new Map(listRows.map(record => [record.id, record.value]));
    const records = asRecords(fileRows).map(record => {
      const kept = Object.fromEntries(Object.entries(before.get(record.id) ?? {})
        .filter(([field]) => names.kept(field)));
      return { id: record.id, type, value: { ...record.value, ...kept } };
    });
    const writes = records.filter(record => !before.has(record.id) || !sameValues(before.get(record.id), record.value));
    const gone = [...before.keys()].filter(id => !records.some(record => record.id === id)).map(id => ({ id, type, value: null }));
    const refused = await write([...writes, ...gone]);
    return refused.length ? 0 : writes.length + gone.length;
  };

  // The list's text written into the folder while the file is still `expected` (null: there is none), then its rows.
  const pull = async (name, request, listRows) => {
    if (dryRun) return true;
    try {
      await changeFiles({ rows: [{ id: name, ...request }] });
    } catch (error) {
      if (!folderRefused(error)) throw error;
      report.refused.push({ document: name, because: `the folder refused the write: ${error.message.slice(0, 200)}` });
      return false;
    }
    const beforeRefusals = report.refused.length;
    await push(await fileRowsOf(name), listRows, name);
    return report.refused.length === beforeRefusals;
  };

  const newestRowTime = async id => {
    if (typeof door.history !== 'function') return null;
    const versions = (await door.history(id))?.versions ?? [];
    return versions[0]?.at ?? null;
  };
  // A removal is decided only by a version written after the account's last restore: a version older than it may come
  // from the older state the account was restored from, while the folder kept the newer copies (invariant 6).
  const beforeRestore = when => restoredAt !== null && !(Date.parse(when) >= restoredAt);

  const settle = async (name, fileRows, listRows) => {
    report.documents += 1;
    const file = fileRows?.length ? sourceDocument(fileRows, name) : null;
    const row = listRows?.length ? documentOf(listRows, names) : null;
    if (fileRows?.length && !file) { refuseSource(name, fileRows); return; }
    if (row && row.text === null) {
      report.refused.push({ document: name, because: `the list holds ${listRows.length} of its ${row.first[names.count_field]} parts` });
      return;
    }
    if (file && row) {
      const fileIdentity = file.first[names.identity_field];
      if (file.textIdentity !== row.textIdentity) {
        if (row.baseline === fileIdentity) {
          plan('pull', name);
          if (await pull(name, { text: row.text, if_identity: fileIdentity }, listRows)) report.pulled += 1;
          return;
        }
        if (row.baseline === row.textIdentity) {
          plan('push', name);
          if (await push(fileRows, listRows, name)) report.pushed += 1;
          return;
        }
        // Both changed since the row was made from the file: the later change wins, the other stays a row version.
        const rowAt = await newestRowTime(row.rows[0].id);
        if (rowAt === null || !file.changed) {
          report.conflicts.push({ document: name, kept: 'both as they are', because: 'the list and the file both changed and their times are unknown' });
          return;
        }
        const listWins = Date.parse(rowAt) > Date.parse(file.changed);
        report.conflicts.push({ document: name, kept: listWins ? 'list' : 'file',
          because: `both changed; the ${listWins ? 'list' : 'file'} changed last (${listWins ? rowAt : file.changed}); the other text is the row's previous version` });
        plan(listWins ? 'conflict-pull' : 'conflict-push', name);
        if (dryRun) return;
        const beforeRefusals = report.refused.length;
        await push(fileRows, listRows, name);
        if (report.refused.length !== beforeRefusals) return;
        if (listWins) await pull(name, { text: row.text, if_identity: fileIdentity }, asRecords(fileRows)
          .map(record => ({ ...record, type, value: snapshots.get(record.id) ?? record.value })));
        return;
      }
      // Same text. A value only the list changed (a frontmatter property) goes to the file when the file is the one
      // the row was made from; any other difference is the file's facts, written to the list.
      const wanted = properties(row.first, names), there = properties(file.first, names);
      if (!sameValues(wanted, there) && row.baseline === fileIdentity) {
        const values = Object.fromEntries([...Object.keys(there)].filter(field => !(field in wanted)).map(field => [field, null]));
        Object.assign(values, wanted);
        plan('pull-values', name);
        if (await pull(name, { values, if_identity: fileIdentity }, listRows)) report.pulled += 1;
        return;
      }
      if (dryRun) { report.unchanged += 1; return; }
      const beforeRefusals = report.refused.length;
      if (await push(fileRows, listRows, name)) report.pushed += 1;
      else if (report.refused.length === beforeRefusals) report.unchanged += 1;
      return;
    }
    if (row) {
      if (row.baseline !== null && row.baseline === row.textIdentity) {
        if (restoredAt !== null && beforeRestore(await newestRowTime(row.rows[0].id))) {
          plan('keep-after-restore', name);
          report.kept_after_restore += 1;
          return;
        }
        plan('remove-rows', name);
        const refused = await write(listRows.map(record => ({ id: record.id, type, value: null })));
        if (!refused.length) report.removed_rows += 1;
        return;
      }
      plan('pull', name);
      if (await pull(name, { text: row.text, if_identity: null }, listRows)) report.pulled += 1;
      return;
    }
    // Only a file: the list removed it when the row's newest version is a removal of this same file's text.
    const versions = typeof door.history === 'function' ? (await door.history(recordId(name)))?.versions ?? [] : [];
    const removedFromList = versions[0]?.deleted && versions.slice(1).find(version => !version.deleted)?.value?.[names.identity_field] === file.first[names.identity_field];
    if (removedFromList && beforeRestore(versions[0].at)) {
      plan('carry-after-restore', name);
      const beforeRefusals = report.refused.length;
      await push(fileRows, [], name);
      if (report.refused.length === beforeRefusals) report.carried_after_restore += 1;
      return;
    }
    if (removedFromList) {
      plan('remove-file', name);
      if (dryRun) return;
      try {
        await changeFiles({ remove: [{ id: name, if_identity: file.first[names.identity_field] }] });
        report.removed_files += 1;
      } catch (error) {
        if (!folderRefused(error)) throw error;
        report.refused.push({ document: name, because: `the folder refused the removal: ${error.message.slice(0, 200)}` });
      }
      return;
    }
    plan('push', name);
    if (await push(fileRows, [], name)) report.pushed += 1;
  };

  // ---- both sides, document by document ------------------------------------------------------------------------------
  const pending = new Map(), sourceNames = new Map();
  for await (const page of sourcePages(door, scoped, input.source_answer_bytes, signal)) {
    for (const fileRow of page) {
      const name = sourceNameOf(fileRow);
      if (sourceNames.has(fileRow.id) && sourceNames.get(fileRow.id) !== name) {
        throw say('source_unanswered', `The row source ${source.id} answered one part id for different documents.`);
      }
      sourceNames.set(fileRow.id, name);
      const rows = pending.get(name) ?? pending.set(name, []).get(name);
      rows.push(fileRow);
    }
  }
  // Finish and validate the source frame before effects: a later part may duplicate or contradict an earlier
  // complete count. A refused frame cannot establish a complete absence inventory or permit adoption either.
  for (const [name, rows] of pending) if (!sourceDocument(rows, name)) refuseSource(name, rows);
  if (report.refused.length) return report;
  for (const [name, rows] of pending) claimSource(rows, name);
  for (const [name, rows] of pending) {
    await settle(name, rows, held.get(name));
    held.delete(name);
  }
  // Only documents not answered at all are absent (invariant 2).
  for (const [name, listRows] of held) await settle(name, null, listRows);

  // ---- rows any AI wrote into the list ---------------------------------------------------------------------------
  const isCopyOf = async (name, set, body) => {
    const rows = await fileRowsOf(name);
    if (!rows.length) return false;
    const file = sourceDocument(rows, name);
    return file !== null && sameValues(properties(file.first, names), set) && file.text.endsWith(body);
  };
  for (const record of own) {
    const values = record.value;
    let base;
    try {
      // {field} is that value; {field|word} is the word when the row has no such value.
      base = source.copy_name.replace(/\{([\w.]+)(?:\|([\w-]+))?\}/g, (_, field, otherwise) => {
        const value = values[field] === undefined || values[field] === null ? otherwise : values[field];
        if (value === undefined || !segment(value)) throw say('bad_row', `it has no ${field}`);
        return segment(value);
      });
    } catch (error) {
      report.refused.push({ document: record.id, because: `the list's row cannot be named a file: ${error.message}` });
      continue;
    }
    const folder = source.of.replace(/\/+$/, '');
    const body = typeof values[names.field] === 'string' ? values[names.field] : '';
    const set = properties(values, names);
    plan('adopt', record.id);
    if (dryRun) { report.adopted += 1; continue; }
    let named = null;
    for (let attempt = 1; attempt <= MOST_NAME_TRIES && !named; attempt += 1) {
      const name = `${folder}/${attempt === 1 ? base : base.replace(/(\.[^./]+)?$/, `-${attempt}$1`)}`;
      try {
        await changeFiles({ rows: [{ id: name, text: body, values: set, if_identity: null }] });
        named = name;
      } catch (error) {
        if (!folderRefused(error)) throw error;
        if (!conflicted(error)) {
          report.refused.push({ document: record.id, because: `the folder refused it: ${error.message.slice(0, 200)}` });
          break;
        }
        // Two syncs at once (a turn's end and a commit's) both adopt the same row: the name is taken by this row's own
        // copy, the file holding exactly its values and text, so it is that copy and not a second one.
        if (await isCopyOf(name, set, body)) named = name;
      }
    }
    if (!named) {
      if (!report.refused.some(one => one.document === record.id)) report.refused.push({ document: record.id, because: `${MOST_NAME_TRIES} names were taken` });
      continue;
    }
    // The AI's own row goes only once the file's rows are in the list: a file the source does not read (copy_name
    // outside its match) keeps the row where it is.
    const made = await fileRowsOf(named);
    if (!made.length) {
      report.refused.push({ document: record.id, because: `${named} was written, but the source does not read it (copy_name is outside its match)` });
      continue;
    }
    const beforeRefusals = report.refused.length;
    await push(made, [], named);
    if (report.refused.length !== beforeRefusals) continue;
    if (!(await write([{ id: record.id, type, value: null }])).length) report.adopted += 1;
  }
  return report;
}
