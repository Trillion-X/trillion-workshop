// tools/check-against-a-persons-rules-and-verdicts/do-work/examples-from-where-they-stand.mjs
//
// A person's stands as labelled examples for the reading rows of their rule document (do-work/rules-and-verdicts.mjs
// `examplesFromStands`), so the model that answers those rows can be calibrated on that person's own verdicts. Run by the
// Workshop tool `tool:make-examples-from-where-a-person-stands` in the tool container:
//
//   node do-work/examples-from-where-they-stand.mjs < <the input as JSON>
//
// and prints { result: { items, rows } } as JSON on its last line, or { error } and what to send instead.
import { text } from 'node:stream/consumers';
import { compileVerdictRules, examplesFromStands } from './rules-and-verdicts.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
try {
  console.log(JSON.stringify({ result: examplesFromStands(compileVerdictRules(input.verdict_rules), input.stands ?? []) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
