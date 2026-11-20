// packages/chat/do-work/take-one-part-of-an-answer.ts
//
// PURPOSE
// An answer that is still being written is put on screen as it is written.
// The transport hands over everything it has received so far, this turns those
// bytes into words, and the words become the content of a turn that already
// exists. The screen is already subscribed to that turn, so it repaints.
//
// NON-NEGOTIABLE INVARIANTS
//   - No provider, vendor or model name appears here. WHERE the words sit
//     inside a provider's answer is the participant's DATA, handed in as a
//     path, and this walks it.
//   - Every delivery carries the whole answer so far, so this holds no state
//     between calls, needs nothing kept in order, and a lost or duplicated
//     delivery costs nothing.
//   - A part that cannot be read is not an error. The words arriving early are
//     a courtesy; the real answer is written by the owner that asked for it,
//     and nothing here may put that at risk.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

// The rules for reading an answer that arrives as a run of documents belong to
// the package that knows what an answer looks like. A copy here would be a
// second set of rules for the same bytes, one line apart from the first.
import { textSoFarAt, wordsInTheRun } from '../../../../model-response/read-data/an-answer-arriving-in-documents';

type JsonRecord = Record<string, unknown>;

const decoder = new TextDecoder();

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`${label} is required.`);
}

/** The words in everything received so far, read by the one owner of that
 *  rule. Kept as a named export because the tests for this behaviour belong
 *  beside the thing that puts words on a screen. */
export function wordsSoFar(bytes: Uint8Array, textPath: readonly unknown[]): string {
  return wordsInTheRun(decoder.decode(bytes), textPath);
}

export async function takeOnePartOfAnAnswer(value: unknown) {
  if (!isRecord(value)) throw new Error('answer part input must be an object.');
  const conversationRef = requiredText(value.conversation_ref, 'conversation_ref');
  const turnRef = requiredText(value.turn_ref, 'turn_ref');
  const participantRef = requiredText(value.participant_ref, 'participant_ref');
  const textPath = Array.isArray(value.text_path) ? value.text_path : [];
  const parentTurnRef = typeof value.parent_turn_ref === 'string' ? value.parent_turn_ref : undefined;
  const sequence = typeof value.sequence === 'number' && Number.isFinite(value.sequence) ? value.sequence : 0;

  const answerPath = Array.isArray(value.answer_path) ? value.answer_path : [];
  // The turn's own time, sent by the answer it belongs to. Without it a part
  // would stamp the turn with some other moment and the reader would see the
  // reply jump in the conversation when the finished answer lands.
  const occurredAt = requiredText(value.occurred_at, 'occurred_at');

  const soFar = typeof value.answer_so_far_base64 === 'string' ? value.answer_so_far_base64 : '';
  // The closing delivery carries no bytes: it only says the stream ended.
  if (!soFar) return { wrote: false, reason: value.complete === true ? 'finished' : 'no-bytes' };
  // A delivery that arrives without saying where its words sit was sent by
  // something misconfigured, and saying so is the only way anyone finds out.
  if (textPath.length === 0) throw new Error('answer part arrived without text_path, so its words cannot be found.');
  const joined = wordsSoFar(Buffer.from(soFar, 'base64'), textPath);
  // A structured answer streams as JSON text; the reader sees the reply field.
  const words = answerPath.length > 0 ? textSoFarAt(joined, answerPath) : joined;
  // Nothing readable yet. The first delivery of a long answer is often headers
  // and an opening fragment, and writing an empty turn over a turn that
  // already says something would take words off the screen.
  if (!words) return { wrote: false, reason: 'nothing-readable-yet' };

  await sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: 'action:conversations.append-addressed-exchange-turns',
      include_output: false,
      include_steps: false,
      input: {
        conversation_ref: conversationRef,
        message_page_ref: `message-page:${conversationRef}`,
        message_refs: [turnRef],
        next_cursor_ref: turnRef,
        turn_records: [{
          turn_ref: turnRef,
          conversation_ref: conversationRef,
          author_ref: participantRef,
          speaker_ref: participantRef,
          ...(parentTurnRef ? { parent_turn_ref: parentTurnRef } : {}),
          // The conversation store presents exactly two roles, and a turn
          // written with any other word is stored, counted and never drawn.
          role: 'assistant',
          content: words,
          sequence,
          occurred_at: occurredAt,
          addressed_participant_refs: [participantRef],
        }],
      },
    },
  });
  // Published so the screen sees it. Skipping this leaves an answer that
  // exists, is correct, and is invisible, which reads exactly like no answer.
  await sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: 'action:conversations.publish-addressed-exchange-projections',
      include_output: false,
      include_steps: false,
      input: {},
    },
  });
  return { wrote: true, characters: words.length, complete: value.complete === true };
}
