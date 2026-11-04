// PORTED FROM: bitfield-packages/packages/ai-records-producer/do-work/build-agent-turn-continuation.ts @ e99ac5976
// packages/ai-records-producer/do-work/build-agent-turn-continuation.ts
//
// The continuation primitive of the agent-turn ReAct loop, owned by the AI-record
// PRODUCER (ai-records-producer owns producing the next model turn) — NOT by any
// messaging or product surface. After an agent's turn emits one or more tool
// requests and the runtime executes them, the model has NOT yet seen the results,
// so it cannot answer (e.g. it dispatched `find` but never saw the directories).
// This pure leaf frames the executed tool results back into a CONTINUATION prompt
// for the SAME agent so it composes the final answer.
//
// WHY here and not in a surface package (no god package): framing executed results
// into the NEXT model prompt, and deciding continue-versus-final, IS producing the
// next AI record — the producer's job. A messaging surface ADDRESSES an agent turn;
// it never implements the loop. This leaf is the producer-owned replacement for the
// prior chat-local copy (chat/do-work/build-tool-result-continuation.ts), which is
// deleted once chat dispatches an agent turn by Envelope address instead of running
// the loop itself.
//
// GENERIC over any tool (L069): a tool result is just {actionId, ok, summary} —
// this names no specific tool and no specific surface. The same loop serves
// run-process, a future http-fetch tool, or anything published. Framework-agnostic,
// zero I/O — the agent-turn runtime dispatches the continuation via the normal turn
// path. Pure leaf (zero I/O) so it is shareable by Envelope-decoupled callers.

export interface ToolResultForContinuation {
  /** The action that was requested (e.g. action:run-a-job-on-your-stuff.run-guarded-process-tool). */
  actionId: string;
  /** Whether the runtime accepted + dispatched the request (not whether the tool "allowed"). */
  accepted: boolean;
  /** Human-meaningful result text: the tool's stdout / denial reason / error. */
  summary: string;
  /** Error string when the dispatch itself failed; absent on success. */
  error?: string | null;
}

export interface BuildAgentTurnContinuationInput {
  /** The original user request for this turn (so the model re-anchors on intent). */
  userText: string;
  /** The agent's prior reply text (with the tool request(s)) — for the model's own context. */
  assistantReply: string;
  /** The executed tool results, in request order. */
  toolResults: readonly ToolResultForContinuation[];
  /** How many tool rounds have already happened (0 = first continuation). Bounds the loop. */
  roundsSoFar?: number;
  /** Max tool rounds allowed before the model must answer with no more requests. */
  maxRounds?: number;
  /**
   * Max characters of ONE tool summary the continuation may carry. Society DATA:
   * it depends on the receiving model's context budget, so the caller supplies it
   * from its owner's published policy the same way it supplies maxRounds. The
   * in-source value below is only the fallback when no policy is bound.
   */
  summaryCharLimit?: number;
}

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_SUMMARY_CHAR_LIMIT = 6000;

/** Clamp a tool summary so one huge stdout can't blow the continuation prompt. */
function boundedSummary(summary: string, summaryCharLimit: number): string {
  const trimmed = (summary ?? '').trim();
  if (trimmed.length <= summaryCharLimit) return trimmed;
  const head = trimmed.slice(0, summaryCharLimit);
  return `${head}\n…[truncated ${trimmed.length - summaryCharLimit} chars]`;
}

function resultLine(result: ToolResultForContinuation, summaryCharLimit: number): string {
  const status = result.error
    ? `dispatch-error: ${result.error}`
    : result.accepted
      ? 'executed'
      : 'not-executed';
  return [
    `Tool: ${result.actionId} (${status})`,
    'Result:',
    boundedSummary(result.summary, summaryCharLimit),
  ].join('\n');
}

/**
 * Build the continuation prompt. Returns null when there are no tool results to
 * feed back (the loop ends — nothing to continue).
 */
export function buildAgentTurnContinuation(input: BuildAgentTurnContinuationInput): string | null {
  if (!input.toolResults || input.toolResults.length === 0) return null;
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const summaryCharLimit = input.summaryCharLimit ?? DEFAULT_SUMMARY_CHAR_LIMIT;
  const roundsSoFar = input.roundsSoFar ?? 0;
  const roundsLeft = Math.max(0, maxRounds - roundsSoFar - 1);

  const blocks: string[] = [
    '--- Tool Results ---',
    "You requested tool work. Here are the results. Use them to answer the user's request now.",
  ];
  for (const result of input.toolResults) blocks.push(resultLine(result, summaryCharLimit));

  if (roundsLeft <= 0) {
    blocks.push(
      'You have reached the tool-use limit for this turn. Do not emit another tool request. Answer the user directly using the results above.',
    );
  } else {
    blocks.push(
      `Answer the user now in plain language using these results. Only emit another tool request if you genuinely need more tool work to answer (at most ${roundsLeft} more). Do not repeat a tool call that already succeeded.`,
    );
  }
  blocks.push('--- End Tool Results ---', `User's request: ${input.userText.trim()}`);
  return blocks.join('\n\n');
}

/**
 * Whether the loop should continue: there is at least one executed tool result
 * AND we are under the round cap. Pure decision the agent-turn runtime calls.
 */
export function shouldContinueToolLoop(input: {
  toolResults: readonly ToolResultForContinuation[];
  roundsSoFar: number;
  maxRounds?: number;
}): boolean {
  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (input.roundsSoFar >= maxRounds) return false;
  return (input.toolResults ?? []).some((result) => result.accepted || Boolean(result.error));
}
