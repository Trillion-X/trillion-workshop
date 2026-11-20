// tools/space-members/do-work/space-members-run.mjs
//
// The command the five membership rows run: one JSON request on standard input, and { result } (or { error }) as JSON on the
// last line. The first argument names the function (do-work/space-members.mjs): joinASpace, leaveASpace, createASpace,
// checkSomeoneIsInASpace, listASpacesMembers, chooseTheNameIShowInASpace, postInASpace, listASpacesPosts or listMySpacesAndEvents. Nothing here reaches a store: the records the
// request needs are in the request, handed in by the caller who reads them from the person's own store.
import { text } from 'node:stream/consumers';
import { checkSomeoneIsInASpace, chooseTheNameIShowInASpace, createASpace, joinASpace, leaveASpace, listASpacesMembers, listASpacesPosts, listMySpacesAndEvents, postInASpace } from './space-members.mjs';

const FUNCTIONS = { joinASpace, leaveASpace, createASpace, checkSomeoneIsInASpace, listASpacesMembers, chooseTheNameIShowInASpace, postInASpace, listASpacesPosts, listMySpacesAndEvents };

try {
  const run = FUNCTIONS[process.argv[2]];
  if (!run) throw new Error(`Say which: ${Object.keys(FUNCTIONS).join(', ')}.`);
  console.log(JSON.stringify({ result: run(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof SyntaxError ? `the request is not JSON: ${error.message}` : error.message }));
  process.exitCode = 1;
}
