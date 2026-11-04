// Requeue a final answer already in the exact source transcript after a hook
// or connector failure. The ordinary signed receiver still does every check.
import { rowsFrom, sendToTrillion, transcriptFor, wordsOf, meets, at, settings } from './record-every-message.mjs';
import { SESSION_ID } from '../src/harnesses.mjs';
import { queueSourceReturnCandidates } from './source-return-pending.mjs';
import { requireAccountKey } from './account-key.mjs';

const [sourceId, handoffId] = process.argv.slice(2);
const match = new RegExp(`^([a-z0-9-]+):(${SESSION_ID})$`).exec(sourceId ?? '');
const hook = match && settings.harnesses.find(row => row.id === match[1] && row.source_return);
if (!hook || !/^h_[A-Za-z0-9]+$/.test(handoffId ?? '')) throw new Error('Give an exact source ID and original handoff ID.');
const path = transcriptFor(match[2], settings);
if (!path) throw new Error('The exact source transcript is unavailable.');
const { when, id_path: idPath, text: words } = hook.source_return;
const candidates = rowsFrom(path, 0, settings).rows.flatMap(row => {
  if (!meets(row, when) || typeof at(row, idPath) !== 'string') return [];
  const text = wordsOf(at(row, words.path), { part_types: words.part_types }, settings);
  if (!text.includes(handoffId) || /^\s*<heartbeat>/i.test(text)) return [];
  return [{ source_id: sourceId, handoff_id: handoffId, transcript_message_id: at(row, idPath), text, at: at(row, hook.time_path) }];
});
const last = candidates.at(-1);
if (!last) throw new Error('No final answer in this source chat names the original handoff.');
const key = requireAccountKey({ item: settings.keychain_item, timeout: 2000 });
const recorded = await sendToTrillion([{ conversation_id: sourceId, app: hook.app,
  speaker: 'ai', at: last.at, text: last.text, source_ref: last.transcript_message_id }],
{ rules: settings, deadline: Date.now() + 120000, key });
if (!recorded) throw new Error('Trillion did not accept the source answer with its transcript row ID.');
const { at: _said, ...candidate } = last;
const queued = queueSourceReturnCandidates([candidate]);
process.stdout.write(`${JSON.stringify({ queued, source_id: sourceId, handoff_id: handoffId,
  transcript_message_id: last.transcript_message_id })}\n`);
