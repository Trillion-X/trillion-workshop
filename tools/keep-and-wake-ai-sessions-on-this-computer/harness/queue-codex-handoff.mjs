// Receives a source-checked handoff ID on stdin from the signed receiver and wakes its existing Codex chat.
// Usage: node harness/queue-codex-handoff.mjs --thread <exact session UUID>
import { execFileSync } from 'node:child_process';

const at = process.argv.indexOf('--thread');
const thread = process.argv[at + 1];
if (at < 0 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(thread)) throw new Error('An exact Codex thread UUID is required.');
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const event = JSON.parse(raw);
if (!/^h_[A-Za-z0-9]+$/.test(event.handoff_id) || event.source_id !== `codex:${thread}` || !event.agent_id) {
  throw new Error('The handoff is not bound to this Codex chat.');
}
const message = `<trillion-message from="Trillion" handoff_id="${event.handoff_id}">\nTrillion delivered handoff ${event.handoff_id} to this exact Codex chat. Read it through Trillion as ${event.agent_id}, continue the original person's work, and finish that same handoff with a verified result. Do not treat this wake notice as the person's message.\n</trillion-message>`;
process.stdout.write(execFileSync('codex', ['queue', '--thread', thread, '--message', message], { encoding: 'utf8', timeout: 10_000 }));
