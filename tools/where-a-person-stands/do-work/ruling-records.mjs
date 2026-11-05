// tools/where-a-person-stands/do-work/ruling-records.mjs
//
// Purpose
//   Rulings on single lines (good, bad or escalated, by whom, under which rule), kept as rows of a list in the person's
//   own account: the records:write input that adds the rulings not already in that list. Ported from the copy gate's
//   verdict log (source-repo-a tools/copy-gate/verdicts.mjs recordVerdicts), whose JSON-lines file in the
//   repository is now the person's list; `freshRulings` was its first port here and is unchanged. This file reads and
//   writes nothing: the caller hands in the rulings already in the list (`existing`, as records:list pages them) and
//   sends `write` with records:write at @own-records.
//
// Non-negotiable invariants
//   1. Nothing is edited or removed. One record per (text, verdict, by, rule): its id is the list's row type and the
//      BLAKE3 of those four, and a ruling already in `existing` is not written again, so re-running a check does not
//      inflate the list and the first ruling keeps its time.
//   2. A write holding any row the list's own `refuse` setting names (a test piece, a temporary folder) is refused
//      whole, with the count, and nothing is written.
//   3. A ruling given by hand (`by_hand`) must use the words the `hand_rulings` setting allows for each field.
//   4. This file names no person, verdict word, film or folder: they arrive as input or as the person's setting.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import rulingData from '../read-data/rulings.json' with { type: 'json' };
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { withSettings } from './rulings.mjs';

const keyOf = row => JSON.stringify([row.text, row.verdict, row.by, row.rule ?? null]);

/** The rows of `rows` not already in `existing`, each stamped `at` (unless it has its own): what to append to the log. */
export function freshRulings(existing, rows, { at = new Date().toISOString() } = {}) {
  const seen = new Set(existing.map(keyOf));
  const fresh = [];
  for (const row of rows) {
    const full = { at, ...row };
    if (seen.has(keyOf(full))) continue;
    seen.add(keyOf(full));
    fresh.push(full);
  }
  return fresh;
}

const WORDS = rulingData.words;
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const ROW_TYPE = /^[a-z0-9][a-z0-9-]*$/;

export class RulingRefusal extends Error {}

/** The rulings of a list page, read back: records ({ id, type, value }) or their values. */
export const readVerdicts = (records = []) => records.map(record => (record && typeof record === 'object' && 'value' in record && 'type' in record
  ? record.value : record)).filter(Boolean);

// `place` ({ field, pattern }) names the field a ruling's place (a film, a piece) is kept in and the pattern whose first
// group reads it from the ruling's `where`, for a ruling that names none.
const placeOf = (where, place) => (place ? { [place.field]: String(where ?? '').match(new RegExp(place.pattern))?.[1] ?? null } : {});
// A path is matched with a leading / so a part like "/tmp/" finds a relative path too.
const isFixtureRow = (row, refuse) => refuse.some(test => (test.one_of ?? []).includes(row[test.field])
  || (test.contains_one_of ?? []).some(part => `/${String(row[test.field] ?? '').replace(/^\/+/, '')}`.includes(part)));

/** The id of the one record that keeps a ruling: `record:<row_type>:<hex of the BLAKE3 of [text, verdict, by, rule]>`. */
export function rulingRecordId(row_type, row) {
  return `${rulingData.record_prefix}${row_type}:${makeHashCodeHexFromJson(JSON.parse(keyOf(row))).slice(3)}`;
}

/**
 * The records:write input that keeps the `rows` (each { text, verdict, by, rule?, at?, where?, ...any field the list
 * keeps }) not already in `existing` as rows of the list whose row type is `row_type`. A row without its own `at` takes
 * `at` (default the time of this call); a row without its place takes it from `where` by `place`. Returns
 * { write: { records: [{ id, type, value }] }, fresh: <how many are new> }.
 */
export function rulingRecords({ rows = [], existing = [], row_type, refuse = [], place = null, by_hand = false, hand_rulings = {}, at } = {}) {
  if (typeof row_type !== 'string' || !ROW_TYPE.test(row_type)) throw new RulingRefusal(WORDS.refused_row_type);
  if (![rows, existing, refuse].every(Array.isArray) || refuse.some(test => typeof test?.field !== 'string')) throw new RulingRefusal(WORDS.refused_rows);
  for (const row of rows) if (!['text', 'verdict', 'by'].every(field => typeof row?.[field] === 'string' && row[field])) throw new RulingRefusal(WORDS.refused_row);
  if (by_hand) for (const [field, allowed] of Object.entries(hand_rulings)) for (const row of rows) if (!allowed.includes(row[field])) {
    throw new RulingRefusal(fill(WORDS.refused_word, { field, words: allowed.join(', '), value: JSON.stringify(row[field] ?? null) }));
  }
  const placed = rows.map(row => ({ ...placeOf(row.where, place), ...row }));
  const fixture = placed.filter(row => isFixtureRow(row, refuse));
  if (fixture.length) throw new RulingRefusal(fill(WORDS.refused_fixture, { count: fixture.length }));
  const fresh = freshRulings(readVerdicts(existing), placed, at === undefined ? {} : { at });
  const type = `${rulingData.record_prefix}${row_type}`;
  return { write: { records: fresh.map(value => ({ id: rulingRecordId(row_type, value), type, value })) }, fresh: fresh.length };
}

/** `tool:keep-rulings-on-lines`, run by tools/records-door run-an-export: rulingRecords over the setting and input. */
export const keepRulings = async input => rulingRecords(await withSettings(input));
