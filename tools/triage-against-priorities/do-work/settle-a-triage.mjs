// tools/triage-against-priorities/do-work/settle-a-triage.mjs
//
// tool:settle-a-triage: one JSON request on standard input, { item, priorities, dispositions, min_confidence, answers? },
// where answers is the list holding the AI's one answer, and { result: { decision } } as JSON on the last line. The
// decision is the answer when it holds, else the fallback disposition, blocked, with the reasons. It does nothing but
// say: the owner of the disposition acts on it. A request it cannot settle is refused with { error }.
import { text } from 'node:stream/consumers';
import { settleTriage } from '../read-data/triage.mjs';

try {
  console.log(JSON.stringify({ result: { decision: settleTriage(JSON.parse((await text(process.stdin)) || '{}')) } }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
