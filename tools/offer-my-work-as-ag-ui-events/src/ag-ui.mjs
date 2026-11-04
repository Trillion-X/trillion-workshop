// src/ag-ui.mjs
//
// PURPOSE
//   The person's work in Trillion, offered as AG-UI, the agent-to-UI event protocol (https://docs.ag-ui.com; the wire
//   contract is @ag-ui/core 1.0.3): any AG-UI client (CopilotKit, the AG-UI client library, a phone app) renders one of
//   the person's AIs doing a job, and its person answers what is in the way. A run is one handoff (src/agents.mjs) and
//   the calls kept for it (src/activity.mjs). This file only translates them: it reads the run the person's own job
//   screen reads (src/ag-ui.json `run_path`: the job, its parts, every call kept for them and who made them) and writes
//   with the MCP tool every AI hands and steers work with (`tools.hand`), both with the client's own sign-in on the
//   same road (src/worker.mjs answers `path`), so a run is never a second stream or a second record.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is kept between requests. A thread's job is the handoff its first user message handed off (request_key
//      `${request_key_prefix}:${threadId}:${message id}`, so the same message never hands work twice), or the job the
//      thread names (forwardedProps.handoff_id, or a thread id that is a handoff id).
//   2. A later user message is a steer of the thread's job while it runs (hand_off steer_handoff_id), and a new job
//      handed on from it (parent_handoff_id) once it is over: words for a job reach whoever holds it, never a second job.
//   3. Every event is derived from the handoff and its kept calls, and each id from what it shows (`step:<seq>` for a
//      kept call, `result:<handoff>` for the result, the attempt's own id for a step), so reading again never sends one
//      twice in a run, and what the client already holds in its messages is not sent again in the next run.
//   4. What is in the way ends the run as an AG-UI interrupt whose id names the job and when it was said. Its answer
//      (resume) is a steer of that job under a request_key made from the interrupt id, so the same answer is kept once
//      and an answered interrupt never ends a later run again.
//   5. Every bound and every word is DATA (src/ag-ui.json). The protocol's own event names are its constants, not ours.
//   6. A run that watched for watch_seconds ends with RUN_ERROR `watch_ended`: the job keeps going and the client runs
//      the thread again to keep watching. A finished job ends the run with its result; a withdrawn one as cancelled.
//
import settings from './ag-ui.json' with { type: 'json' };
import { handoffIdFor } from '../../shared-code/src/agents.mjs';
import { sseFrame } from '../harness/ag-ui-wire.mjs';

export const AG_UI = settings;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fill = (words, values) => words.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const clipped = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

export class AgUiInputError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function idText(value, name, rules) {
  if (typeof value !== 'string' || !value.trim() || value.length > rules.max_id_chars) throw new AgUiInputError(`${name} is text of 1 to ${rules.max_id_chars} characters.`);
  return value;
}

/** The text of a message's content: a string, or the text parts of a content list. */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(part => object(part) && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
  return '';
}

/** A RunAgentInput, checked and bounded: { threadId, runId, messages, resume, handoffId, toAgent }. */
export function runInput(body, rules = settings) {
  if (!object(body)) throw new AgUiInputError('Send a RunAgentInput object.');
  const threadId = idText(body.threadId, 'threadId', rules);
  const runId = idText(body.runId, 'runId', rules);
  const messages = body.messages ?? [];
  if (!Array.isArray(messages) || messages.length > rules.max_messages) throw new AgUiInputError(`messages is a list of at most ${rules.max_messages} messages.`);
  const kept = messages.map(message => {
    if (!object(message) || typeof message.role !== 'string') throw new AgUiInputError('Each message is an object with a role.');
    const text = contentText(message.content);
    if (text.length > rules.max_message_chars) throw new AgUiInputError(`A message is at most ${rules.max_message_chars} characters.`);
    return { ...message, text };
  });
  const resume = body.resume ?? [];
  if (!Array.isArray(resume) || resume.length > rules.max_resume) throw new AgUiInputError(`resume is a list of at most ${rules.max_resume} answers.`);
  for (const entry of resume) {
    if (!object(entry) || typeof entry.interruptId !== 'string' || !['resolved', 'cancelled'].includes(entry.status)) throw new AgUiInputError('Each resume entry has an interruptId and a status of resolved or cancelled.');
  }
  const props = object(body.forwardedProps) ? body.forwardedProps : {};
  const handoffId = props.handoff_id === undefined ? null : idText(props.handoff_id, 'forwardedProps.handoff_id', rules);
  const toAgent = props.to_agent === undefined ? null : idText(props.to_agent, 'forwardedProps.to_agent', rules);
  return { threadId, runId, messages: kept, resume, handoffId, toAgent };
}

/** Every id the client already holds: its messages, their tool calls and the tool calls their results answer. */
export function heldIds(messages) {
  const ids = new Set();
  for (const message of messages) {
    if (typeof message.id === 'string') ids.add(message.id);
    if (typeof message.toolCallId === 'string') ids.add(message.toolCallId);
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) if (object(call) && typeof call.id === 'string') ids.add(call.id);
  }
  return ids;
}

/** The interrupt id for what is in the way of one job, said at one time. Ids and ISO times hold no `/`. */
export const interruptIdOf = job => `in-the-way/${job.handoff_id}/${job.in_the_way_at}`;
/** The job an interrupt id names, or null when it is not one of ours. */
export function jobOfInterrupt(id) {
  const [kind, handoff_id, said_at] = String(id).split('/');
  return kind === 'in-the-way' && handoff_id && said_at ? handoff_id : null;
}
export const resumeKeyOf = (interruptId, rules = settings) => `${rules.request_key_prefix}:resume:${interruptId}`;
export const messageKeyOf = (threadId, messageId, rules = settings) => `${rules.request_key_prefix}:${threadId}:${messageId}`;

/** The words of an answer: a string payload as it is, any other JSON value as JSON. */
export function answerText(payload, rules = settings) {
  const text = typeof payload === 'string' ? payload : payload === undefined || payload === null ? '' : JSON.stringify(payload);
  return clipped(text.trim(), rules.max_message_chars);
}

/** The AG-UI state of a job: what a client draws beside the run. Its parts are subagents of the run (eventsOf). */
export function stateOf(job, progress = null) {
  return {
    job: { handoff_id: job.handoff_id, status: job.status, said: job.said ?? null, to_agent: job.to_agent ?? null, taken_by: job.taken_by ?? null,
      in_the_way: job.in_the_way ?? null, in_the_way_by: job.in_the_way_by ?? null, handed_at: job.handed_at ?? null, finished_at: job.finished_at ?? null,
      revision: job.revision ?? 0, steers: (job.steers ?? []).length },
    progress: progress ?? null,
  };
}

/** The name the run's own read gives an actor, or the DATA word for whoever it is. */
export const nameOf = (actors, id, rules = settings) => (actors ?? []).find(actor => actor.id === id)?.name ?? rules.words.someone;

// The words of a result: its summary and a text result. A structured result rides on RUN_FINISHED.result for the
// client's code, never as text a person reads.
const resultText = (job, rules) => {
  const text = [job.summary, typeof job.result === 'string' ? job.result : null].filter(part => typeof part === 'string' && part.trim()).join('\n\n');
  return clipped(text || rules.words.finished_without_words, rules.max_message_chars);
};

const stepEvents = (row, rules, subagentRunId = null) => {
  const id = `step:${row.seq}`;
  const by = subagentRunId ? { subagentRunId } : {};
  const args = JSON.stringify({ ...(row.title ? { title: row.title } : {}), ...(row.item ? { item: row.item } : {}) });
  const said = row.ok ? [row.label, row.title].filter(Boolean).join(': ') : fill(rules.words.step_failed, { why: row.reason ?? row.label });
  return [
    { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: row.tool, ...by },
    { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: args, ...by },
    { type: 'TOOL_CALL_END', toolCallId: id, ...by },
    { type: 'TOOL_CALL_RESULT', messageId: `${id}:result`, toolCallId: id, content: said || row.tool, role: 'tool', ...by },
  ];
};

/**
 * The events one read of a job adds, and how the run ends when the job says so. `sent` holds the keys of everything
 * sent in this run and is filled here; `held` the ids the client already holds; `answered` the interrupt ids answered.
 * Each part handed on from the job is a subagent of the run (its handoff id is the subagentRunId), opened when it is
 * first read and finished when it is; a kept call is the part's when the part is its item and it is not the hand_off
 * that made the part. -> { events, end } where end is null (keep watching) or the terminal events.
 */
export function eventsOf({ job, parts = [], progress = null, steps = [], actors = [], sent, held = new Set(), answered = new Set(), threadId, runId }, rules = settings) {
  const events = [];
  const state = JSON.stringify(stateOf(job, progress));
  if (sent.get('state') !== state) { sent.set('state', state); events.push({ type: 'STATE_SNAPSHOT', snapshot: JSON.parse(state) }); }
  const attempts = job.attempts ?? [];
  for (const attempt of attempts) {
    if (!sent.has(`start:${attempt.attempt_id}`)) { sent.set(`start:${attempt.attempt_id}`, true); events.push({ type: 'STEP_STARTED', stepName: attempt.attempt_id }); }
  }
  const partIds = new Set(parts.map(part => part.handoff_id));
  const open = id => sent.has(`part:${id}`) && !sent.has(`part-end:${id}`);
  for (const part of parts) {
    if (sent.has(`part:${part.handoff_id}`)) continue;
    sent.set(`part:${part.handoff_id}`, true);
    const parent = part.parent_handoff_id && partIds.has(part.parent_handoff_id) && open(part.parent_handoff_id) ? { parentSubagentRunId: part.parent_handoff_id } : {};
    events.push({ type: 'SUBAGENT_STARTED', subagentRunId: part.handoff_id, name: clipped(part.said ?? part.job ?? part.handoff_id, 300), ...parent });
  }
  for (const row of [...steps].sort((a, b) => a.seq - b.seq)) {
    const key = `step:${row.seq}`;
    if (sent.has(key) || held.has(key)) continue;
    sent.set(key, true);
    const part = partIds.has(row.item) && row.tool !== rules.tools.hand && open(row.item) ? row.item : null;
    events.push(...stepEvents(row, rules, part));
  }
  for (const part of [...parts].reverse()) {
    if (!open(part.handoff_id)) continue;
    if (part.status === 'withdrawn') { sent.set(`part-end:${part.handoff_id}`, true); events.push({ type: 'SUBAGENT_ERROR', subagentRunId: part.handoff_id, message: fill(rules.words.withdrawn, { why: part.withdrawal?.reason ?? '' }) }); }
    else if (part.state === 'finished') { sent.set(`part-end:${part.handoff_id}`, true); events.push({ type: 'SUBAGENT_FINISHED', subagentRunId: part.handoff_id, result: part.summary ?? null, outcome: { type: 'success' } }); }
  }
  for (const attempt of attempts) {
    if (attempt.ended_at && !sent.has(`end:${attempt.attempt_id}`)) { sent.set(`end:${attempt.attempt_id}`, true); events.push({ type: 'STEP_FINISHED', stepName: attempt.attempt_id }); }
  }
  const end = terminal => (terminal ? { events, end: [...closing(sent, attempts, parts), ...terminal] } : { events, end: null });
  if (job.status === 'withdrawn') return end([{ type: 'RUN_FINISHED', threadId, runId, result: { said: fill(rules.words.withdrawn, { why: job.withdrawal?.reason ?? '' }) }, outcome: { type: 'cancelled' } }]);
  if (job.state === 'finished') {
    const messageId = `result:${job.handoff_id}`;
    const said = held.has(messageId) ? [] : [
      { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: resultText(job, rules) },
      { type: 'TEXT_MESSAGE_END', messageId },
    ];
    return end([...said, { type: 'RUN_FINISHED', threadId, runId, result: job.result ?? null, outcome: { type: 'success' } }]);
  }
  if (job.in_the_way && job.in_the_way_at && !answered.has(interruptIdOf(job))) {
    const interrupt = { id: interruptIdOf(job), reason: 'in_the_way', message: fill(rules.words.in_the_way, { by: nameOf(actors, job.in_the_way_by, rules), why: job.in_the_way }),
      metadata: { handoff_id: job.handoff_id, said_at: job.in_the_way_at } };
    return end([{ type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'interrupt', interrupts: [interrupt] } }]);
  }
  return end(null);
}

/** What a run that ends now must close first: each part still open (it goes on after the run: suspended), newest
 *  first, and each attempt still running. */
export function closing(sent, attempts, parts) {
  const events = [];
  for (const part of [...parts].reverse()) {
    if (!sent.has(`part:${part.handoff_id}`) || sent.has(`part-end:${part.handoff_id}`)) continue;
    sent.set(`part-end:${part.handoff_id}`, true);
    events.push({ type: 'SUBAGENT_FINISHED', subagentRunId: part.handoff_id, outcome: { type: 'suspended' } });
  }
  for (const attempt of attempts) {
    if (!sent.has(`start:${attempt.attempt_id}`) || sent.has(`end:${attempt.attempt_id}`)) continue;
    sent.set(`end:${attempt.attempt_id}`, true);
    events.push({ type: 'STEP_FINISHED', stepName: attempt.attempt_id });
  }
  return events;
}

/** The interrupts of a job its steers already answer (each answer is a steer under resumeKeyOf its interrupt id). */
export const answeredOf = (job, rules = settings) => new Set((job.steers ?? []).map(steer => steer.request_key)
  .filter(key => typeof key === 'string' && key.startsWith(`${rules.request_key_prefix}:resume:`)).map(key => key.slice(`${rules.request_key_prefix}:resume:`.length)));

/** The run of one job, as the person's job screen reads it, or null when this account has no such job. */
export const runOf = (read, handoffId, rules = settings) => read(`${rules.run_path}?handoff=${encodeURIComponent(handoffId)}`);

/**
 * Start what the input asks for and name the job the run watches. `tool(name, args)` calls one MCP tool with the
 * client's sign-in and returns its structured answer, or throws its error; `read(path)` reads the account road and
 * returns its answer, or null when it names nothing.
 * -> { handoffId, answered: Set of interrupt ids this input answered, attach: true when the client did not hand the job }
 */
export async function startRun(input, { tool, read }, rules = settings) {
  const answered = new Set();
  for (const entry of input.resume) {
    const handoff_id = jobOfInterrupt(entry.interruptId);
    if (!handoff_id) throw new AgUiInputError(`${entry.interruptId} is not an interrupt this service sent.`);
    answered.add(entry.interruptId);
    if (entry.status !== 'resolved') continue;
    await tool(rules.tools.hand, { steer_handoff_id: handoff_id, request_key: resumeKeyOf(entry.interruptId, rules), job: answerText(entry.payload, rules) || rules.words.finished_without_words });
  }
  const answeredJob = input.resume.map(entry => jobOfInterrupt(entry.interruptId)).find(Boolean) ?? null;
  const named = input.handoffId ?? (await runOf(read, input.threadId, rules).catch(() => null))?.jobs?.[0]?.handoff_id ?? null;
  if (answeredJob) return { handoffId: answeredJob, answered, attach: Boolean(named) };
  const users = input.messages.filter(message => message.role === 'user' && typeof message.id === 'string' && message.text.trim());
  const newest = users[users.length - 1];
  const root = named ?? (users.length ? handoffIdFor(messageKeyOf(input.threadId, users[0].id, rules)) : null);
  if (!root) throw new AgUiInputError(rules.words.no_message);
  // The thread's first message hands the job; when the thread names a job, every message is about that job.
  if (!named && newest === users[0]) {
    const handed = await tool(rules.tools.hand, { job: newest.text, said: clipped(newest.text, 300), request_key: messageKeyOf(input.threadId, newest.id, rules), ...(input.toAgent ? { to_agent: input.toAgent } : {}) });
    return { handoffId: handed.handoff.handoff_id, answered, attach: false };
  }
  if (!newest) return { handoffId: root, answered, attach: Boolean(named) };
  const current = (await runOf(read, root, rules))?.jobs?.[0];
  if (!current) throw new AgUiInputError(rules.words.no_job);
  const key = messageKeyOf(input.threadId, newest.id, rules);
  // A message the job already holds (its own words, or a steer kept under this key) is not said again.
  if (current.job === newest.text || (current.steers ?? []).some(steer => steer.request_key === key)) return { handoffId: root, answered, attach: Boolean(named) };
  if (current.state !== 'finished' && !current.withdrawal) {
    await tool(rules.tools.hand, { steer_handoff_id: root, request_key: key, job: newest.text });
    return { handoffId: root, answered, attach: Boolean(named) };
  }
  const handed = await tool(rules.tools.hand, { job: newest.text, said: clipped(newest.text, 300), request_key: key, parent_handoff_id: root, ...(input.toAgent ? { to_agent: input.toAgent } : {}) });
  return { handoffId: handed.handoff.handoff_id, answered, attach: false };
}

/**
 * One run, as AG-UI events: RUN_STARTED, then what each read of the job adds, until the job ends the run, the watch
 * ends or `signal` aborts. `wait(ms)` waits; `now()` is milliseconds.
 */
export async function* watchRun(input, { tool, read, wait, now = () => Date.now(), signal = null }, rules = settings) {
  const { threadId, runId } = input;
  yield { type: 'RUN_STARTED', threadId, runId, protocolVersion: rules.protocol_version };
  let started;
  try { started = await startRun(input, { tool, read }, rules); }
  catch (error) { yield { type: 'RUN_ERROR', message: fill(rules.words.read_failed, { why: error.message }), code: error instanceof AgUiInputError ? 'input' : 'start_failed' }; return; }
  const held = heldIds(input.messages);
  const sent = new Map();
  const until = now() + rules.watch_seconds * 1000;
  let pause = rules.read_ms;
  let first = true;
  while (!signal?.aborted) {
    let run;
    try { run = await runOf(read, started.handoffId, rules); }
    catch (error) { yield { type: 'RUN_ERROR', message: fill(rules.words.read_failed, { why: error.message }), code: 'read_failed' }; return; }
    const job = run?.jobs?.find(row => row.handoff_id === started.handoffId);
    if (!job) { yield { type: 'RUN_ERROR', message: rules.words.no_job, code: 'no_job' }; return; }
    if (first && started.attach && !held.has(`job:${job.handoff_id}`)) {
      const messageId = `job:${job.handoff_id}`;
      yield { type: 'TEXT_MESSAGE_START', messageId, role: 'user' };
      yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: clipped(job.job, rules.max_message_chars) };
      yield { type: 'TEXT_MESSAGE_END', messageId };
    }
    first = false;
    const answered = new Set([...started.answered, ...answeredOf(job, rules)]);
    const parts = run.jobs.filter(row => row.handoff_id !== job.handoff_id);
    const { events, end } = eventsOf({ job, parts, progress: run.progress ?? null, steps: run.steps ?? [], actors: run.actors ?? [], sent, held, answered, threadId, runId }, rules);
    for (const event of events) yield event;
    if (end) { for (const event of end) yield event; return; }
    if (now() >= until) {
      for (const event of closing(sent, job.attempts ?? [], parts)) yield event;
      yield { type: 'RUN_ERROR', message: rules.words.watch_ended, code: 'watch_ended' };
      return;
    }
    pause = events.length ? rules.read_ms : Math.min(rules.read_most_ms, Math.round(pause * rules.slower));
    await wait(Math.min(pause, Math.max(0, until - now())));
  }
}

/** A streamed Response of these events; a comment line keeps a quiet stream open every `keep_alive_ms`, and the run
 *  stops when the client goes away. */
export function eventStream(run, controller, rules = settings) {
  const encoder = new TextEncoder();
  let next = null;
  const body = new ReadableStream({
    async pull(stream) {
      next ??= run.next();
      let timer;
      const quiet = new Promise(done => { timer = setTimeout(() => done(null), rules.keep_alive_ms); });
      try {
        const step = await Promise.race([next, quiet]);
        if (step === null) { stream.enqueue(encoder.encode(': keep\n\n')); return; }
        next = null;
        if (step.done) stream.close();
        else stream.enqueue(encoder.encode(sseFrame(step.value)));
      } catch (error) {
        stream.enqueue(encoder.encode(sseFrame({ type: 'RUN_ERROR', message: String(error?.message ?? error), code: 'failed' })));
        stream.close();
      } finally { clearTimeout(timer); }
    },
    cancel() { controller?.abort(); void run.return(undefined); },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } });
}
