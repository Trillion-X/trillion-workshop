// tools/what-is-waiting-on-me/read-data/waiting.mjs
//
// Everything that waits on one person, gathered from the places it is kept into one answer. A place is a source row the
// person keeps (which records, which of them wait, how a card reads); the caller reads each source's records from the
// person's account and hands them in as `found`; this merges them into cards, newest first, with a count for each source.
// Pure: no record read, no clock, no network.
//
// Invariants:
//   1. Nothing here names a source, a kind of record or a thing that can wait. A source row says which records wait
//      (`where`), how a card reads (`title`, `detail`, `opens` as templates over the record's own fields) and where its
//      time is (`at`); a new place that holds things up is a new row.
//   2. A record waits only when every `where` test holds; a record that gives its card no title is not shown and is
//      counted as skipped, never shown blank.
//   3. A source row that is not plainly shaped is refused with its id; one with no records handed in is told as `unread`,
//      never as having nothing waiting, so a source nobody read cannot hide what waits.
//   4. Same input, same answer: cards sort by their time (newest first), then by source order and id.
//
// A source row is { id, label, where?: [{ field, equals? | in? | present? | absent? }], title, detail?, opens?, at?, id_field?, most? }.
// `found` is { <source id>: [{ id, value }] }. A card is { source, label, id, title, detail?, opens?, at? }.
import { readFileSync } from 'node:fs';

export const readSettings = () => JSON.parse(readFileSync(new URL('./waiting-words.json', import.meta.url), 'utf8'));
const refuse = words => { throw new Error(words); };
const present = value => value !== undefined && value !== null && value !== '';
const at = (value, path) => String(path).split('.').reduce((node, part) => (node !== null && typeof node === 'object' ? node[part] : undefined), value);
const fill = (template, record) => String(template).replace(/\{([\w.-]+)\}/g, (_, path) => {
  const found = at(record, path);
  return present(found) && typeof found !== 'object' ? String(found) : '';
});

function readSource(row, index) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) refuse(`sources[${index}] needs an id.`);
  if (typeof row.title !== 'string' || !row.title) refuse(`source ${row.id} needs a title template.`);
  for (const test of row.where ?? []) {
    const kinds = ['equals', 'in', 'present', 'absent'].filter(kind => kind in test);
    if (!test || typeof test.field !== 'string' || kinds.length !== 1) refuse(`source ${row.id}: each where test is { field } with one of equals, in, present or absent.`);
    if ('in' in test && !Array.isArray(test.in)) refuse(`source ${row.id}: in is a list.`);
  }
  if (row.most !== undefined && !(Number.isInteger(row.most) && row.most > 0)) refuse(`source ${row.id}: most is a whole number above 0.`);
  return row;
}

const waits = (value, tests = []) => tests.every(test => {
  const held = at(value, test.field);
  if ('equals' in test) return held === test.equals;
  if ('in' in test) return test.in.includes(held);
  if ('present' in test) return present(held);
  return !present(held);
});

/** input { sources, found, words? } -> { cards, sources: [{ id, label, waiting, skipped, unread }], count, said } */
export function whatIsWaitingOnMe(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('Send an object.');
  if (!Array.isArray(input.sources) || !input.sources.length) refuse('sources is a list of the places that hold things up: { id, label, title, where?, ... }.');
  const found = input.found && typeof input.found === 'object' ? input.found : {};
  const words = { ...readSettings().words, ...(input.words && typeof input.words === 'object' ? input.words : {}) };
  const seen = new Set();
  const cards = [];
  const sources = input.sources.map((raw, order) => {
    const row = readSource(raw, order);
    if (seen.has(row.id)) refuse(`Two sources are called ${row.id}.`);
    seen.add(row.id);
    const records = found[row.id];
    if (!Array.isArray(records)) return { id: row.id, label: row.label ?? row.id, waiting: 0, skipped: 0, unread: true };
    let skipped = 0;
    const mine = [];
    for (const record of records) {
      const value = record && typeof record === 'object' ? (record.value ?? record) : null;
      if (!value || !waits(value, row.where)) continue;
      const title = fill(row.title, value).trim();
      if (!title) { skipped += 1; continue; }
      const id = String(record.id ?? at(value, row.id_field ?? 'id') ?? title);
      mine.push({
        source: row.id, label: row.label ?? row.id, id, title,
        ...(row.detail && fill(row.detail, value).trim() ? { detail: fill(row.detail, value).trim() } : {}),
        ...(row.opens && fill(row.opens, value).trim() ? { opens: fill(row.opens, value).trim() } : {}),
        ...(row.at && present(at(value, row.at)) ? { at: String(at(value, row.at)) } : {}),
        order,
      });
    }
    mine.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.id.localeCompare(b.id));
    const kept = row.most ? mine.slice(0, row.most) : mine;
    cards.push(...kept);
    return { id: row.id, label: row.label ?? row.id, waiting: mine.length, skipped, unread: false };
  });
  cards.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.order - b.order || a.id.localeCompare(b.id));
  const unread = sources.filter(source => source.unread);
  const said = (cards.length ? (cards.length === 1 ? words.one : words.many.replace('{count}', String(cards.length))) : words.none)
    + (unread.length ? ` ${words.unread.replace('{sources}', unread.map(source => source.label).join(', '))}` : '');
  return { cards: cards.map(({ order: _order, ...card }) => card), sources, count: cards.length, said };
}
