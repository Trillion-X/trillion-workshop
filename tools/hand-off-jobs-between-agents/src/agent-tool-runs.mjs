// src/agent-tool-runs.mjs
//
// PURPOSE
//   The Workshop executor `agent`: a tool whose placement names one of the person's own agents (settings.agent_id),
//   such as the tools on the person's computer (placement:your-computer, agent computer-tools), runs on that agent. The run is
//   handed to it as { tool_id, input } (tool_id is the row's invoke.tool_id), and what it finishes with is the run's
//   raw output, which the Workshop then checks against the tool's output schema like any other run.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The agent is named by the placement's DATA, never by code here; the words said when it is absent or late are
//      the placement's settings.words.
//   2. Work the agent has not taken within settings.wait_seconds is withdrawn, so an eject or a move cannot happen
//      later, after the person was told it did not; work already taken is left to finish.
//   3. An answer carrying `error` (text) is the run's error.
//   4. A tool whose DATA names `needs.priority` (0-9) is handed with that priority, so a run a person waits on (holding
//      or releasing their Mac) is taken before background work queued for the same agent (many model calls), never
//      after it; the queue is taken highest priority first, then oldest (src/agents.mjs). An in-memory ask whose caller
//      names a priority (task.priority, src/workshop.mjs askInMemory) is handed with that one, unless the tool's DATA
//      names its own.
//   5. An asker that needs the answer itself by a time (wait_ms: a model call Trillion makes, src/workshop.mjs
//      askInMemory) hands the work with take_within_seconds of that wait less the tool's needs.expected_seconds, or of
//      the shorter take_within_ms its route names, so the queue never hands it out once nobody would read its answer
//      (src/agents.mjs take_by); and it stops waiting at its time even when the work was taken. A run waits for its
//      answer however long the work takes, and is withdrawn when not taken within the placement's wait_seconds.
//   6. A Workshop `computer` row (its code in a trillion-workshop tool folder) declares its answer at `$.result`, the shape
//      that repository's run-an-export.mjs prints and the Mac's tool host now answers with (computer/mac-tools.mjs). A Mac
//      app released before the tool moved there answers the function's answer itself; that answer is read as the
//      result, so an older app keeps working until it updates.

import { reachabilityOf } from '../../shared-code/src/agent-delivery.mjs';
import { cardSkillFor, currentToolId, formerAgentIds } from '../../shared-code/src/renamed-tools.mjs';

const FROM = 'trillion-workshop';

/** A placement may bind only its DATA-listed tools to one exact computer. Never fall back to an unscoped host. */
export function agentForTool({ agents, settings, tool_id, input, now = Date.now() }) {
  const scope = settings.computer_scope;
  // An app published before the rename may advertise only the former agent id, so the unscoped agent is asked under both.
  if (!scope?.tool_ids?.includes(currentToolId(tool_id))) {
    return [settings.agent_id, ...formerAgentIds(settings.agent_id)].find(id => agents.cardOf?.(id)) ?? settings.agent_id;
  }
  const id = input?.[scope.input_field];
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id)) throw new Error('This tool requires the exact recorded computer ID.');
  // A computer whose app was published before the rename advertises the former agent id; the current id wins when both exist.
  const candidates = [`${scope.agent_prefix}${id}`, ...formerAgentIds(`${scope.agent_prefix}${id}`)];
  const agent_id = candidates.find(candidate => agents.cardOf?.(candidate)) ?? candidates[0];
  const card = agents.cardOf?.(agent_id);
  const has = value => card?.skills?.some(skill => skill.id === value);
  if (!card || card.takes_work !== true || !cardSkillFor(card, tool_id) || !has(`${scope.skill_prefix}${id}`) ||
    !(card.capacity_claim?.max_concurrent > 0) || !(Date.parse(card.capacity_claim.expires_at) > now) ||
    !(agents.reach?.(agent_id) ?? reachabilityOf(card, new Date(now))).present) {
    throw new Error('This exact computer has not advertised the installed tool with current capacity. Update or reconnect the Trillion app on that computer; no other computer was selected.');
  }
  return agent_id;
}

/** Whether the computer this placement would hand this tool's run to is connected now (src/workshop.mjs sampleChecked
 * asks before a sample runs there): the agent agentForTool chooses holds its live connection or was seen just now. Any
 * refusal to choose one is not connected. */
export function agentConnected({ agents, placement, tool, input }) {
  try {
    const agent_id = agentForTool({ agents, settings: placement.settings ?? {}, tool_id: tool.invoke?.tool_id ?? tool.id, input });
    const reached = agents.reach(agent_id);
    return reached?.live === true || reached?.present === true;
  } catch {
    return false;
  }
}

/** A computer's answer in the shape the tool row declares (invariant 6). */
export function answerAsDeclared(tool, result) {
  const wrapped = tool?.invoke?.kind === 'computer' && tool.result_selector === '$.result';
  return wrapped && result && typeof result === 'object' && !Array.isArray(result) && !Object.hasOwn(result, 'result') ? { result } : result;
}

export async function runOnAgent({ agents, placement, tool, invocation, input, task, every_ms = 1000, wait_ms, take_within_ms }) {
  const settings = placement.settings ?? {};
  const words = settings.words ?? {};
  const tool_id = invocation?.tool_id ?? tool.id;
  // A tool may compose an existing computer operation with a DATA-bound input (for example an app job).
  // The same concrete input selects the computer and reaches it, so a template cannot split those identities.
  const runInput = invocation && Object.hasOwn(invocation, 'input') ? invocation.input : input;
  if (runInput !== undefined && (!runInput || typeof runInput !== 'object' || Array.isArray(runInput))) throw new Error('A computer tool input must be an object.');
  const agent_id = agentForTool({ agents, settings, tool_id, input: runInput });
  if (!agents.reach(agent_id)) throw new Error(words.absent ?? `${placement.label} is not connected to this account.`);
  // Explicit runs go ahead of background model checks, unless the tool DATA sets its own priority (for example a
  // Mac control tool). In-memory asks and scheduled runs keep ordinary priority.
  const foreground = String(task.task_id ?? '').startsWith('task_') &&
    (task.started_by === 'person' || (!task.started_by && !task.due_at && !task.repeat_every_hours));
  const priority = Number.isInteger(tool.needs?.priority) ? tool.needs.priority : Number.isInteger(task.priority) ? task.priority : foreground ? 6 : 0;
  const answerBy = Number.isFinite(wait_ms) && wait_ms > 0;
  const waitMs = answerBy ? wait_ms : (settings.wait_seconds ?? 110) * 1000;
  const takeWithin = Number.isFinite(take_within_ms) && take_within_ms > 0 ? Math.max(1, Math.floor(Math.min(take_within_ms, waitMs) / 1000))
    : Math.max(1, Math.floor(waitMs / 1000 - (answerBy ? Number(tool.needs?.expected_seconds) || 0 : 0)));
  // The agent that takes the work knows the tool by the id its card lists (a current app lists the current id, an older one the former id).
  const handed_tool_id = cardSkillFor(agents.cardOf?.(agent_id), tool_id)?.id ?? tool_id;
  const { handoff } = agents.handOff({
    job: `Run ${tool.label ?? tool.id} on this computer.`, to_agent: agent_id, from_agent: FROM,
    input: { tool_id: handed_tool_id, input: runInput ?? {} }, request_key: `tool-run:${task.task_id}`, notice: tool.label ?? tool.id,
    ...(priority || Number.isInteger(tool.needs?.priority) || Number.isInteger(task.priority) ? { priority } : {}), take_within_seconds: takeWithin,
    // An ask kept nowhere (src/workshop.mjs askInMemory) is handed in memory too (src/agents.mjs invariants).
    ...(task.in_memory === true ? { in_memory: true } : {}),
  });
  const until = Date.now() + waitMs;
  // Work still not taken when its take_within_seconds runs out can no longer be taken (src/agents.mjs take_by), so the
  // asker stops then instead of waiting out the rest of its wait for an answer that cannot come.
  const takeUntil = Date.now() + takeWithin * 1000;
  for (;;) {
    const now = agents.read({ handoff_id: handoff.handoff_id }).handoff;
    if (now.state === 'finished') {
      const result = now.result;
      if (result && typeof result === 'object' && typeof result.error === 'string') throw new Error(result.error);
      if (result && typeof result === 'object' && result.withdrawn_by === FROM) throw new Error(words.late ?? `${placement.label} did not answer in time.`);
      return answerAsDeclared(tool, result);
    }
    if (now.state === 'open' ? Date.now() >= Math.min(until, takeUntil) : Date.now() >= until && answerBy) {
      if (now.state === 'open') agents.withdraw({ handoff_id: handoff.handoff_id, by: FROM, result: { withdrawn_by: FROM }, summary: 'Not taken in time, so withdrawn.' });
      throw new Error(words.late ?? `${placement.label} did not answer in time.`);
    }
    await new Promise(resolve => setTimeout(resolve, every_ms));
  }
}
