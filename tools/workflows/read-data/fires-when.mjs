// tools/workflows/read-data/fires-when.mjs
//
// Where a workflow says when it fires (branches/fires-when.json) and what is wrong with what it says. Kept apart from the
// chooser so the recipe validator reads it without the chooser's records door.
//
//   conditionProblems(conditions, where?) -> sentences   none when the conditions are absent or whole

import { readFileSync } from 'node:fs';
import { filterRecords } from '../../formulas/do-work/requests.mjs';

export const FIRES_WHEN = JSON.parse(readFileSync(new URL('../branches/fires-when.json', import.meta.url), 'utf8'));

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Every problem with one workflow's conditions, as sentences; none when they are absent.
export function conditionProblems(conditions, where = FIRES_WHEN.field) {
  if (conditions === undefined) return [];
  if (!Array.isArray(conditions)) return [`${where} must be a list of conditions { label, condition: { fields, tree }, made_by, state }.`];
  const problems = [];
  conditions.forEach((item, index) => {
    const name = `${where}[${index}]`;
    if (!object(item) || typeof item.label !== 'string' || !item.label.trim()) { problems.push(`${name} must have a label saying the condition in words.`); return; }
    if (!object(item.condition) || !Array.isArray(item.condition.fields) || !object(item.condition.tree)) { problems.push(`${name}.condition must be { fields, tree } as tool:filter-rows-by-rules takes them.`); return; }
    if (typeof item.made_by !== 'string' || !item.made_by) problems.push(`${name}.made_by must say who wrote the condition.`);
    let answer;
    try { answer = filterRecords({ records: [], fields: item.condition.fields, tree: item.condition.tree }); } catch (error) { problems.push(`${name}.condition is refused: ${error.message}`); return; }
    if (answer.incomplete.length) problems.push(`${name}.condition has unfinished rules: ${JSON.stringify(answer.incomplete)}.`);
    if (!answer.reads.length) problems.push(`${name}.condition reads no field, so it would keep every part.`);
  });
  return problems;
}
