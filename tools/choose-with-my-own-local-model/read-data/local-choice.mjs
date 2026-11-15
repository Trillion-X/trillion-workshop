// An explicit choice from an AI chat reaches only the person's own device route. The caller supplies the
// candidates; no private input or answer is kept in choice observations. A closed chat counts only when it calls.
import tasks from '../../choose-locally/src/local-choice-tasks.json' with { type: 'json' };
import modelRoutes from '../../route-model-calls/src/model-routes.json' with { type: 'json' };
import { ask as askLocal } from '../../models-on-this-computer/read-data/models-on-this-computer.mjs';

// The current local-model tool replaces the retired Worker/device queue. An admitted caller
// may still supply that queue's ask contract; it only ever receives the device route.
async function askDevice({ ask, route, input, priority }) {
  try {
    const output = ask
      ? await ask({ tool_id: route.tool_id, input, timeout_ms: route.wait_seconds * 1000, ...(Number.isInteger(priority) ? { priority } : {}),
        ...(Number.isFinite(route.take_within_seconds) ? { take_within_ms: route.take_within_seconds * 1000 } : {}) })
      : await askLocal(input);
    return output && !output.error ? output : null;
  } catch { return null; }
}

const text = (value, most) => typeof value === 'string' ? value.trim().slice(0, most) : '';

export function explicitChoiceInput(input) {
  const state = text(input?.state, 3000);
  const criteria = text(input?.criteria, 1000);
  const source = input?.candidates;
  if (!state || !Array.isArray(source) || source.length < 2 || source.length > 16) throw new Error('Give a situation and 2 to 16 candidates.');
  const candidates = source.map(row => ({ id: text(row?.id, 80), label: text(row?.label, 160), description: text(row?.description, 400) }));
  if (candidates.some(row => !/^[a-z0-9][a-z0-9_-]*$/i.test(row.id) || !row.label) || new Set(candidates.map(row => row.id)).size !== candidates.length)
    throw new Error('Each candidate needs a distinct simple id and a label.');
  return { state, criteria, candidates };
}

export function explicitChoiceReply(reply, candidates) {
  const raw = typeof reply === 'string' ? reply : reply?.choices?.[0]?.message?.content ?? reply?.response ?? reply?.content;
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  const choice = candidates.find(row => row.id === parsed?.id);
  return choice ? { choice: choice.id, label: choice.label, reason: text(parsed.reason, 400), model: reply.served_by ?? reply.model ?? null } : null;
}

/** One candidate question and validator serve deliberate local choices and resumable shared work alike. */
export function explicitChoiceRequest(input) {
  const { state, criteria, candidates } = explicitChoiceInput(input);
  return { candidates, input: { max_tokens: 300, temperature: 0, messages: [
    { role: 'system', content: 'Choose one candidate from the evidence supplied. Answer JSON only: {"id":"candidate id","reason":"one short reason"}. If evidence is insufficient, answer {"id":"","reason":"insufficient evidence"}.' },
    { role: 'user', content: JSON.stringify({ state, criteria, candidates }) },
  ] } };
}

export async function chooseLocal(input, { ask, observations, taskId = 'explicit-selection', surface = 'mcp-choice' }) {
  const question = explicitChoiceRequest(input);
  const task = tasks.tasks.find(row => row.id === taskId && row.surfaces.includes(surface));
  if (!task) throw new Error('No local choice task serves this surface.');
  const route = modelRoutes.conversation.find(row => row.kind === 'device');
  const job = modelRoutes.jobs?.[task.id] ?? {};
  return observations.run({ task: task.id, surface, deadline_ms: task.deadline_ms,
    decide: async () => {
      if (!route) return null;
      const reply = await askDevice({ ask, route: { ...route, ...(job.route ?? {}) }, priority: job.priority,
        input: { job: task.id, ...question.input } });
      return reply ? explicitChoiceReply(reply, question.candidates) : null;
    } });
}

export const explicitChoiceTools = call => [{ name: 'choose_local_choice',
  description: 'Ask the person’s own local model to choose among 2 to 16 supplied candidates under a deadline. Works from connected AI chats when called; reports unavailable if the Mac does not answer, and never sends this choice to paid hosted inference. Give state, optional criteria, and candidates with distinct id, label and optional description. Internal choices in a closed chat are not observed unless this tool is called.',
  inputSchema: { type: 'object', required: ['state', 'candidates'], properties: {
    state: { type: 'string' }, criteria: { type: 'string' }, candidates: { type: 'array', minItems: 2, maxItems: 16,
      items: { type: 'object', required: ['id', 'label'], properties: { id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' } } } },
  } }, run: input => call('/local-choices/choose', input) }];
export const explicitChoiceAnnotations = { choose_local_choice: { title: 'Choose with your local model', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } };
