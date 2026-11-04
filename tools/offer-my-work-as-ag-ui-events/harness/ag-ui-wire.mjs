// harness/ag-ui-wire.mjs
//
// PURPOSE
//   AG-UI's wire, both ways, for every part of Trillion that speaks it (the agent-to-UI event protocol,
//   https://docs.ag-ui.com; the contract is @ag-ui/core 1.0.3): src/ag-ui.mjs offers the person's work to any AG-UI
//   client, and harness/ag-ui-agent.mjs runs any AG-UI agent as one of the person's AIs. One place reads and writes
//   the frames and folds a run's events into what it said, the tools it called and how it ended.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No imports: the trillion command installs this file beside itself (harness/trillion.json install.files).
//   2. A frame is `data: <one JSON event>` and a blank line (AG-UI's EventEncoder); a line that is not data (a comment,
//      an id, a retry) is skipped, as the protocol's own parser skips it.
//   3. Reading is bounded: an event longer than `maxFrameChars`, more than `maxEvents` events, or a stream silent for
//      `quietMs` (only time spent waiting on the agent counts) ends the read with an error, never an unbounded wait or buffer.
//   5. A run is held to the protocol's order (as AG-UI's own client verifier holds it): RUN_STARTED first, a message's or
//      tool call's pieces only after its start, nothing after RUN_FINISHED or RUN_ERROR. A run that breaks it is an error,
//      never half a result.
//   4. Folding keeps the protocol's own ids: a tool call is answered by the id the agent gave it, and a message the
//      next run is sent carries the id the agent streamed it under.
//
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One event as a server-sent event frame. */
export const sseFrame = event => `data: ${JSON.stringify({ ...event, timestamp: event.timestamp ?? Date.now() })}\n\n`;

export class AgUiWireError extends Error {}

/** The events of a server-sent event body (a ReadableStream of bytes), in order. */
export async function* sseEvents(body, { maxFrameChars = 1_000_000, maxEvents = 100_000, quietMs = null } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let count = 0;
  const parse = frame => {
    if (frame.length > maxFrameChars) throw new AgUiWireError(`An event longer than ${maxFrameChars} characters was sent.`);
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(line.startsWith('data: ') ? 6 : 5));
    if (!data.length) return null;
    const event = JSON.parse(data.join('\n'));
    if (!object(event) || typeof event.type !== 'string') throw new AgUiWireError('An event without a type was sent.');
    count += 1;
    if (count > maxEvents) throw new AgUiWireError(`More than ${maxEvents} events were sent in one run.`);
    return event;
  };
  try {
    for (;;) {
      let timer;
      const silent = quietMs ? new Promise((_, refuse) => { timer = setTimeout(() => refuse(new AgUiWireError(`The agent sent nothing for ${Math.round(quietMs / 1000)} seconds.`)), quietMs); }) : null;
      const { done, value } = await (silent ? Promise.race([reader.read(), silent]).finally(() => clearTimeout(timer)) : reader.read());
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = done ? '' : frames.pop();
      // A split CRLF event separator may retain up to three characters beside the
      // frame. Bound unfinished frames too, before another read can grow them.
      if (buffer.length > maxFrameChars + 3) throw new AgUiWireError(`An event longer than ${maxFrameChars} characters was sent.`);
      for (const frame of frames) { const event = parse(frame); if (event) yield event; }
      if (done) return;
    }
  } finally { await reader.cancel().catch(() => {}); }
}

/**
 * What one run's events add up to: the messages it streamed (assistant text and tool calls, as the next run's input
 * carries them), the tool calls it left unanswered, its state, and how it ended.
 * -> { messages, text, calls: [{ id, name, args, result? }], pending, state, outcome, result, error }
 */
export function foldRun(events) {
  const texts = new Map();
  const calls = new Map();
  const order = [];
  let state = null;
  let outcome = null;
  let result = null;
  let error = null;
  let finished = false;
  const broke = why => ({ messages: [], text: '', calls: [], pending: [], state: null, outcome: null, result: null, error: why });
  for (const [index, event] of events.entries()) {
    if (index === 0 && event.type !== 'RUN_STARTED') return broke(`The agent's run began with ${event.type}, not RUN_STARTED.`);
    if (finished || (error && index)) return broke(`The agent sent ${event.type} after its run ended.`);
    if ((event.type === 'TEXT_MESSAGE_CONTENT' || event.type === 'TEXT_MESSAGE_END') && !texts.has(event.messageId)) return broke(`The agent sent ${event.type} for a message it never started.`);
    // A result may answer a call of an earlier run (an agent echoes the answer it was given), as AG-UI's verifier allows.
    if ((event.type === 'TOOL_CALL_ARGS' || event.type === 'TOOL_CALL_END') && !calls.has(event.toolCallId)) return broke(`The agent sent ${event.type} for a tool call it never started.`);
    switch (event.type) {
      case 'TEXT_MESSAGE_START': if (!texts.has(event.messageId)) { texts.set(event.messageId, { id: event.messageId, role: event.role ?? 'assistant', text: '' }); order.push(['text', event.messageId]); } break;
      case 'TEXT_MESSAGE_CONTENT': case 'TEXT_MESSAGE_CHUNK': {
        if (!texts.has(event.messageId)) { texts.set(event.messageId, { id: event.messageId, role: event.role ?? 'assistant', text: '' }); order.push(['text', event.messageId]); }
        texts.get(event.messageId).text += event.delta ?? '';
        break;
      }
      case 'TOOL_CALL_START': if (!calls.has(event.toolCallId)) { calls.set(event.toolCallId, { id: event.toolCallId, name: event.toolCallName, args: '', parent: event.parentMessageId ?? null }); order.push(['call', event.toolCallId]); } break;
      case 'TOOL_CALL_ARGS': case 'TOOL_CALL_CHUNK': {
        if (!calls.has(event.toolCallId)) { calls.set(event.toolCallId, { id: event.toolCallId, name: event.toolCallName, args: '', parent: event.parentMessageId ?? null }); order.push(['call', event.toolCallId]); }
        calls.get(event.toolCallId).args += event.delta ?? '';
        break;
      }
      case 'TOOL_CALL_RESULT': if (calls.has(event.toolCallId)) calls.get(event.toolCallId).result = event.content; break;
      case 'STATE_SNAPSHOT': state = event.snapshot ?? null; break;
      case 'RUN_FINISHED': finished = true; outcome = event.outcome ?? { type: 'success' }; result = event.result ?? null; break;
      case 'RUN_ERROR': error = event.message ?? 'The agent ended its run with an error.'; break;
      default: break;
    }
  }
  if (!finished && !error) error = 'The agent ended its run without finishing it.';
  // The next input carries the run as AG-UI messages: an assistant message for each text and the tool calls under it.
  const messages = [];
  const assistantFor = parent => {
    let message = parent ? messages.find(row => row.id === parent) : null;
    if (!message) { message = { id: parent ?? `calls:${messages.length}`, role: 'assistant', content: '', toolCalls: [] }; messages.push(message); }
    message.toolCalls ??= [];
    return message;
  };
  for (const [kind, id] of order) {
    if (kind === 'text') { const row = texts.get(id); if (row.role === 'assistant') messages.push({ id, role: 'assistant', content: row.text }); continue; }
    const call = calls.get(id);
    assistantFor(call.parent).toolCalls.push({ id: call.id, type: 'function', function: { name: call.name, arguments: call.args || '{}' } });
  }
  for (const call of calls.values()) if (call.result !== undefined) messages.push({ id: `${call.id}:result`, role: 'tool', toolCallId: call.id, content: String(call.result) });
  const text = [...texts.values()].filter(row => row.role === 'assistant').map(row => row.text).filter(Boolean).join('\n\n');
  const listed = [...calls.values()].map(({ parent: _parent, ...call }) => call);
  return { messages, text, calls: listed, pending: listed.filter(call => call.result === undefined), state, outcome, result, error };
}

/** A tool call's arguments as an object; text that is not a JSON object is an error the agent is told. */
export function argumentsOf(call) {
  const parsed = JSON.parse(call.args || '{}');
  if (!object(parsed)) throw new AgUiWireError(`${call.name} was called with arguments that are not an object.`);
  return parsed;
}
