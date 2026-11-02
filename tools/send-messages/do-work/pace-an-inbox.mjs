// tools/send-messages/do-work/pace-an-inbox.mjs
//
// tool:pace-sends-from-an-inbox (argv "plan") and tool:sort-bounces-and-replies (argv "sort"): one JSON request on
// standard input and { result } as JSON on the last line. A request it cannot judge is refused with { error } saying
// what to fix. It sends nothing, keeps nothing and holds no key; the pacing and outcome rows are read-data/inbox-pacing.json.
import { text } from 'node:stream/consumers';
import { planSends, sortOutcomes } from '../read-data/inbox-pacing.mjs';

const run = { plan: planSends, sort: sortOutcomes }[process.argv[2]];
try {
  if (!run) throw new Error('Run with "plan" or "sort".');
  console.log(JSON.stringify({ result: run(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
