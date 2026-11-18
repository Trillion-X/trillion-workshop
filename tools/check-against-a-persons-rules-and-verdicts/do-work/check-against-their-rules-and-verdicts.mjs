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
// read from the person's own method and check rows, given in the input's `stored` (records-door/read-data/values-door.mjs:
// the engine keeps none of them), and the answer adds branch, lineage, rows_used and read_by_a_model.
//
// The two piece rows run the same command with their name as its one argument:
//   split-a-document-into-pieces  { text | name, file?, file_identity? } -> the document's pieces in the answer, nothing kept
//                                 (do-work/pieces.mjs splitIntoPieces), a named document's bytes from `stored` files
//   check-every-piece-is-covered  { file?, after?, most_bytes? } -> coverage of the person's piece rows, read page by page
//                                 (do-work/piece-sweep.mjs coverageInRecords), the rows from `stored`
//   check-a-films-copy            { branch, settings_record, files, ... } -> a film's copy checked against the branch, with
//                                 its report (do-work/check-a-films-copy.mjs checkAFilmsCopy), the rows from `stored`
// Every mode only reads: what it reads is given, so nothing is kept.
import { text } from 'node:stream/consumers';

const { stored, ...input } = JSON.parse((await text(process.stdin)) || '{}');
try {
  if (process.argv[2] === 'split-a-document-into-pieces') {
    const { splitIntoPieces } = await import('./pieces.mjs');
    // Only a document sent by name is read from what is given; text is split as it is.
    const door = typeof input.name === 'string' ? (await import('../../records-door/read-data/values-door.mjs')).valuesDoor(stored).door : null;
    console.log(JSON.stringify({ result: await splitIntoPieces(input, door) }));
  } else if (process.argv[2] === 'check-every-piece-is-covered') {
    const { coverageInRecords } = await import('./piece-sweep.mjs');
    const { valuesDoor } = await import('../../records-door/read-data/values-door.mjs');
    console.log(JSON.stringify({ result: await coverageInRecords(valuesDoor(stored).door, { file: input.file, after: input.after, most_bytes: input.most_bytes }) }));
  } else if (process.argv[2] === 'check-a-films-copy') {
    const { checkAFilmsCopy } = await import('./check-a-films-copy.mjs');
    const { valuesDoor } = await import('../../records-door/read-data/values-door.mjs');
    console.log(JSON.stringify({ result: await checkAFilmsCopy(input, valuesDoor(stored).door) }));
  } else if (input.branch !== undefined) {
    const { checkABranch } = await import('./check-a-branch.mjs');
    const { valuesDoor } = await import('../../records-door/read-data/values-door.mjs');
    console.log(JSON.stringify({ result: await checkABranch(input, valuesDoor(stored).door) }));
  } else {
    const { check, compileVerdictRules, linesOf, statusOf } = await import('./rules-and-verdicts.mjs');
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
