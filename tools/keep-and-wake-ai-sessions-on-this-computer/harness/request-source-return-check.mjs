// Detached Codex Stop-hook child: ask the source-bound receiver to inspect an
// accepted final answer. This sends IDs only; the receiver reads the transcript.
import { settings } from './record-every-message.mjs';
import { postWithBusyRetry } from './retry-source-return-request.mjs';
import { completeSourceReturnCandidate, deferSourceReturnCandidate, pendingSourceReturnCandidates } from './source-return-pending.mjs';
import { requireAccountKey } from './account-key.mjs';
const candidates = pendingSourceReturnCandidates();
if (!candidates.length) process.exit(0);
let key;
try { key = requireAccountKey({ item: settings.keychain_item, timeout: 2000 }); } catch { process.exit(0); }
const call = (path, body) => postWithBusyRetry(`${settings.origin}/mcp/api${path}`, body, { key });
const recheckMinutes = settings.source_return_recheck_minutes;
const putOff = candidate => deferSourceReturnCandidate(candidate.file, { recheckMinutes });
for (const candidate of candidates) {
  try {
    const handoff = (await call('/handoffs/read', { handoff_id: candidate.handoff_id }))?.handoff;
    // No such handoff, or already checked: nothing is left to send.
    if (!handoff || handoff.source_return?.verified) { completeSourceReturnCandidate(candidate.file); continue; }
    // Not finished yet: asked again later, never on every Stop.
    if (handoff.state !== 'finished') { putOff(candidate); continue; }
    const outcome = typeof handoff.result === 'string' ? handoff.result : handoff.result?.outcome;
    // A finished handoff that does not match this final answer is asked again only on the same slow schedule (a reopened
    // handoff can be finished again), and dropped after its last check.
    if (handoff.input?.arrived?.source_id !== candidate.source_id || !handoff.to_agent
      || (typeof handoff.result !== 'string' && !['completed', 'done'].includes(handoff.result?.state)) || typeof outcome !== 'string'
      || !outcome.trim() || !candidate.text.includes(outcome)) { putOff(candidate); continue; }
    const sourceAgent = candidate.source_id.startsWith('claude-code:')
      ? `session-claude-code-${candidate.source_id.slice('claude-code:'.length)}` : handoff.to_agent;
    const sent = await call('/agents/events', { type: 'source.return.check', to_agent: sourceAgent,
      idempotency_key: `source-return:${candidate.handoff_id}:${candidate.transcript_message_id}:${candidate.request_id ?? 'initial'}`,
      subject_id: candidate.handoff_id, refs: { handoff_id: candidate.handoff_id,
        transcript_message_id: candidate.transcript_message_id } });
    if (sent) completeSourceReturnCandidate(candidate.file); else putOff(candidate);
  } catch { putOff(candidate); /* Kept on disk until its next check; the account was busy or unreachable. */ }
}
