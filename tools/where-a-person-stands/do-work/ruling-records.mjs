// tools/where-a-person-stands/do-work/ruling-records.mjs
//
// Purpose
//   Rulings on single lines (good, bad or escalated, by whom, under which rule), kept as rows of the person's generic
//   Checks list (list:checks, record:check): the records:write input that adds the rulings not already in it. Ported from the copy gate's
//   verdict log (source-repo-a tools/copy-gate/verdicts.mjs recordVerdicts), whose JSON-lines file in the
//   repository is now the person's list; `freshRulings` was its first port here and is unchanged. This file reads and
//   writes nothing: the caller hands in the rulings already in the list (`existing`, as records:list pages them) and
//   sends `write` with records:write at @own-records.
//
// Non-negotiable invariants
//   1. Nothing is edited or removed. One record per (text, verdict, by, rule): its id is record:check:ruling- and the
//      BLAKE3 of those four (never a decider labelled-line id), and a ruling already in `existing` is not written again, so re-running a check does not
//      inflate the list and the first ruling keeps its time.
//   2. A write holding any row the list's own `refuse` setting names (a test piece, a temporary folder) is refused
//      whole, with the count, and nothing is written.
//   3. A ruling given by hand (`by_hand`) must use the words the `hand_rulings` setting allows for each field.
//   4. This file names no person, verdict word, film or folder: they arrive as input or as the person's setting.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import rulingData from '../read-data/rulings.json' with { type: 'json' };
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { asRulings, withSettings } from './rulings.mjs';

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

export class RulingRefusal extends Error {}

/** The rulings of a list page, read back: records ({ id, type, value }) or their values, each with its copy kind as `kind`. */
export const readVerdicts = (records = []) => asRulings(records);

// `place` ({ field, pattern }) names the field a ruling's place (a film, a piece) is kept in and the pattern whose first
// group reads it from the ruling's `where`, for a ruling that names none.
const placeOf = (where, place) => (place ? { [place.field]: String(where ?? '').match(new RegExp(place.pattern))?.[1] ?? null } : {});
// A path is matched with a leading / so a part like "/tmp/" finds a relative path too.
const isFixtureRow = (row, refuse) => refuse.some(test => (test.one_of ?? []).includes(row[test.field])
  || (test.contains_one_of ?? []).some(part => `/${String(row[test.field] ?? '').replace(/^\/+/, '')}`.includes(part)));

/** The id of the one record that keeps a ruling: `record:check:ruling-<hex of the BLAKE3 of [text, verdict, by, rule]>`. */
export function rulingRecordId(row) {
  return `${rulingData.id_prefix}${makeHashCodeHexFromJson(JSON.parse(keyOf(row))).slice(3)}`;
}

// A ruling as a row of list:checks: its kind (a labelled line, or an escalated one), part_of its rule or the branch named
// for rulings with none, and the ruling's own copy kind as line_kind.
function checkRow({ kind, ...ruling }, { unruled_part_of, escalated_verdicts }) {
  return { kind: escalated_verdicts.includes(ruling.verdict) ? rulingData.kinds.escalated : rulingData.kinds.ruled,
    part_of: [ruling.rule ?? unruled_part_of], ...ruling, ...(kind !== undefined ? { [rulingData.line_kind_field]: kind } : {}) };
}

/**
 * The records:write input that keeps the `rows` (each { text, verdict, by, rule?, kind?, at?, where?, ...any field kept })
 * not already in `existing` as rows of the person's list:checks (record:check, id record:check:ruling-<hex>). A row
 * without its own `at` takes `at` (default the time of this call); a row without its place takes it from `where` by
 * `place`; a row with no rule is part_of `unruled_part_of`. Returns { write: { records: [{ id, type, value }] }, fresh }.
 */
export function rulingRecords({ rows = [], existing = [], refuse = [], place = null, by_hand = false, hand_rulings = {}, at,
  unruled_part_of, escalated_verdicts = ['escalated'] } = {}) {
  if (![rows, existing, refuse, escalated_verdicts].every(Array.isArray) || refuse.some(test => typeof test?.field !== 'string')) throw new RulingRefusal(WORDS.refused_rows);
  for (const row of rows) if (!['text', 'verdict', 'by'].every(field => typeof row?.[field] === 'string' && row[field])) throw new RulingRefusal(WORDS.refused_row);
  if (rows.some(row => row.rule == null) && !(typeof unruled_part_of === 'string' && unruled_part_of)) throw new RulingRefusal(WORDS.refused_parent);
  if (by_hand) for (const [field, allowed] of Object.entries(hand_rulings)) for (const row of rows) if (!allowed.includes(row[field])) {
    throw new RulingRefusal(fill(WORDS.refused_word, { field, words: allowed.join(', '), value: JSON.stringify(row[field] ?? null) }));
  }
  const placed = rows.map(row => ({ ...placeOf(row.where, place), ...row }));
  const fixture = placed.filter(row => isFixtureRow(row, refuse));
  if (fixture.length) throw new RulingRefusal(fill(WORDS.refused_fixture, { count: fixture.length }));
  const fresh = freshRulings(readVerdicts(existing), placed, at === undefined ? {} : { at });
  return { write: { records: fresh.map(ruling => ({ id: rulingRecordId(ruling), type: rulingData.record_type,
    value: checkRow(ruling, { unruled_part_of, escalated_verdicts }) })) }, fresh: fresh.length };
}

/** `tool:keep-rulings-on-lines`, run by tools/records-door run-an-export: rulingRecords over the setting and input. */
export const keepRulings = async input => rulingRecords(await withSettings(input));
