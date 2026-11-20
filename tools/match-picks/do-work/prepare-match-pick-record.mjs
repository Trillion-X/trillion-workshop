// tools/match-picks/do-work/prepare-match-pick-record.mjs
//
// The command of tool:prepare-a-match-pick-record. One JSON request on standard input:
//   { what: "prompt" | "pick" | "result", ...the record's fields, banned_terms?, now? }
// and { result: { id, record } } out: the checked record to keep, or a refusal that says which field is missing or which
// banned wording was used. See read-data/pick-records.mjs.
import { runAsMain } from '../read-data/run-as-main.mjs';
import { prepareMatchPickRecord } from '../read-data/pick-records.mjs';

export { prepareMatchPickRecord };

await runAsMain(import.meta.url, prepareMatchPickRecord);
