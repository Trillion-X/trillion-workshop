// PORTED FROM: bitfield-packages/packages/chat/do-work/advance-chat-tool-round.ts @ e99ac5976
// packages/chat/do-work/advance-chat-tool-round.ts
//
// ONE agentic tool round for the chat surface, extracted OUT of ChatView so the view is not
// a god file. ChatView's poll effect calls this when a model reply arrives; the helper parses
// any tool requests, dispatches them (via injected chat transport), frames the results back
// using the OWNER-held decision primitives, and returns the next step — CONTINUE (re-prompt
// the same agent with a continuation) or FINAL (finalize the reply). ChatView only maps the
// step onto its turn state (submit + re-arm, or finalize) — it holds NO loop logic anymore.
//
// no god package: the loop DECISION primitives are owned by their real packages, not by chat.
// The producer owns framing results into the next model prompt and the continue-versus-final
// call (ai-records-producer: shouldContinueToolLoop, buildAgentTurnContinuation); the tool
// catalog owns bounding a tool's declared output (ai-tool-catalog: prepareToolResult).
// This helper is chat's thin transport-driven driver + activity rendering — it names no
// model/provider/prompt. The fence PARSER is chat's legit superset (also decodes placeable
// surfaceIds). Pure of React: all IO is injected.

import { parseChatWorkRequests, selectDeclaredToolOutput, type ChatWorkRequestResult } from './execute-chat-work-requests';
import type { CapabilityRef } from '../read-data/read-chat-work-actions';
import type { DiscoveredCapability } from './discover-capabilities';
import type { ChatWorkflowAction } from '../read-data/read-chat-work-actions';
import type { AgentMessageToolUse } from '../read-data/chat-message-types';
import {
  shouldContinueToolLoop,
  buildAgentTurnContinuation,
  type ToolResultForContinuation,
} from '../../ai-records-producer/do-work/build-agent-turn-continuation';
import { prepareToolResult } from '../../ai-tool-catalog/do-work/prepare-tool-result';
import type { ToolResultPolicy } from '../../ai-tool-catalog/do-work/prepare-tool-result';
import type { ChatTransitionPolicy } from '../read-data/read-chat-transition-policy';

export type ChatToolRoundStep =
  | { kind: 'final' }
  | { kind: 'continue'; continuation: string; nextRequestId: string; discoveredCapabilities?: readonly DiscoveredCapability[]; authorityBindingRef?: string };

/**
 * A structured tool activity message the live loop emits so the chat renders the
 * SAME rich collapsible ToolUseBlock that imported CLI transcripts use (icon, tool
 * name, command subtitle, terminal output, line count, copy) — NOT a flat status
 * pill. Emitted once per tool with no result (in-progress), then re-emitted with
 * the SAME `id` once the result arrives; the consumer upserts by id (mirrors the
 * imported-transcript decoder's update-in-place pairing).
 */
export interface ChatToolMessage {
  id: string;
  type: 'tool_use';
  toolUse: AgentMessageToolUse;
}

export interface AdvanceChatToolRoundInput {
  /** The model's reply text for this round (may contain tool-request fences). */
  replyText: string;
  /** The current turn's request id (the continuation re-prompt derives the next id from it). */
  requestId: string;
  /** The original user request (re-anchors the model in the continuation). */
  userText: string;
  /** How many tool rounds have already run (bounds the loop). */
  toolRound: number;
  /** Max tool rounds before the model must answer with no more requests. */
  maxRounds: number;
  /** The published actions the model may call (for the human label + dispatch). */
  workflowActions: readonly ChatWorkflowAction[];
  /** Address prefix where each tool writes its result (chat owns its transport addresses). */
  toolResultAddressPrefix: string;
  /** Which agent is acting (stamped into each tool dispatch). */
  agentRef: string | null;
  /** Current prompt-addressed policy, validated by chat's owner reader. */
  resultPolicy?: ToolResultPolicy | null;
  /** Injected: dispatch the reply's tool fences; `enrich` stamps chat's per-call fields. */
  runTools(
    assistantText: string,
    enrich: (capabilityRef: CapabilityRef, input: unknown, index: number) => unknown,
  ): Promise<ChatWorkRequestResult[]>;
  /** The one generic discovery tool. It is separate from later exact invocation. */
  runDiscovery?(query: string, signal?: AbortSignal): Promise<{ capabilities: readonly DiscoveredCapability[]; authorityBindingRef: string }>;
  discoverySignal?: AbortSignal;
  observe?(event: Record<string, unknown>): void;
  /** Injected: read a tool's result record at the stamped address (null until present). */
  readToolResult(address: string): Promise<Record<string, unknown> | null>;
  /** Injected: emit/upsert a structured tool message so the chat renders a rich
   *  collapsible ToolUseBlock (same as imported transcripts). Called once per tool
   *  with no result, then again with the SAME id once the result is read. */
  emitToolMessage(message: ChatToolMessage): void;
  /** Injected: true once the turn was cancelled (caller navigated away / new send). */
  isCancelled(): boolean;
}

function discoveryQuery(text: string): string | null {
  const match = /```bitfield-capability-discovery\s*([\s\S]*?)```/.exec(text);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1].trim());
    return value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.query === 'string' ? value.query : null;
  } catch { return null; }
}

function labelOf(workflowActions: readonly ChatWorkflowAction[], address: string): string {
  return workflowActions.find((w) => w.capabilityRef.canonicalAddress === address)?.label || address;
}

/**
 * Advance ONE agentic round. Returns FINAL when there are no tool fences (or the cap is hit),
 * else dispatches the tools, frames the results, and returns CONTINUE with the continuation
 * prompt + next request id. Emits trail activity (using-tool → tool-result) in order so the
 * user SEES the work. Pure of React — ChatView maps the step onto its turn state.
 */
export async function advanceChatToolRound(input: AdvanceChatToolRoundInput): Promise<ChatToolRoundStep> {
  const query = discoveryQuery(input.replyText);
  if (query !== null) {
    if (!input.runDiscovery || input.toolRound >= input.maxRounds) return { kind: 'final' };
    const discovery = await input.runDiscovery(query, input.discoverySignal);
    if (input.isCancelled() || input.discoverySignal?.aborted) return { kind: 'final' };
    const discoveredCapabilities = discovery.capabilities;
    for (const capability of discoveredCapabilities) input.observe?.({ event: 'chat.capability_discovered', address: capability.canonical_address, revision: capability.canonical_revision, score_provenance_ref: capability.rank_provenance_ref });
    const continuation = [
      '--- Capability Discovery Results ---',
      'These exact records are authorized only for the immediately following round. Invoke only by the complete capabilityRef triple.',
      JSON.stringify(discoveredCapabilities.map((c) => ({ capabilityRef: { canonicalAddress: c.canonical_address, canonicalRevision: c.canonical_revision, payloadHash: c.payload_hash }, title: c.title, description: c.description, inputSchema: c.input_schema }))),
      '--- End Capability Discovery Results ---',
      `User's request: ${input.userText.trim()}`,
    ].join('\n\n');
    return { kind: 'continue', continuation, nextRequestId: `${input.requestId}-discovery${input.toolRound + 1}`, discoveredCapabilities, authorityBindingRef: discovery.authorityBindingRef };
  }
  const fences = parseChatWorkRequests(input.replyText);
  if (fences.length === 0 || input.toolRound >= input.maxRounds) return { kind: 'final' };

  const roundTag = `${input.requestId}:r${input.toolRound}`;
  const toolParamsOf = (raw: unknown): Record<string, unknown> =>
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  // Emit a tool_use message per fence IMMEDIATELY (no result yet → in-progress
  // collapsible block with a spinner) so the user sees the agent working with the
  // SAME rich ToolUseBlock as imported transcripts, not a flat status pill.
  fences.forEach((fence, index) => {
    const id = `${roundTag}-${index}`;
    input.emitToolMessage({
      id,
      type: 'tool_use',
      toolUse: { id, tool: labelOf(input.workflowActions, fence.capabilityRef.canonicalAddress), params: toolParamsOf(fence.input) },
    });
  });

  const workResults = await input.runTools(input.replyText, (_capabilityRef, rawInput, index) => {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return rawInput;
    return {
      ...(rawInput as Record<string, unknown>),
      result_address: `${input.toolResultAddressPrefix}-${index}`,
      agent_ref: input.agentRef ?? 'chat',
    };
  });
  if (input.isCancelled()) return { kind: 'final' };

  const toolResults: ToolResultForContinuation[] = [];
  for (let index = 0; index < workResults.length; index += 1) {
    const wr = workResults[index];
    const di = wr.dispatchedInput as Record<string, unknown> | null | undefined;
    const addr = di && typeof di.result_address === 'string' ? di.result_address : null;
    const addressedResult = addr ? await input.readToolResult(addr).catch(() => null) : null;
    if (input.isCancelled()) return { kind: 'final' };
    const prepared = prepareToolResult({ workflowReply: wr.workflowReply, addressedResult, addressedResultRef: addr, resultSelector: wr.action?.resultSelector, policy: input.resultPolicy ?? undefined, accepted: wr.accepted, error: wr.error });
    const summary = prepared.summary;
    input.observe?.({ event: 'chat.tool_result_prepared', source: prepared.source, result_ref: addr ?? wr.action?.recordId ?? '' });
    toolResults.push({ actionId: wr.request.capabilityRef.canonicalAddress, accepted: wr.accepted, summary, error: wr.error });
    // Re-emit the SAME tool id with the result filled in → consumer upserts it,
    // turning the in-progress block into the finished terminal/output view.
    const id = `${roundTag}-${index}`;
    input.emitToolMessage({
      id,
      type: 'tool_use',
      toolUse: {
        id,
        tool: labelOf(input.workflowActions, wr.request.capabilityRef.canonicalAddress),
        params: {
          ...toolParamsOf(wr.request.input),
        },
        ...(wr.action?.surfaceSelector ? {
          // Trusted current action DATA stays separate from visible/untrusted
          // request params. It can preview the selected field and, when a
          // Workflow receipt exists, bind an explicit durable placement read.
          placeableResult: {
            ...(wr.receiptRef ? { sourceRef: wr.receiptRef } : {}),
            selector: wr.action.surfaceSelector,
            surface: selectDeclaredToolOutput(wr.workflowReply, wr.action.surfaceSelector),
          },
        } : {}),
        result: summary,
      },
    });
  }

  if (!shouldContinueToolLoop({ toolResults, roundsSoFar: input.toolRound, maxRounds: input.maxRounds })) {
    return { kind: 'final' };
  }
  const continuation = buildAgentTurnContinuation({
    userText: input.userText,
    assistantReply: input.replyText,
    toolResults,
    roundsSoFar: input.toolRound,
    maxRounds: input.maxRounds,
  });
  if (!continuation) return { kind: 'final' };
  return { kind: 'continue', continuation, nextRequestId: `${input.requestId}-tool${input.toolRound + 1}` };
}

/** Active policy gate: no current transition DATA means no discovery or invocation I/O. */
export function advanceChatToolRoundWithPolicy(
  input: Omit<AdvanceChatToolRoundInput, 'maxRounds'>,
  policy: ChatTransitionPolicy | null,
): Promise<ChatToolRoundStep> {
  return policy ? advanceChatToolRound({ ...input, maxRounds: policy.maxRounds }) : Promise.resolve({ kind: 'final' });
}
