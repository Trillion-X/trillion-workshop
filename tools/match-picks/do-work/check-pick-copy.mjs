// tools/match-picks/do-work/check-pick-copy.mjs
//
// The command of tool:check-pick-copy. One JSON request on standard input:
//   { texts: [{ field, text }], banned_terms: ["...", ...] }
// and { result: { passed, findings: [{ field, term, message }] } } out. Run it on a pick prompt's label and choices and on a
// result's summary before writing them.
import { runAsMain } from '../read-data/run-as-main.mjs';
import { findBannedCopy } from '../read-data/pick-copy.mjs';

export const checkPickCopy = input => findBannedCopy(input?.texts, input?.banned_terms);

await runAsMain(import.meta.url, checkPickCopy);
