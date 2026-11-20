// test/formula-views-for-tests.mjs
//
// The formula engine's answers the way the lists owner reads them in these tests: which rows a rule tree holds for
// (filterRows), the rule kind each field kind is compared as (ruleKindOf, from src/lists.json), and a binding's value
// (evaluateBinding). Each one is a call of the Rust module tools/formula-engine/built-stored-bytes/formula-engine, loaded
// once from its folder's bytes. Tests in other tool folders import these names from here.
import { readFileSync } from 'node:fs';
import { evaluate, filterRecords, initSync } from '../../formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
import settings from '../src/lists.json' with { type: 'json' };

initSync({ module: readFileSync(new URL('../../formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm', import.meta.url)) });

const ruleKinds = new Map(settings.field_kinds.map(kind => [kind.id, kind.ruleKind]));
const EVERY_ROW = { kind: 'group', combinator: 'and', negate: false, rules: [] };

/** { tree, fields: [{id, kind}], rows } -> { matches: [row index], kept, incomplete }. A row that is not an object reads as
 *  no values, and a field a row does not hold is null. */
export function filterRows({ tree, fields, rows }) {
  const records = rows.map(row => (row && typeof row === 'object' ? row : {}));
  const { matches, kept, incomplete } = filterRecords({
    records,
    fields: fields.map(({ id, kind }) => ({ id, kind })),
    tree: tree && typeof tree === 'object' ? tree : EVERY_ROW,
  });
  return { matches, kept, incomplete };
}

export const ruleKindOf = kind => ruleKinds.get(kind) ?? kind;

/** A binding's value over its input (input left out reads as an empty input). */
export const evaluateBinding = async (binding, input) => evaluate({ binding, input: input ?? {} }).value;
