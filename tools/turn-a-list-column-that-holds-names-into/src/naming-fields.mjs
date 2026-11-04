// src/naming-fields.mjs
//
// PURPOSE
//   A field that names a thing is a link to it. A person's list field kept as words ("Acme", "Instagram reels") whose
//   words are the names of rows of another list, or a field the rules say names a kind of thing (a company), is moved
//   to a link field over that list: each value becomes the id of the row with that name, a row made, named by the value,
//   where none has it. So what a row is inside (participation, src/record-model.json, read_model's holders) is known for
//   every thing a person's rows name, never left as words two lists happen to share.
//
//   makeNamingFields({ lists, eeaf, rules }) → { candidates(), linkField(candidate), nextAt(), step(), markDue() }
//     candidates()  [{ list_id, field_id, links_to, values, matched, make? }]: the fields that name another list's rows
//     linkField(c)  moves one field: the target list made when missing (rules), rows made for names none has, the field
//                   kept as a link, every row's words replaced by row ids → { list_id, field_id, links_to, rows, made }
//     step()        at idle, while a change marked the lists: moves one field, or clears the mark when none is left
//
// NON-NEGOTIABLE INVARIANTS
//   1. What names a thing is DATA (src/lists.json `naming`): the field kinds looked at, how many distinct values and what
//      share of them must each be the name of exactly one row of ONE other list, and the fields that name a kind of
//      thing by their id (company) with the list that keeps it. Nothing here names a list, a field or a person.
//   2. Nothing a person reads by its words is moved: the title field, a field a saved view, a public page, a start or a
//      settle names, and any value longer than value_chars stay words.
//   3. Every move is the lists' own writes (save, putRows) by the actor `naming-fields`: the log keeps every earlier
//      value, so what a row said before the move is read back with the record's history.
//   4. Idle work is bounded and marked: a list's save, or rows put into a field this looks at, marks the lists (one
//      point read, one write only when not already marked); a step moves at most one field; nothing runs while unmarked,
//      and a look over every list starts at most once each every_minutes, however often rows are put.
//
import data from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };

const rules = data.naming;
const MARK = `${rules.mark_type}:lists`;
const norm = text => text.trim().replace(/\s+/g, ' ').toLowerCase();
const valuesOf = value => (Array.isArray(value) ? value : [value]).filter(item => typeof item === 'string' && item.trim());

/** Whether a list's field is one a person reads by its words (invariant 2). */
function readByWords(list, field) {
  if (field.id === list.title_field || field.starts !== undefined || field.settles || field.open_index) return true;
  const named = JSON.stringify([list.views ?? [], list.public_page ?? null]);
  return named.includes(JSON.stringify(field.id));
}

/** Marks the lists to be looked at again (invariant 4): a point read, and a write only when not already marked. */
export function markNamingDue(eeaf, actor = { by: 'naming-fields' }) {
  const mark = eeaf.read(MARK);
  if (mark?.due === true) return;
  eeaf.write([{ id: MARK, type: rules.mark_type, value: { ...(mark ?? {}), due: true } }], { actor });
}

/** Whether rows put into `list` write a value into a field this looks at. */
export const namesWritten = (list, rows) => rows.some(row => Object.keys(row?.values ?? {}).some(fieldId => {
  const field = list.fields?.find(item => item.id === fieldId);
  return field && rules.kinds.includes(field.kind) && !readByWords(list, field);
}));

export function makeNamingFields({ lists, eeaf, rules: given = rules }) {
  const actor = { by: 'naming-fields' };
  const all = async () => (await lists.all()).lists;
  const rowsOf = async id => (await lists.read(id)).rows;

  async function candidates() {
    const kept = await all();
    // Each name to the rows that hold it, per list: { name → Map(list id → Set(row id)) }.
    const names = new Map();
    const rowsByList = new Map();
    for (const list of kept) {
      const rows = await rowsOf(list.id);
      rowsByList.set(list.id, rows);
      for (const row of rows) for (const name of valuesOf(row.values?.[list.title_field])) {
        const key = norm(name);
        if (!names.has(key)) names.set(key, new Map());
        const holders = names.get(key);
        if (!holders.has(list.id)) holders.set(list.id, new Set());
        holders.get(list.id).add(row.id);
      }
    }
    const out = [];
    for (const list of kept) for (const field of list.fields ?? []) {
      if (!rules.kinds.includes(field.kind) || readByWords(list, field)) continue;
      const values = new Set();
      let long = false;
      for (const row of rowsByList.get(list.id)) for (const value of valuesOf(row.values?.[field.id])) {
        if (value.length > given.value_chars) long = true;
        values.add(norm(value));
      }
      if (!values.size) continue;
      // A field that says what it names is moved whatever its words are (a description is a row too).
      if (field.names?.list) {
        out.push({ list_id: list.id, field_id: field.id, links_to: field.names.list.id, values: values.size, matched: null, make: field.names.list });
        continue;
      }
      if (long) continue;
      const byRule = given.named_by_field.find(rule => rule.fields.includes(field.id.toLowerCase()));
      if (byRule) {
        if (byRule.list.id !== list.id) out.push({ list_id: list.id, field_id: field.id, links_to: byRule.list.id, values: values.size, matched: null, make: byRule.list });
        continue;
      }
      if (values.size < given.least_values) continue;
      const share = new Map();
      for (const value of values) for (const [other, rows] of names.get(value) ?? []) {
        if (other !== list.id && rows.size === 1) share.set(other, (share.get(other) ?? 0) + 1);
      }
      const [best] = [...share].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (best && best[1] / values.size >= given.match_share) out.push({ list_id: list.id, field_id: field.id, links_to: best[0], values: values.size, matched: best[1] });
    }
    return out;
  }

  async function linkField({ list_id, field_id, links_to, make }) {
    if (make && !await lists.find(links_to)) await lists.ensure(make, { actor });
    const target = await lists.find(links_to);
    const byName = new Map();
    // A name two rows share links to the first of them, in id order, never to a new third one.
    for (const row of [...await rowsOf(links_to)].sort((a, b) => a.id.localeCompare(b.id))) for (const name of valuesOf(row.values?.[target.title_field])) if (!byName.has(norm(name))) byName.set(norm(name), row.id);
    const source = await lists.find(list_id);
    const rows = (await rowsOf(list_id)).filter(row => valuesOf(row.values?.[field_id]).length);
    // Names no row has yet get a row in the target list, named by the value as it was first written.
    const missing = new Map();
    for (const row of rows) for (const value of valuesOf(row.values[field_id])) if (!byName.get(norm(value)) && !missing.has(norm(value))) missing.set(norm(value), value.trim());
    const made = [...missing.values()];
    // A made row's own link fields name the rows of their lists its words name ("Sister - Morgan Boyter" names the row
    // Morgan Boyter), never the one row whose words they were.
    const holdersOfName = new Map();
    for (const row of rows) for (const value of valuesOf(row.values[field_id])) holdersOfName.set(norm(value), [...(holdersOfName.get(norm(value)) ?? []), row.id]);
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namedIn = [];
    for (const field of target.fields.filter(field => field.links_to)) namedIn.push(await (async () => {
      const over = await lists.find(field.links_to);
      const titles = (await rowsOf(field.links_to)).flatMap(row => valuesOf(row.values?.[over.title_field]).map(title => title.trim())
        .filter(title => title.length >= rules.least_title_chars)
        .map(title => ({ id: row.id, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escape(title)}(?![\\p{L}\\p{N}])`, 'iu') })));
      return { field, titles };
    })());
    const linksOf = name => Object.fromEntries(namedIn.map(({ field, titles }) => {
      const own = holdersOfName.get(norm(name)) ?? [];
      const self = id => field.links_to === list_id && own.length === 1 && own[0] === id;
      return [field.id, [...new Set(titles.filter(title => title.pattern.test(name) && !self(title.id)).map(title => title.id))]];
    }).filter(([, ids]) => ids.length));
    for (let at = 0; at < made.length; at += data.limits.rows_per_write) {
      const kept = (await lists.putRows(links_to, { rows: made.slice(at, at + data.limits.rows_per_write).map(name => ({ values: { [target.title_field]: name, ...linksOf(name) } })) }, { actor })).kept;
      for (const row of kept) byName.set(norm(row.values[target.title_field]), row.id);
    }
    const { id: _id, rows: _rows, ...definition } = source;
    await lists.save({ id: list_id, ...definition, fields: source.fields.map(field => field.id === field_id
      ? { id: field.id, label: field.label, kind: 'link', links_to } : field) }, { actor });
    const moved = rows.map(row => ({ id: row.id, values: { [field_id]: [...new Set(valuesOf(row.values[field_id]).map(value => byName.get(norm(value))).filter(Boolean))] } }));
    for (let at = 0; at < moved.length; at += data.limits.rows_per_write) await lists.putRows(list_id, { rows: moved.slice(at, at + data.limits.rows_per_write) }, { actor });
    return { list_id, field_id, links_to, rows: moved.length, made: made.length };
  }

  return {
    candidates,
    linkField,
    nextAt(now = Date.now()) {
      const mark = eeaf.read(MARK);
      return mark?.due === true ? Math.max(now, (mark.looked_at ?? 0) + rules.every_minutes * 60_000) : null;
    },
    async step(now = Date.now()) {
      const [next] = await candidates();
      if (next) return await linkField(next);
      eeaf.write([{ id: MARK, type: rules.mark_type, value: { due: false, looked_at: now } }], { actor });
      return null;
    },
  };
}
