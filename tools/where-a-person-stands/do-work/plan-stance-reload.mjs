// tools/where-a-person-stands/do-work/plan-stance-reload.mjs
//
// Stands kept elsewhere (an export, an earlier store) as the stance record versions to write, each record's earlier
// stands first, oldest first, with what changed: records and versions by kind, how many identities differ from the old
// refs, and which rows the fold made one record. Run by the Workshop tool `tool:plan-a-stance-reload` in the tool
// container:
//
//   node do-work/plan-stance-reload.mjs < <the input as JSON>
//
// and prints { result: { writes?, summary } } as JSON on its last line (summary_only true leaves writes out). It writes
// nothing: the writes are for the caller to send, one version at a time, in order.
import { text } from 'node:stream/consumers';
import { planReload } from './where-a-person-stands.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
try {
  const { writes, summary } = planReload(input);
  console.log(JSON.stringify({ result: input.summary_only ? { summary } : { writes, summary } }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
