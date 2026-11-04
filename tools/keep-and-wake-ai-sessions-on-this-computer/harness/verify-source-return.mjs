// Checks one completed final answer against the original chat's own transcript, for any app whose row in
// record-every-message.json has a source_return. The source-bound receiver supplies the handoff and signs the report.
// Usage: node harness/verify-source-return.mjs --harness <row id> --session <exact session UUID>
import { rowsFrom, transcriptFor, wordsOf, meets, at, settings } from './record-every-message.mjs';
import { messageIdOf } from '../src/messages.mjs';
import { SESSION_ID } from '../src/harnesses.mjs';

const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const id = flag('--harness');
const session = flag('--session');
const hook = settings.harnesses.find(row => row.id === id && row.source_return);
if (!hook) throw new Error(`No transcript verifier is configured for ${id}.`);
if (!new RegExp(`^${SESSION_ID}$`).test(session)) throw new Error(`An exact ${hook.app} session UUID is required.`);
const { when, id_path: idPath, text: words } = hook.source_return;
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const { handoff, transcript_message_id: transcriptId } = JSON.parse(raw);
const source = `${id}:${session}`;
if (handoff?.state !== 'finished' || handoff?.input?.arrived?.source_id !== source || !/^h_[A-Za-z0-9]+$/.test(handoff.handoff_id))
  throw new Error(`This finished handoff does not belong to the original ${hook.app} chat.`);
const outcome = typeof handoff.result === 'string' ? handoff.result
  : ['completed', 'done'].includes(handoff.result?.state) ? handoff.result.outcome : null;
if (typeof outcome !== 'string' || !outcome.trim()) throw new Error('A completed, concrete work outcome is required.');
const path = transcriptFor(session, settings);
if (!path) throw new Error(`The original ${hook.app} transcript is unavailable.`);
const rows = rowsFrom(path, 0, settings).rows;
if (!rows.some(row => meets(row, hook.recognized_by) && at(row, hook.session_id_path) === session))
  throw new Error(`The transcript does not belong to this exact ${hook.app} chat.`);
const answer = rows.find(row => meets(row, when) && at(row, idPath) === transcriptId);
if (!answer) throw new Error(`The final answer is not present in this ${hook.app} transcript.`);
const text = wordsOf(at(answer, words.path), { part_types: words.part_types }, settings);
if (!text.includes(handoff.handoff_id) || !text.includes(outcome) || /^\s*<heartbeat>/i.test(text))
  throw new Error('The final answer does not return this handoff and its completed outcome.');
const answeredAt = at(answer, hook.time_path);
if (Date.parse(answeredAt) < Date.parse(handoff.finished_at)) throw new Error('The final answer predates the completed handoff.');
process.stdout.write(`${JSON.stringify({ message_id: messageIdOf({ conversation_id: source, app: hook.app, speaker: 'ai', at: answeredAt, text }), transcript_message_id: transcriptId })}\n`);
