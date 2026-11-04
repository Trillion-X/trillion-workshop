// tools/use-trillion-from-a-shell/do-work/ag-ui-agent.mjs
//
// Moved from Trillion-X/trillion ./ag-ui-agent.mjs; the files it installs beside itself are this folder's.
//
// PURPOSE
//   Any AG-UI agent as one of the person's AIs. An AG-UI agent is an address that answers a RunAgentInput with AG-UI
//   events (LangGraph, Mastra, CrewAI, the Claude Agent SDK, Pydantic AI, or one written by hand; https://docs.ag-ui.com).
//   `trillion serve --ag-ui URL` takes each job handed to this AI and runs the agent at URL on it (runOnAgUi):
//   the job and its steers are the run's user messages, and the Trillion tools named in trillion.json `ag_ui.tools`
//   are offered as AG-UI frontend tools. Each call the agent makes of one is made here, as this AI, with the same
//   tools/call every connected AI makes, so the call is checked like any other and kept on the activity record.
//   What the agent says is the result; an AG-UI interrupt is what is in the way; a run that fails gives the job back.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The agent never holds the account's key: it asks for a tool and this program runs it.
//   2. Only an offered tool runs. A call of any other tool is answered with ag_ui.words.not_offered and never run.
//   3. Bounded: at most ag_ui.max_turns runs of the agent per job (each pending tool call answered starts the next
//      run), each run at most ag_ui.run_seconds, silent at most ag_ui.quiet_seconds while it is waited on (a tool run here
//      is not the agent's silence), and the frames read through ./ag-ui-wire.mjs bounds.
//   4. A run's thread is the handoff id, so an agent that keeps threads keeps one per job, and its run ids name the
//      attempt (generation) and turn.
//   5. Every word and bound is DATA (trillion.json `ag_ui`); the agent's address comes from the person's command line.
//   6. This file and the wire module are installed beside trillion.mjs (trillion.json install.files).
//
import { AgUiWireError, argumentsOf, foldRun, sseEvents } from './ag-ui-wire.mjs';

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])));

/** The offered Trillion tools as AG-UI tools ({ name, description, parameters }), from the account's own tool list. */
export async function offeredTools(client, names) {
  const wanted = new Set(names);
  const { tools } = await client.rpc('tools/list', {});
  return (tools ?? []).filter(tool => wanted.has(tool.name)).map(tool => ({ name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema ?? { type: 'object' } }));
}

/** The words a tool's answer is given back to the agent in: its structured answer as JSON, bounded. */
const answerWords = (answer, most) => {
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer ?? null);
  return text.length > most ? `${text.slice(0, most - 1)}…` : text;
};

/** The run's user messages: the job, then each steer kept on it, in order. */
export const jobMessages = handoff => [
  { id: `job:${handoff.handoff_id}`, role: 'user', content: handoff.job },
  ...(handoff.steers ?? []).map((steer, index) => ({ id: `steer:${handoff.handoff_id}:${index}`, role: 'user', content: steer.job })),
];

/** One run of the agent: POST the input, read its events until the run ends or the time is up. */
async function runOnce(url, input, { rules, fetchImpl }) {
  const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(input), signal: AbortSignal.timeout(rules.ag_ui.run_seconds * 1000) });
  if (!response.ok || !response.body) throw new AgUiWireError(fill(rules.ag_ui.words.agent_refused, { status: response.status }));
  const events = [];
  for await (const event of sseEvents(response.body, { maxFrameChars: rules.ag_ui.max_frame_chars, maxEvents: rules.ag_ui.max_events, quietMs: rules.ag_ui.quiet_seconds * 1000 })) events.push(event);
  return foldRun(events);
}

/**
 * Runs the agent at `url` on one taken job until it answers, is stuck or fails.
 * `client` is the trillion command's client (rpc, tool). -> { ok, output, stuck? } as serveOnce reads a run.
 */
export async function runOnAgUi(url, handoff, { client, rules, fetchImpl = fetch }) {
  const tools = await offeredTools(client, rules.ag_ui.tools);
  const offered = new Set(tools.map(tool => tool.name));
  const messages = jobMessages(handoff);
  const context = [{ description: rules.ag_ui.context_description, value: fill(rules.ag_ui.context, { handoff_id: handoff.handoff_id }) }];
  for (let turn = 1; turn <= rules.ag_ui.max_turns; turn += 1) {
    const input = { threadId: handoff.handoff_id, runId: `${handoff.handoff_id}:${handoff.generation ?? 0}:${turn}`, messages, tools, context, state: {}, forwardedProps: {} };
    let run;
    try { run = await runOnce(url, input, { rules, fetchImpl }); }
    catch (error) { return { ok: false, output: fill(rules.ag_ui.words.run_failed, { error: error.message }) }; }
    if (run.error) return { ok: false, output: fill(rules.ag_ui.words.run_failed, { error: run.error }) };
    messages.push(...run.messages);
    if (run.outcome?.type === 'interrupt') {
      const said = run.outcome.interrupts.map(interrupt => interrupt.message ?? interrupt.reason).filter(Boolean).join(' ');
      return { ok: true, stuck: said || rules.ag_ui.words.interrupted, output: said };
    }
    if (run.outcome?.type === 'cancelled') return { ok: false, output: rules.ag_ui.words.cancelled };
    if (!run.pending.length) return { ok: true, output: run.text || (typeof run.result === 'string' ? run.result : rules.ag_ui.words.no_words) };
    for (const call of run.pending) {
      let content;
      if (!offered.has(call.name)) content = fill(rules.ag_ui.words.not_offered, { tool: call.name });
      else {
        try { content = answerWords(await client.tool(call.name, argumentsOf(call), { idempotent: false }), rules.ag_ui.answer_chars); }
        catch (error) { content = fill(rules.ag_ui.words.tool_failed, { tool: call.name, error: error.message }); }
      }
      messages.push({ id: `${call.id}:result`, role: 'tool', toolCallId: call.id, content });
    }
  }
  return { ok: false, output: fill(rules.ag_ui.words.too_many_turns, { turns: rules.ag_ui.max_turns }) };
}
