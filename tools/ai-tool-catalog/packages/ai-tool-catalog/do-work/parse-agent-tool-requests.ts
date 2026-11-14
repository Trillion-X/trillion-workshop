// packages/ai-tool-catalog/do-work/parse-agent-tool-requests.ts
//
// The tool-request PARSER + tolerant action resolver for the agent-turn ReAct loop,
// owned by the TOOL catalog (ai-tool-catalog owns the published tools and their
// admission) — NOT by any messaging or product surface. When an agent's model
// output contains fenced tool-request block(s), this pure leaf decodes them into
// {actionId, input} and resolves a model-emitted actionId to the published
// action(s), tolerating the two near-misses models make constantly (dropping the
// `action:` prefix, passing a bare suffix).
//
// WHY here and not in a surface package (no god package): deciding WHICH published
// tool a model-emitted id names is tool ADMISSION, owned by the same package that
// validates a tool invocation against its owner schema in request-tool-run.ts. The
// resolver and the invoker must agree on identity or an agent can address a tool
// the catalog never admitted. This is the tool-owned replacement for the pure parts
// of chat/do-work/execute-chat-work-requests.ts (parseChatWorkRequests +
// resolveActionMatches), which are deleted once chat dispatches an agent turn by
// Envelope address (no loop).
//
// Society-as-DATA (Physics vs Society): the fence tag the model emits is a protocol
// CONVENTION, not a universal truth — it is a parameter (default = the current
// token), never a buried literal. Generic over any action shape (L069/L090): the
// resolver works on any {actionId} record via an injected index. Pure leaf, zero I/O.

/** The default fenced-block language tag an agent emits to request tool work. */
export const DEFAULT_TOOL_REQUEST_FENCE_TAG = 'bitfield-work-request';

/** A decoded tool request: which action to run + the input to run it with. */
export interface AgentToolRequest {
  actionId: string;
  input: unknown;
  /** Caller-supplied correlation id when present (else the runtime derives one). */
  correlationId?: string | null;
}

/** Minimal shape the resolver matches against — any published action has an actionId. */
export interface ResolvableAction {
  actionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function decodeToolRequest(value: unknown): AgentToolRequest | null {
  if (!isRecord(value)) return null;
  if (typeof value.actionId !== 'string' || value.actionId.length === 0) return null;
  return {
    actionId: value.actionId,
    input: value.input,
    correlationId: typeof value.correlationId === 'string' ? value.correlationId : null,
  };
}

/** Escape a fence tag for safe use inside a RegExp (tags are DATA, may contain metachars). */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse all fenced tool-request blocks from a model's text. Invalid/non-JSON blocks
 * are skipped (a malformed request is not a crash — the runtime simply finds no work).
 * The fence tag defaults to the current protocol token but is a parameter (Society DATA).
 */
export function parseAgentToolRequests(
  text: string,
  fenceTag: string = DEFAULT_TOOL_REQUEST_FENCE_TAG,
): AgentToolRequest[] {
  const requests: AgentToolRequest[] = [];
  const blockPattern = new RegExp('```' + escapeForRegExp(fenceTag) + '\\s*([\\s\\S]*?)```', 'g');
  for (const match of text.matchAll(blockPattern)) {
    const body = match[1]?.trim();
    if (!body) continue;
    try {
      const decoded = decodeToolRequest(JSON.parse(body));
      if (decoded) requests.push(decoded);
    } catch {
      // Invalid request blocks are ignored; the runtime surfaces only real dispatch outcomes.
    }
  }
  return requests;
}

/**
 * Resolve a model-emitted actionId to published action(s), tolerating the two
 * near-misses models make constantly: dropping the `action:` prefix, and passing a
 * bare suffix. Exact first, then `action:`-prefixed, then a UNIQUE endsWith match
 * (an ambiguous suffix returns ALL matches so the caller reports the conflict rather
 * than silently picking one). Generic over any {actionId} record.
 */
export function resolveActionMatches<A extends ResolvableAction>(
  actionId: string,
  actionsById: ReadonlyMap<string, A[]>,
): A[] {
  const exact = actionsById.get(actionId);
  if (exact && exact.length > 0) return exact;
  const prefixed = actionsById.get(`action:${actionId}`);
  if (prefixed && prefixed.length > 0) return prefixed;
  const suffix = actionId.startsWith('action:') ? actionId.slice('action:'.length) : actionId;
  const endsMatches: A[] = [];
  for (const [id, actions] of actionsById) {
    const idSuffix = id.startsWith('action:') ? id.slice('action:'.length) : id;
    if (idSuffix === suffix) endsMatches.push(...actions);
  }
  return endsMatches;
}

/** Build the resolver index from a flat action list (groups duplicate ids). */
export function indexActionsById<A extends ResolvableAction>(actions: readonly A[]): Map<string, A[]> {
  const byId = new Map<string, A[]>();
  for (const action of actions) {
    const existing = byId.get(action.actionId) ?? [];
    existing.push(action);
    byId.set(action.actionId, existing);
  }
  return byId;
}
