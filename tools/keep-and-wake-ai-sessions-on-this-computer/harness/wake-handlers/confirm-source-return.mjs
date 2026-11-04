// Confirms a result only after this computer sees the matching final answer in
// the exact chat session that supplied the original message.
import { signDelivery } from '../../src/agent-delivery.mjs';
import { harnessById } from '../../src/harnesses.mjs';
import { fileURLToPath } from 'node:url';

export const wants = ({ event, hosted }) => Boolean(hosted) && event.type === 'source.return.check'
  && event.to_agent === hosted.agent_id && event.refs?.handoff_id === event.subject_id
  && typeof event.refs?.transcript_message_id === 'string';

export async function handle({ event, hosted, call, run, sourceSecret, key, origin }) {
  if (!sourceSecret) throw new Error('This source session has no current delivery secret.');
  const { handoff } = await call('/handoffs/read', { handoff_id: event.subject_id });
  if (handoff?.input?.arrived?.source_id !== hosted.source_id
    || (handoff.to_agent !== hosted.agent_id && hosted.agent_id !== `session-${hosted.source_id.replace(':', '-')}`))
    throw new Error('The handoff is not addressed to this originating chat.');
  if (harnessById(hosted.harness)?.source_return !== 'transcript') throw new Error('No transcript verifier is configured for this chat type.');
  const checked = await run([process.execPath, fileURLToPath(new URL('../verify-source-return.mjs', import.meta.url)),
    '--harness', hosted.harness, '--session', hosted.session_id], { stdin: JSON.stringify({ handoff, transcript_message_id: event.refs.transcript_message_id }) });
  if (checked.code !== 0) throw new Error((checked.stderr || checked.stdout || 'The source transcript check failed.').slice(-500));
  const proof = JSON.parse(checked.stdout.trim().split('\n').at(-1));
  const body = JSON.stringify({ handoff_id: handoff.handoff_id, agent_id: hosted.agent_id,
    source_id: hosted.source_id, message_id: proof.message_id, transcript_message_id: proof.transcript_message_id });
  const response = await fetch(`${origin}/mcp/api/handoffs/confirm-source-return`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`,
      'trillion-source-signature': signDelivery(sourceSecret, body) }, body });
  const result = await response.json();
  if (!response.ok || !result.handoff?.source_return?.verified)
    throw new Error(result.error ?? `Source return confirmation returned ${response.status}.`);
  return { handoff_id: handoff.handoff_id, message_id: proof.message_id, verified: true };
}
