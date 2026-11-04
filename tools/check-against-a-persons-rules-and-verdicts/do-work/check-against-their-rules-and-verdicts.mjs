// tools/check-against-a-persons-rules-and-verdicts/do-work/check-against-their-rules-and-verdicts.mjs
//
// Words, or anything made, checked against a person's own rules and verdicts (do-work/rules-and-verdicts.mjs `check`).
// Run by the Workshop tool `tool:check-against-a-persons-rules-and-verdicts` in the tool container:
//
//   node do-work/check-against-their-rules-and-verdicts.mjs < <the input as JSON>
//
// and prints { result: { status, passed, results, questions, lines } } as JSON on its last line. A request it cannot
// check (no rules, no units, an incomplete rule document, a rule row judge-words cannot compile) is refused with
// { error } and what to send instead.
//
// With `branch` (and no rules) it is the branch mode (do-work/check-a-branch.mjs): the rules and the rule document are
// read from the person's own method and check rows through the records door handed to the run on descriptor 3, and
// the answer adds branch, lineage and rows_used.
import { text } from 'node:stream/consumers';
import { check, compileVerdictRules, linesOf, statusOf } from './rules-and-verdicts.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
try {
  if (input.branch !== undefined) {
    const { checkABranch } = await import('./check-a-branch.mjs');
    const { openRecordsDoor } = await import('../../records-door/read-data/records-door.mjs');
    console.log(JSON.stringify({ result: await checkABranch(input, openRecordsDoor()) }));
  } else {
    const verdictRules = input.verdict_rules === undefined ? null : compileVerdictRules(input.verdict_rules);
    const { results, questions } = check(input.units, input.rules, { answers: input.answers ?? {}, stands: input.stands ?? [], verdictRules,
      stage: input.stage, fieldsByKind: input.fields_by_kind ?? {}, asOf: input.stands_as_of ?? null });
    const status = statusOf(results);
    console.log(JSON.stringify({ result: { status, passed: status === 'passed', results, questions, lines: linesOf(results) } }));
  }
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
