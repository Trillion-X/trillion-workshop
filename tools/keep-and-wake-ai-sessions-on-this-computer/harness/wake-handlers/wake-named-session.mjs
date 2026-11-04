// harness/wake-handlers/wake-named-session.mjs
//
// Purpose
//   A handler for harness/wake-sessions.mjs: starts one exact AI session this computer hosts on something sent to it,
//   through that AI's own documented resume command (wake-sessions.json `harnesses`), and carries the session's reply
//   back into the same conversation through harness/record-every-message.mjs (drainTranscript), the one owner that records a session's
//   transcript (it keeps each message with its original time, so a reply its own hooks already kept is never kept twice).
//
// Non-negotiable invariants
//   1. It takes only the event types listed in wake-sessions.json `wake_on`, and only for a session this computer hosts.
//   2. A handoff explicitly addressed to this session wakes it even when the person's message came from that session.
//      The handoff has one owner and stable identity; skipping it loses work when the original turn failed.
//   3. The words the session reads are DATA (wake-sessions.json `message`, `handoff_message`), wrapped in a tag
//      record-every-message.json lists as injected text, so the wrapper is never recorded as the person speaking.
//   4. The reply file lives in a folder this handler makes and deletes.
//   5. A harness row with a `stream` runs the CLI with its own event stream; the events become the session's live
//      progress card (harness/session-runs.mjs), and the tools the person allowed in the session's folder ride the CLI's
//      own allow-list flag. Nothing turns permission prompts off.
//
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drainTranscript, transcriptFor } from '../record-every-message.mjs';
import { eventsOfLine, lineSplitter, progressKeeper, progressPath, runArgv, workspaceTools } from '../session-runs.mjs';

const trillionBridge = fileURLToPath(new URL('../keychain-mcp-bridge.mjs', import.meta.url));

// A message for the session, or work handed to it by name (work for no one in particular is told to every agent and
// left to the taker).
export const wants = ({ event, hosted, rules }) => Boolean(hosted) && rules.wake_on.includes(event.type)
  && (Boolean(event.refs?.message_id) || event.refs?.handed_to === hosted.agent_id);

// What the session reads, or null when there is nothing for it to do.
async function wordsFor({ event, hosted, rules, call, read, fill }) {
  if (event.refs?.message_id) {
    const conversation_id = event.next_call?.arguments?.conversation_id ?? hosted.source_id;
    const found = await read(`/messages?${new URLSearchParams({ app: hosted.app, conversation_id, limit: '50' })}`);
    const message = (found.messages ?? []).find(item => item.id === event.refs.message_id);
    if (!message) throw new Error(`Message ${event.refs.message_id} is not in ${conversation_id}.`);
    if (message.speaker !== 'person') throw new Error(`Message ${message.id} is not from the person.`);
    const caseId = (message.about ?? []).find(link => link.kind === 'decision')?.id;
    if (!caseId) throw new Error(`Message ${message.id} has no linked decision yet.`);
    return { text: fill(rules.message, { message_id: message.id, case_id: caseId, text: message.text }) };
  }
  if (event.refs?.handoff_id) {
    const { handoff } = await call('/handoffs/read', { handoff_id: event.refs.handoff_id });
    if (!handoff) throw new Error(`Handoff ${event.refs.handoff_id} could not be read.`);
    if (handoff.to_agent !== hosted.agent_id) return { skipped: 'it is not handed to this session' };
    if (handoff.state !== 'open') return { skipped: `it is already ${handoff.state}` };
    return { text: fill(rules.handoff_message, { handoff_id: handoff.handoff_id, agent_id: hosted.agent_id, job: handoff.job }), handoff_id: handoff.handoff_id };
  }
  return { skipped: 'the event names no message or work' };
}

export async function handle(context) {
  const { event, hosted, rules, run, fillArgv, workFolder, log } = context;
  const harness = rules.harnesses[hosted.harness];
  if (!harness) throw new Error(`No harness ${hosted.harness} in wake-sessions.json.`);
  const words = await wordsFor(context);
  if (words.skipped) return words;
  const folder = workFolder('wake');
  try {
    const reply_file = join(folder, 'reply.txt');
    const woken_at = new Date().toISOString();
    log({ event_id: event.event_id, waking: hosted.agent_id, woken_at });
    const mcp_config = JSON.stringify({ mcpServers: { trillion: { command: process.execPath, args: [trillionBridge] } } });
    const tools = hosted.cwd ? workspaceTools(rules, hosted.cwd) : null;
    const command = runArgv(harness, fillArgv(harness.resume, { session_id: hosted.session_id, message: words.text, reply_file, mcp_config }), { tools });
    // A streamed run's events are normalised as they arrive and kept as the live progress card for this session.
    const progress = command.streamed ? progressKeeper({ path: progressPath(rules, hosted.agent_id), app: hosted.app, stream: harness.stream }) : null;
    const lines = progress ? lineSplitter(line => { for (const item of eventsOfLine(harness.stream, line)) progress.event(item); }) : null;
    const ran = await run(command.argv, { cwd: hosted.cwd ?? undefined, timeout_ms: rules.wake_timeout_seconds * 1000, ...(lines ? { on_output: chunk => lines.push(chunk) } : {}) });
    lines?.end();
    progress?.end(ran.code === 0 ? 'finished' : 'failed');
    if (ran.code !== 0) throw new Error(`${hosted.app} exited ${ran.code}: ${[ran.stderr, progress?.reply ?? ran.stdout].filter(Boolean).join('\n').trim().slice(-500)}`);
    const reply = harness.reply === 'reply_file' ? (() => { try { return readFileSync(reply_file, 'utf8'); } catch { return ''; } })() : progress ? progress.reply ?? '' : ran.stdout;
    const replied_at = new Date().toISOString();
    // The recorder's own drain keeps sending until everything new in the transcript is kept (a busy service is tried
    // again), so the reply reaches the conversation even while Trillion is slow to answer.
    const transcript_path = transcriptFor(hosted.session_id);
    const recorded = transcript_path ? await drainTranscript({ transcript_path, session_id: hosted.session_id }) : { drained: 0, reason: 'no transcript' };
    if (words.handoff_id) {
      const { handoff } = await context.call('/handoffs/read', { handoff_id: words.handoff_id });
      if (!handoff || !['taken', 'finished'].includes(handoff.state) || handoff.taken_by !== hosted.agent_id)
        throw new Error(`${hosted.app} returned without taking handoff ${words.handoff_id} as ${hosted.agent_id}.`);
    }
    return { woken_at, replied_at, reply_characters: reply.trim().length, streamed: command.streamed, tools_applied: command.tools_applied, recorded: recorded.drained ?? 0, ...(recorded.reason ? { recording: recorded.reason } : {}), conversation_id: hosted.source_id };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
