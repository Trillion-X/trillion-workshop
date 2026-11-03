// tools/decide-agent-actions/do-work/requests.mjs
//
// One function per Workshop row. Each takes the request object a person's AI sent, refuses what it cannot run with a
// sentence that says what to send, and returns the answer. The verdicts, behaviours, scopes and sentences are DATA
// (read-data/action-policy-vocabulary.json); the policy rows, grants and the clock are the request's.
import { checkPolicy, decideAction } from './decide-action.mjs';

/** Whether one action may run, must be asked of the person first, or is refused. */
export function decideAnAgentAction(request) {
  return decideAction(request);
}

/** The problems of an action policy, before it is relied on. */
export function checkAnActionPolicy(request) {
  return checkPolicy(request);
}
