// packages/chat/do-work/answer-one-addressed-turn.ts
//
// PURPOSE
// One addressed participant answers one turn, and the answer becomes a turn in
// the same conversation. Chat dispatches here and then re-reads history; if the
// answer were only returned it would never appear, so producing it and
// persisting it are one operation rather than two halves nobody joins.
//
// NON-NEGOTIABLE INVARIANTS
//   - No provider, vendor, model or transport name appears here. Which model
//     answers is the participant's own DATA; this reads it and passes it on.
//   - The participant's declared instructions are what govern the answer. A
//     profile that names instruction blocks gets them; one that names none is
//     answered without inventing a personality for it.
//   - An answer that cannot be written is a failure, not a silent success. The
//     caller refreshes history and would otherwise show nothing with no reason.

import { readTrustedRuntimeClockMs, sendRequestToBitfieldTarget, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';

type JsonRecord = Record<string, unknown>;

const decoder = new TextDecoder();

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`${label} is required.`);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function decodeReply(reply: unknown): unknown {
  if (isRecord(reply) && reply.payload instanceof Uint8Array) {
    const text = decoder.decode(reply.payload);
    return text.trim() ? JSON.parse(text) : {};
  }
  if (isRecord(reply) && typeof reply.payload === 'string') {
    return reply.payload.trim() ? JSON.parse(reply.payload) : {};
  }
  return reply;
}

function foundItems(reply: unknown): JsonRecord[] {
  const decoded = decodeReply(reply);
  if (!isRecord(decoded)) return [];
  const output = isRecord(decoded.output) ? decoded.output : decoded;
  const result = isRecord(output.result) ? output.result : output;
  return Array.isArray(result.items) ? result.items.filter(isRecord) : [];
}

/** A published record is returned either bare or wrapped in `payload`. */
function recordPayload(item: JsonRecord): JsonRecord {
  return isRecord(item.payload) ? item.payload : item;
}

async function runOwnerAction(definitionId: string, input: JsonRecord): Promise<void> {
  await sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: definitionId,
      include_output: false,
      include_steps: false,
      input,
    },
  });
}

async function readPublishedRecordsOfKind(kind: string): Promise<JsonRecord[]> {
  const reply = await sendRequestToBitfieldTarget({
    target: 'slot::find-current-items',
    payload: {
      operation: 'find-current-items',
      in: 'published-record',
      where: { all: [{ field: 'kind', eq: kind }] },
      include: ['address', 'payload'],
    },
  });
  return foundItems(reply).map(recordPayload);
}

/** The profile names its instruction blocks in the order it wants them read.
 * Ordering by the profile, not by whatever order the store returns, is what
 * makes the same profile produce the same instructions every time. */
function instructionTextForProfile(profile: JsonRecord, blocks: readonly JsonRecord[]): string {
  const bodyByRef = new Map<string, string>();
  for (const block of blocks) {
    const id = optionalText(block.id);
    const body = optionalText(block.body);
    if (id && body) bodyByRef.set(id, body);
  }
  return textList(profile.instruction_refs)
    .map((ref) => bodyByRef.get(ref))
    .filter((body): body is string => Boolean(body))
    .join('\n\n');
}

/** Model choice travels with the participant, never with this code. A profile
 * that names its model and adapter gets them; one that names only what it needs
 * the model to be able to do is resolved by the owner that knows what is
 * available. Naming neither is a profile that cannot answer yet, and saying so
 * is better than picking something on its behalf. */
function modelSelection(input: JsonRecord, profile: JsonRecord): JsonRecord {
  const modelId = optionalText(input.model_id);
  const adapterRef = optionalText(input.adapter_ref);
  if (modelId && adapterRef) return { model_id: modelId, adapter_ref: adapterRef };
  const capabilities = textList(input.required_capabilities);
  if (capabilities.length > 0) return { required_capabilities: capabilities };
  throw new Error(
    `Participant ${optionalText(profile.id) ?? 'unknown'} does not say which model should answer.`,
  );
}

const DEFAULT_PROMPT_TEMPLATE = 'Instruction:\n{{instruction_text}}\n\nMessage:\n{{body}}\n\nReply:';

/** Some models are asked for a shaped answer rather than loose text, and the
 * shape belongs to the participant, not to this code. When a participant asks
 * for one it also says where in that shape the words it wants shown are, so a
 * richer answer can grow new parts without anything here learning their names. */
function replyText(answer: JsonRecord, message: JsonRecord, answerPath: readonly string[]): string {
  if (answerPath.length === 0) return requiredText(message.body, 'model response body');
  const structured = isRecord(message.structured_response) ? message.structured_response.value : undefined;
  const found = answerPath.reduce<unknown>(
    (current, key) => (isRecord(current) ? current[key] : undefined),
    structured,
  );
  if (typeof found === 'string' && found.trim()) return found.trim();
  throw new Error(`The model answered without ${answerPath.join('.')}.`);
}

/** A question the participant wants asked, in the shape the form owner reads.
 * The participant's own DATA decides which kind of input each question is; a
 * question that does not say gets the kind the participant named as its usual
 * one, so the model is never asked to know the names of input components. */
function questionForForm(value: unknown, index: number, usualKind: string): JsonRecord {
  const raw = isRecord(value) ? value : { label: value };
  const label = optionalText(raw.label) ?? optionalText(raw.question) ?? optionalText(raw.text);
  if (!label) throw new Error(`question ${index} has nothing to ask.`);
  return {
    questionId: optionalText(raw.questionId) ?? optionalText(raw.id) ?? `question-${index + 1}`,
    questionTypeId: optionalText(raw.questionTypeId) ?? usualKind,
    label,
    ...(optionalText(raw.placeholder) ? { placeholder: optionalText(raw.placeholder) } : {}),
    ...(Array.isArray(raw.options) ? { options: raw.options } : {}),
  };
}

/** When the participant asks for answers rather than only giving them, its
 * questions become the form its surface is already showing. One set of
 * questions is current at a time, so the surface follows the conversation
 * instead of the person hunting for where the asking happened. A participant
 * that does not declare a questions form writes nothing here. */
async function putQuestionsOnScreen(input: JsonRecord, message: JsonRecord): Promise<void> {
  const formId = optionalText(input.questions_form_id);
  const path = textList(input.questions_path);
  if (!formId || path.length === 0) return;
  const structured = isRecord(message.structured_response) ? message.structured_response.value : undefined;
  const found = path.reduce<unknown>(
    (current, key) => (isRecord(current) ? current[key] : undefined),
    structured,
  );
  if (!Array.isArray(found) || found.length === 0) return;
  const usualKind = optionalText(input.questions_usual_kind) ?? 'short-text';
  await runOwnerAction('action:author-question-sequence', {
    formId,
    title: optionalText(input.questions_title) ?? 'Answer these',
    presentation: isRecord(input.questions_presentation)
      ? input.questions_presentation
      : { mode: 'one-prompt-at-a-time', submit_label: 'Send' },
    questions: found.map((question, index) => questionForForm(question, index, usualKind)),
  });
}

/**
 * Where the answer should be sent while it is still being written, or nothing.
 *
 * The participant declares one thing and it is not a provider name: the
 * address on this machine that takes a part of an answer. Declare nothing and
 * the answer arrives in one piece at the end, which is what every participant
 * that has not spoken keeps getting.
 *
 * The address is the machine's own. Nothing here reaches outward, and a
 * delivery that fails is a part nobody saw rather than an answer that failed.
 */
function readPartsDelivery(value: JsonRecord, turn: {
  occurredAt: string;
  conversationRef: string;
  answerTurnRef: string;
  turnRef: string;
  participantRef: string;
  sequence: number;
}): JsonRecord | null {
  const streaming = isRecord(value.stream_answer) ? value.stream_answer : null;
  const url = streaming ? optionalText(streaming.parts_url) : undefined;
  if (!url) return null;
  return {
    url,
    ...(isRecord(streaming?.headers) ? { headers: streaming.headers } : {}),
    // Everything the receiver needs in order to know which turn these words
    // belong to, travelling with every delivery so it holds nothing itself.
    with: {
      conversation_ref: turn.conversationRef,
      turn_ref: turn.answerTurnRef,
      parent_turn_ref: turn.turnRef,
      participant_ref: turn.participantRef,
      sequence: turn.sequence + 1,
      occurred_at: turn.occurredAt,
      // Where the reply sits inside a structured answer, so the reader sees
      // the reply's words and never the braces around them. Where the words
      // sit inside one streamed document is the model adapter's fact and is
      // added by the model owner, not declared here.
      ...(Array.isArray(value.answer_path) ? { answer_path: value.answer_path } : {}),
    },
  };
}

export async function answerOneAddressedTurn(value: unknown, context?: BitfieldRuntimeContext) {
  if (!isRecord(value)) throw new Error('answer input must be an object.');
  const conversationRef = requiredText(value.conversation_ref, 'conversation_ref');
  const turnRef = requiredText(value.turn_ref, 'turn_ref');
  const participantRef = requiredText(value.participant_ref, 'participant_ref');
  const body = requiredText(value.body, 'body');
  const sequence = typeof value.sequence === 'number' && Number.isFinite(value.sequence) ? value.sequence : 0;

  const profiles = await readPublishedRecordsOfKind('ai-agent-profile');
  const profile = profiles.find((candidate) => optionalText(candidate.id) === participantRef);
  if (!profile) throw new Error(`Participant ${participantRef} is not configured to answer.`);

  const instructionRefs = textList(profile.instruction_refs);
  const blocks = instructionRefs.length > 0 ? await readPublishedRecordsOfKind('ai-instruction-block') : [];
  const instructionText = instructionTextForProfile(profile, blocks);

  // WHERE THE ANSWER GOES IS DECIDED BEFORE IT EXISTS.
  //
  // The turn the answer will occupy is named now, so the words can be put into
  // it while they are still arriving instead of after the last one lands. A
  // participant that says where its words sit inside its model's answer gets
  // this; one that says nothing is answered exactly as before, in one piece at
  // the end, and nothing about it changes.
  const answerTurnRef = `${turnRef}:answer`;
  // The instant this request arrived, fixed for the whole request, so the turn
  // carries the same time while it is being written and after it is finished.
  const occurredAt = new Date(readTrustedRuntimeClockMs(context)).toISOString();
  const watchWhileItArrives = readPartsDelivery(value, {
    occurredAt,
    conversationRef,
    answerTurnRef,
    turnRef,
    participantRef,
    sequence,
  });

  const answer = decodeReply(await sendRequestToBitfieldTarget({
    target: 'model-response.request-model-response',
    payload: {
      body,
      thread_ref: conversationRef,
      request: {
        ...modelSelection(value, profile),
        instruction_text: instructionText,
        prompt_template: optionalText(value.prompt_template) ?? DEFAULT_PROMPT_TEMPLATE,
        ...(optionalText(value.context_text) ? { context_text: optionalText(value.context_text) } : {}),
        ...(isRecord(value.response_schema) ? { response_schema: value.response_schema } : {}),
        // Values the participant hands to its model's settings, such as how
        // long to think before answering. Names only the model adapter declares.
        ...(isRecord(value.template_bindings) ? { template_bindings: value.template_bindings } : {}),
        ...(watchWhileItArrives ? { deliver_parts_to: watchWhileItArrives } : {}),
      },
    },
  }));

  if (!isRecord(answer) || !isRecord(answer.message)) throw new Error('The model did not return a message.');
  const answerText = replyText(answer, answer.message, textList(value.answer_path));
  await putQuestionsOnScreen(value, answer.message);

  // Writing the turn alone is not enough to be read back. A turn becomes part of
  // a conversation by being listed on its message page and moving its cursor,
  // and it reaches the screen only once the projections are published again.
  // Skipping either leaves an answer that exists, answers correctly, and is
  // invisible, which reads exactly like no answer at all.
  // The same turn the parts were being written into, so the finished answer
  // lands on top of whatever the reader has already been watching rather than
  // arriving beside it as a second copy.
  await runOwnerAction('action:conversations.append-addressed-exchange-turns', {
    conversation_ref: conversationRef,
    message_page_ref: `message-page:${conversationRef}`,
    message_refs: [answerTurnRef],
    next_cursor_ref: answerTurnRef,
    turn_records: [{
      turn_ref: answerTurnRef,
      conversation_ref: conversationRef,
      author_ref: participantRef,
      speaker_ref: participantRef,
      parent_turn_ref: turnRef,
      // The conversation store presents exactly two roles. A turn written with
      // any other word is stored, counted, and never drawn, which looks from the
      // screen like the answer never came.
      role: 'assistant',
      content: answerText,
      sequence: sequence + 1,
      occurred_at: occurredAt,
      addressed_participant_refs: [participantRef],
    }],
  });
  await runOwnerAction('action:conversations.publish-addressed-exchange-projections', {});

  // The words come back as well as being stored. The conversation is the record;
  // returning the answer is what lets the person see it the moment it arrives
  // instead of the next time they open the conversation.
  return {
    turn_ref: answerTurnRef,
    conversation_ref: conversationRef,
    occurred_at: occurredAt,
    content: answerText,
  };
}
