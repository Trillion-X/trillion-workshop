// tools/triage-against-priorities/do-work/brief-a-triage.mjs
//
// tool:brief-a-triage: one JSON request on standard input, { item, priorities, dispositions, min_confidence }, and
// { result: { item, priorities, dispositions, rules, answer_shape, ... } } as JSON on the last line: what the caller's
// AI needs to judge the item. It asks no model and writes nothing. A request it cannot brief is refused with { error }.
import { text } from 'node:stream/consumers';
import { briefFor } from '../read-data/triage.mjs';

try {
  console.log(JSON.stringify({ result: briefFor(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
