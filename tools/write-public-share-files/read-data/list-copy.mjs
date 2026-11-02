// tools/write-public-share-files/read-data/list-copy.mjs (moved from Trillion's src/list-copy.mjs)
//
// PURPOSE
//   What of a person's list leaves through a share link, decided at the moment it is read. A list keeps every row; the
//   copy others read keeps only the rows whose own "Shown when" rule holds right now (field kind `shown-when`:
//   a formula-engine rule tree over the row's values plus `now`, the clock in milliseconds, and `opened`, how many
//   times the link was opened), never the rules themselves, and names each picture, video or file a row holds
//   (a kind row marked `media`) so the link can serve those bytes and nothing else of the person's files.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind of field: what a field is comes from its kind row (`kinds`, by default
//      read-data/share-files.json field_kinds, moved from Trillion's src/lists.json; `value: "rule"`
//      is a rule, over the row itself unless its `rule_over` names something else, and only a rule over the row
//      decides what shows; `media: true` holds a file, `ruleKind` is how the formula engine compares its value).
//   2. A rule field never leaves: neither the field nor any row's rule is in the copy.
//   3. A row whose rule cannot be checked (unfinished, or naming a field the list does not have) is left out, never
//      shown by default.
//   4. A file leaves only when a row that is shown names it and the person still has it; its identity is the one the
//      link serves at /share/<code>/files/<identity>.
//   5. A saved view that says how it is drawn (`display`) leaves as { id, label, display, row_ids }: the ids of the rows
//      it keeps among the rows that already leave, in its order, never its rules, search or sort. A view whose rules
//      cannot be checked over the fields that leave, or that no `projectView` is given to read, is left out, never
//      shown unfiltered.
//
// `kinds` (the field kind rows) and `projectView` (the saved-view projection, ({ view, fields, rows, filterRows,
// ruleKindOf, now }) → { rows }) are handed in by the caller that owns them; the defaults are this tool's DATA and no
// view projection.
import data from './share-files.json' with { type: 'json' };

const kindTable = kinds => new Map((kinds ?? data.field_kinds).map(row => [row.id, row]));
const FACTS = [{ id: 'now', kind: 'date' }, { id: 'opened', kind: 'number' }];

// A value as the formula engine compares it: a date as milliseconds, everything else as kept.
const comparable = (ruleKind, value) => {
  if (ruleKind !== 'date' || typeof value !== 'string') return value ?? null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};
const names = (tree, id) => tree?.kind === 'rule' ? tree.field === id : (tree?.rules ?? []).some(rule => names(rule, id));

// The saved views of a list that say how they are drawn, each cut to the rows that leave (invariant 5). `fields` and `rows`
// are the copy's own; a view is read through the shared projection, so it keeps what the app's view of it would.
async function shownViews({ views, fields, rows, facts, filterRows, KINDS, projectView }) {
  const out = [];
  if (typeof projectView !== 'function') return out;
  for (const view of (views ?? []).filter(item => item?.display?.as && !item.unresolved_filters?.length)) {
    try {
      const kept = await projectView({ view, fields, rows, filterRows, ruleKindOf: kind => KINDS.get(kind)?.ruleKind ?? kind, now: facts.now });
      out.push({ id: view.id, label: view.label, display: view.display, row_ids: kept.rows.map(row => row.id) });
    } catch { /* unfinished rules, or a field that does not leave: this view does not leave */ }
  }
  return out;
}

/**
 * The ids of the rows one saved view keeps among `rows` (the rows that already leave), in the view's order, or null when
 * its rules cannot be checked over `fields` (a link to that view then shows nothing, never every row).
 */
export async function shownViewRows({ view, fields, rows, facts, filterRows, kinds, projectView }) {
  if (view?.unresolved_filters?.length || typeof projectView !== 'function') return null;
  const KINDS = kindTable(kinds);
  try {
    const kept = await projectView({ view, fields, rows, filterRows, ruleKindOf: kind => KINDS.get(kind)?.ruleKind ?? kind, now: facts.now });
    return kept.rows.map(row => row.id);
  } catch { return null; }
}

/**
 * fields: the list's fields ({ id, label, kind, choices? }); rows: [{ id, title, values }]. kinds, projectView: above.
 * facts: { now (ms), opened (count) }. views: the list's saved views (optional). filterRows: the formula engine's row filter ({ tree, fields, rows } → { matches,
 * incomplete }). fileOf(value): the person's approved file copy for an identity or a name, or null; may be asynchronous.
 * Returns { fields, rows, files, shown_views, names_opened, names_clock }: the fields and rows that leave, the saved views
 * drawn another way with the row ids they keep, each file they name ({ identity, media_type, name }), whether any rule
 * reads `opened` (so the link counts its opens) and whether any reads `now`.
 */
export async function listCopy({ fields, rows, facts, filterRows, fileOf, views, share_when = null, kinds, projectView }) {
  const KINDS = kindTable(kinds);
  const kindOf = field => KINDS.get(field.kind) ?? {};
  // Only a rule over the row itself decides what shows; a rule over something else (a device's facts) never leaves.
  const ruled = fields.filter(field => kindOf(field).value === 'rule' && (kindOf(field).rule_over ?? 'row') === 'row');
  const media = new Set(fields.filter(field => kindOf(field).media).map(field => field.id));
  const shown = fields.filter(field => !['rule', 'done-rule'].includes(kindOf(field).value));
  const ruleFields = [...FACTS, ...shown.map(field => ({ id: field.id, kind: kindOf(field).ruleKind ?? 'text' }))];
  const files = new Map();
  const kept = [];
  for (const row of rows) {
    let holds = true;
    for (const tree of [share_when, ...ruled.map(field => row.values?.[field.id])]) {
      if (!tree) continue;
      const factRow = { now: facts.now, opened: facts.opened ?? 0,
        ...Object.fromEntries(shown.map(item => [item.id, comparable(kindOf(item).ruleKind, row.values?.[item.id])])) };
      const { matches, incomplete } = await filterRows({ tree, fields: ruleFields, rows: [factRow] });
      if ((incomplete ?? []).length || !matches.includes(0)) { holds = false; break; }
    }
    if (!holds) continue;
    const values = {};
    for (const field of shown) {
      const value = row.values?.[field.id];
      if (value === undefined) continue;
      if (!media.has(field.id)) { values[field.id] = value; continue; }
      // A files field holds one file or several (field kind file); each leaves as its identity.
      const identities = [];
      for (const item of [value].flat()) {
        const file = typeof item === 'string' ? await fileOf(item) : null;
        if (!file?.identity) continue;
        files.set(file.identity, { identity: file.identity, media_type: file.media_type ?? null,
          name: (item.startsWith('/') ? item : file.name ?? file.names?.[0]) ?? null,
          ...(typeof file.preview_identity === 'string' && file.preview_media_type?.startsWith('video/')
            ? { preview_identity: file.preview_identity, preview_media_type: file.preview_media_type } : {}),
          ...(typeof file.poster_identity === 'string' && file.poster_media_type?.startsWith('image/')
            ? { poster_identity: file.poster_identity, poster_media_type: file.poster_media_type } : {}) });
        identities.push(file.identity);
      }
      // One file stays one identity; several stay a list, so a reader sees the shape the person kept.
      if (identities.length) values[field.id] = Array.isArray(value) ? identities : identities[0];
    }
    kept.push({ id: row.id, title: row.title, values });
  }
  const copiedFields = shown.map(field => ({ ...field, ...(media.has(field.id) ? { media: true } : {}) }));
  return {
    fields: copiedFields,
    rows: kept,
    files: [...files.values()],
    shown_views: await shownViews({ views, fields: copiedFields, rows: kept, facts, filterRows, KINDS, projectView }),
    names_opened: names(share_when, 'opened') || rows.some(row => ruled.some(field => names(row.values?.[field.id], 'opened'))),
    // Whether any rule reads the clock, so what shows can change with no change to a record.
    names_clock: names(share_when, 'now') || rows.some(row => ruled.some(field => names(row.values?.[field.id], 'now'))),
  };
}
