// PORTED FROM: bitfield-packages/packages/chat/do-work/submit-chat-turn-via-producer.ts @ e99ac5976
// packages/chat/do-work/submit-chat-turn-via-producer.ts
//
// PURPOSE
// Fire a chat turn through the GENERIC ai-records-producer action instead of
// the chat's hand-rolled AI runner. The chat assembles the instruction
// (via `materializeAddressedExchange`), mints a request_id, and fires the
// producer workflow. The producer resolves the agent engine-side from
// `selected-agent` SSOT; the chat never names or resolves a provider.
//
// The reactive READ side for producer result/error records lives in
// `read-data/read-chat-producer-status.ts` — it must import
// `@bitfield/runtime-kit/protocol`, which only resolves in the entry-bytes
// build, not the do-work stored-bytes build. The SEND below uses only the bound
// `sendRequestToBitfieldTarget` (the entry's declared slot::workflow write), so
// it builds in both.
//
// NON-NEGOTIABLE INVARIANTS
//   - PRODUCER-BLIND: no participant resolution, no process-session logic
//   - GENERIC: the producer workflow handles agent/provider resolution + CLI
//   - SUBMIT-AND-POLL: workflow execution writes durable result/error records;
//     the chat reads those producer records instead of consuming inline output

import { sendRequestToBitfieldTarget } from '#workspace-records';
import incomingMessageQuestions from '../data/incoming-message-questions.json';

export interface SubmitChatTurnInput {
  /** Unique request identifier minted by the caller (e.g. chat-{sessionRef}-{counter}). */
  readonly requestId: string;
  /** The assembled instruction_text from `materializeAddressedExchange`. */
  readonly instructionText: string;
  /** Which agent to target (optional, resolved engine-side from selected-agent SSOT). */
  readonly agentRef?: string;
  /** Which model to use (optional). When the picker selects a specific model of a
   *  CLI/provider, pass its opaque id here; the producer renders it as the launch
   *  model. Empty/omitted = the resolved provider/CLI default model. */
  readonly modelId?: string;
}

/** What the caller needs to poll for the reply. */
export interface ChatTurnSubmission {
  readonly requestId: string;
  readonly resultAddress: string;
  readonly errorAddress: string;
  /** Omitted: the reply is read from whichever app this chat is running in. */
  readonly resultPartitionLabel?: string;
  /** The producer writes its result/error record at the LABEL-HASH (binding)
   *  address, not the identity-text address (verified live: the identity-text
   *  read returns none while the label-hash read returns the reply items). The
   *  proven group-board reader defaults to 'label-hash' for the same reason
   *  (group/read-data/read-producer-status.ts). Without this, the poll reads the
   *  identity-text address, never finds the reply, and the turn shows
   *  "Thinking…" forever. */
  readonly addressMode: 'label-hash' | 'identity-text';
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unwrapWorkflowReply(value: unknown): unknown {
  if (!record(value)) return value;
  const payload = 'payload' in value ? value.payload : value;
  if (payload instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(payload));
  if (typeof payload === 'string') return JSON.parse(payload);
  if (record(payload) && 'output' in payload) return payload.output;
  return payload;
}

/** Always-on typed state questions. Failure preserves the original text. */
export async function understandChatInstruction(instructionText: string): Promise<string> {
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: 'answer-state-questions.answer',
      payload: {
        state: { message: instructionText, current_task: '', active_goals: [] },
        questions: incomingMessageQuestions,
        thread_ref: 'chat:incoming-message',
      },
    });
    return [instructionText, '', '<typed-state-answers advisory="true">', JSON.stringify(unwrapWorkflowReply(reply)), '</typed-state-answers>'].join('\n');
  } catch {
    return instructionText;
  }
}

/** Submit the ai-records-producer workflow definition with the chat's instruction text. */
export async function submitChatTurnViaProducer(
  input: SubmitChatTurnInput,
): Promise<ChatTurnSubmission> {
  const enrichedInstructionText = await understandChatInstruction(input.instructionText);
  await sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      include_output: false,
      definition_id: 'action:run-ai-records-production',
      input: {
        request_id: input.requestId,
        instruction_text: enrichedInstructionText,
        output_kind: 'message',
        // Always send `model` (empty when no specific model is picked) so the
        // workflow's {from:input,path:model} binding never resolves null — a null
        // argv crashes compute.process (FE_CODEC). Empty = producer uses default.
        model: input.modelId ?? '',
        wrap_instruction_ref: '',
        target_group_ref: 'chat',
        partition_key: 'runtime-partition',
        // Always send `agent_ref` (empty when no participant is explicitly picked)
        // so the producer's {from:input,path:agent_ref} → --cli-override binding never
        // resolves null (a null argv crashes compute.process, FE_CODEC). A non-empty
        // value routes the send to that CLI directly (input-driven, the proven path);
        // empty = resolve from selected-agent SSOT then provider-primary.
        agent_ref: input.agentRef ?? '',
      },
    },
  });

  return chatTurnSubmissionForRequest(input.requestId);
}

/** Address the durable reply before dispatch so a lost acknowledgement cannot
 * hide a reply that the owner already produced. */
export function chatTurnSubmissionForRequest(requestId: string): ChatTurnSubmission {
  return {
    requestId,
    resultAddress: `package::ai-records-producer::result::${requestId}`,
    errorAddress: `package::ai-records-producer::error::${requestId}`,
    // No partition is named. The producer writes its result into the partition
    // the engine is serving, and an engine that serves one partition refuses a
    // read that names any other: "engine.operation.read-current names partition
    // <x>, but this engine serves <y> and owns no other. Omit the partition to
    // read the serving app." Naming "runtime-partition" here made every hosted
    // turn poll a partition the engine rejects, so a reply that had already been
    // written was never found and the turn showed "Thinking…" forever.
    //
    // This comment used to say the chat "lives in bitfield-studio". That app is
    // retired, and naming any single app here was wrong even while it existed: this
    // package is installed in many sets, so the answer is whichever app it is running
    // in, never a literal.
    // The producer writes the result at the label-hash (binding) address.
    addressMode: 'label-hash',
  };
}
