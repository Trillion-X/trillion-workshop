// tools/selected-agent/run/plan-selected-agent.mjs
//
// Which AI answers a person, as the request that sets it: do-work/set-selected-agent.ts's own setSelectedAgent, run
// with the workspace's sender stood in by requests-kept-here.mjs, so the request it would send to the workflow slot is
// answered unsent. The row lays do-work/ under run/ (run/do-work/), so this file's import and that one's
// #workspace-records (run/package.json) both resolve in the run.
//
// Input:  { agent_id, definition_id? }   agent_id: the AI to answer the person, or "" to go back to automatic routing;
//                                        definition_id: the workflow definition that keeps the choice (the part's own
//                                        action:update-selected-agent when left out)
// Answer: { request: { target, payload }, automatic }: the one request setSelectedAgent sends, and whether it restores
//         automatic routing.
// Refuses an agent_id that is not text and a definition_id that is not a non-empty action id.
import { SELECTED_AGENT_ACTION, setSelectedAgent } from './do-work/set-selected-agent.ts';
import { kept } from './requests-kept-here.mjs';

export async function planSelectedAgent({ agent_id, definition_id = SELECTED_AGENT_ACTION } = {}) {
  if (typeof agent_id !== 'string') throw new Error('Give agent_id: the id of the AI to answer, or "" for automatic routing.');
  if (typeof definition_id !== 'string' || !/^action:[a-z0-9-]+$/.test(definition_id)) throw new Error('definition_id is an action id such as action:update-selected-agent; leave it out for that one.');
  kept.length = 0;
  await setSelectedAgent(agent_id, definition_id);
  if (kept.length !== 1) throw new Error(`setSelectedAgent sent ${kept.length} requests; it sends one.`);
  return { request: kept[0], automatic: agent_id === '' };
}
