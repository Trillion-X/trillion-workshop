# ai-records-producer / do-work

Everything the producer does to make the NEXT AI record: run the provider command that yields records, and frame executed tool results into the next model prompt.

## Files

| File | Purpose |
|------|---------|
| `build-agent-turn-continuation.ts` | Frames executed tool results back into a continuation prompt for the same agent, and decides whether the tool loop continues or the turn is final. |
| `build-agent-turn-continuation.test.ts` | Empty-result null, result framing, stdout truncation, round-cap stop language, and dispatch-error surfacing. |
| `process-scripts/make-ai-records-command-request.mjs` | Builds the provider command request for a production run. |
| `process-scripts/make-ai-records-command-request.py` | Python peer of the command-request builder, run as a `compute.process` script. |
| `process-scripts/make-ai-records-from-command-output.mjs` | Parses provider command output into result/error records. |
| `process-scripts/make-ai-records-from-command-output.py` | Python peer of the output parser, run as a `compute.process` script. |
| `process-scripts/__tests__/test_make_ai_records_command_request.py` | Pytest proofs for the command-request builder. |
| `process-scripts/__tests__/test_make_ai_records_from_command_output.py` | Pytest proofs for the output parser. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `ToolResultForContinuation` | `{ actionId: string; accepted: boolean; summary: string; error?: string \| null }` | One executed tool result, generic over any tool. |
| `BuildAgentTurnContinuationInput` | `{ userText, assistantReply, toolResults, roundsSoFar?, maxRounds?, summaryCharLimit? }` | Everything needed to re-anchor the model on intent and bound the loop. `maxRounds` and `summaryCharLimit` are Society DATA supplied by the caller from its owner's published policy; the in-source values are fallbacks only. |
| `buildAgentTurnContinuation` | `(input: BuildAgentTurnContinuationInput) => string \| null` | The continuation prompt, or `null` when there is nothing to continue. |
| `shouldContinueToolLoop` | `(input: { toolResults, roundsSoFar, maxRounds? }) => boolean` | True when at least one tool executed or errored AND the round cap is not reached. |

## Why This Design

Framing executed results into the next model prompt, and deciding continue-versus-final, IS producing the next AI record. A messaging surface addresses an agent turn; it never implements the loop. Keeping the decision here means a second surface inherits the same bounded loop instead of re-deriving one.

## Invariants

- Generic over any tool (L069): a result is `{actionId, accepted, summary}`. No tool name, no provider name, and no surface name appears here.
- The loop is bounded. At the round cap the prompt tells the model to stop emitting requests rather than relying on the model to count.
- Both bounds are inputs, never buried thresholds. A second customer changes a DATA row on the caller's policy record; this file is not edited.
- One huge stdout cannot blow the prompt: summaries are clamped and the truncation is stated in the text.
- Pure leaf, zero I/O. The agent-turn runtime dispatches the continuation through the normal turn path.

## Dependencies

**Depends on:** nothing. `build-agent-turn-continuation.ts` has no imports.

**Depended on by:** `packages/chat/do-work/advance-chat-tool-round.ts`, and `packages/ai-work-control/do-work/run-agent-turn.ts` until that file settles with the rest of the agent-turn runtime.
