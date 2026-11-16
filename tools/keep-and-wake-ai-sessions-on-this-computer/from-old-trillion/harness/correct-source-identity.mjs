// Correct a source-linked decision after the live account verifies its kept message and handoff.
// Usage: TRILLION_ORIGIN=<Trillion address> node harness/correct-source-identity.mjs <case-id> <message-id> <handoff-id>
import { requireAccountKey } from './account-key.mjs';

const [case_id, message_id, handoff_id] = process.argv.slice(2);
if (!case_id?.startsWith('source:') || !message_id?.startsWith('message:') || !/^h_[A-Za-z0-9]+$/.test(handoff_id ?? ''))
  throw new Error('A case ID, message ID, and handoff ID are required.');
const key = requireAccountKey({ item: 'trillion-agent-work-key', timeout: 2000 });
const origin = String(process.env.TRILLION_ORIGIN ?? '').trim().replace(/\/$/, '');
if (!origin) throw new Error('Set TRILLION_ORIGIN to the Trillion address.');
const response = await fetch(`${origin}/mcp/api/cases/${encodeURIComponent(case_id)}/correct-source-identity`, {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ message_id, handoff_id }), signal: AbortSignal.timeout(12000),
});
const answer = await response.json();
process.stdout.write(`${JSON.stringify({ status: response.status, answer })}\n`);
if (!response.ok) process.exitCode = 1;
