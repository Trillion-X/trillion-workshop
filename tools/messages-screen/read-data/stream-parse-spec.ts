// PORTED FROM: bitfield-packages/packages/chat/read-data/stream-parse-spec.ts @ e99ac5976
// packages/chat/read-data/stream-parse-spec.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The generic, data-driven stream parser for the chat surface.
//
// A participant (any agent, model, human, service, animal, device) streams raw
// JSONL events in ITS OWN wire format. This module knows NOTHING about any
// specific format. Instead, the participant's way-to-reach record carries a
// `StreamParseSpec` — pure data that says, for each kind of raw event, where to
// find the text/tool-name/arguments/output and which normalized AgentMessage
// kind to emit. `interpretStream` walks the raw lines and applies that data.
//
// Adding a brand-new participant kind with a never-seen wire format requires
// ZERO code change here — only a new StreamParseSpec data record. (L090:
// self-describing data, generic handler. The handler never names what it
// handles.)
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No literal agent/provider/format name appears in this file. No
//    "agent_message", "function_call", "reasoning", "assistant", "codex",
//    "claude". Those words live ONLY in data records authored by the participant
//    owner package.
// 2. Output is always the package's own normalized AgentMessage[] vocabulary.
// 3. Pure: no React, no DOM, no I/O. Deterministic input -> output.
//
// =============================================================================

import type { AgentMessage, AgentMessageType } from './chat-message-types';

// ---------------------------------------------------------------------------
// THE DATA SHAPE (carried on a participant's way-to-reach record)
// ---------------------------------------------------------------------------

/** A condition tested against one raw event object, by explicit field path. */
export interface StreamMatchCondition {
  /** Field path into the raw event, e.g. ["payload", "type"]. */
  path: string[];
  /** Require the value at `path` to equal this string. */
  equals?: string;
  /** Require the value at `path` to be present (non-null/undefined). */
  exists?: boolean;
}

/** Emit a text-like message (text / thinking / status / error). */
export interface StreamEmitText {
  kind: Extract<AgentMessageType, 'text' | 'thinking' | 'status' | 'error'>;
  /** Where the display text lives. Tried in order; first non-empty wins. */
  textPaths: string[][];
  /** Optional stable id path, used to coalesce streamed updates to one message. */
  sourceIdPath?: string[];
  /** Speaker to attribute (defaults to 'assistant'). */
  role?: 'human' | 'assistant';
}

/** Emit a tool invocation. */
export interface StreamEmitToolUse {
  kind: 'tool_use';
  namePath: string[];
  idPath?: string[];
  argsPath?: string[];
}

/** Emit a tool result, paired to a prior tool_use by id when present. */
export interface StreamEmitToolResult {
  kind: 'tool_result';
  idPath?: string[];
  outputPath: string[];
}

export type StreamEmit = StreamEmitText | StreamEmitToolUse | StreamEmitToolResult;

/** One rule: when all conditions hold for a raw event, emit this message. */
export interface StreamEventRule {
  when: StreamMatchCondition[];
  emit: StreamEmit;
}

/** The full parse spec for one participant's stream. */
export interface StreamParseSpec {
  /** Currently only line-delimited JSON is supported as a generic carrier. */
  lineFormat: 'jsonl';
  /** Optional path to a per-event timestamp; falls back to a provided default. */
  timestampPaths?: string[][];
  /** Ordered rules; the first whose conditions all hold wins for an event. */
  events: StreamEventRule[];
}

/** A spec that emits nothing — used when a participant has no parse spec yet. */
export const EMPTY_STREAM_PARSE_SPEC: StreamParseSpec = { lineFormat: 'jsonl', events: [] };

// ---------------------------------------------------------------------------
// SHARED JSON HELPERS (single source of truth — imported by run-live-chat-turn)
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Flatten a string | {text|content} | array-of-those into one string. */
export function firstText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .map(firstText)
      .filter((part): part is string => part !== null && part.trim().length > 0);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return firstText(record.text) ?? firstText(record.content) ?? null;
}

/** Coerce arbitrary tool-argument values into a params record. */
export function parseToolInput(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (record) return record;
  if (Array.isArray(value)) return { value };
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      const parsedRecord = asRecord(parsed);
      if (parsedRecord) return parsedRecord;
      return { value: parsed };
    } catch {
      return { raw: value };
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// THE GENERIC INTERPRETER
// ---------------------------------------------------------------------------

function conditionHolds(event: unknown, cond: StreamMatchCondition): boolean {
  const value = readPath(event, cond.path);
  if (cond.exists === true && (value === undefined || value === null)) return false;
  if (cond.exists === false && value !== undefined && value !== null) return false;
  if (cond.equals !== undefined && value !== cond.equals) return false;
  return true;
}

function readFirstText(event: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const text = firstText(readPath(event, path));
    if (text && text.trim()) return text;
  }
  return null;
}

function eventTimestamp(event: unknown, spec: StreamParseSpec, fallback: string): string {
  for (const path of spec.timestampPaths ?? []) {
    const ts = asString(readPath(event, path));
    if (ts) return ts;
  }
  return fallback;
}

function upsertText(
  messages: AgentMessage[],
  indexBySourceId: Map<string, number>,
  emit: StreamEmitText,
  content: string,
  timestamp: string,
  sourceId: string | null,
): void {
  const role = emit.role ?? 'assistant';
  if (sourceId) {
    const existing = indexBySourceId.get(sourceId);
    if (existing !== undefined) {
      messages[existing] = { ...messages[existing], content, timestamp };
      return;
    }
  }
  messages.push({
    id: sourceId ? `live-${emit.kind}:${sourceId}` : `live-${emit.kind}:${messages.length}:${timestamp}`,
    type: emit.kind,
    content,
    role,
    timestamp,
  });
  if (sourceId) indexBySourceId.set(sourceId, messages.length - 1);
}

function appendToolUse(
  messages: AgentMessage[],
  toolIndexById: Map<string, number>,
  event: unknown,
  emit: StreamEmitToolUse,
  timestamp: string,
): void {
  const tool = asString(readPath(event, emit.namePath)) ?? 'Tool';
  const id = emit.idPath ? asString(readPath(event, emit.idPath)) : null;
  const params = emit.argsPath ? parseToolInput(readPath(event, emit.argsPath)) : {};
  const content = Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : tool;
  messages.push({
    id: id ? `live-tool:${id}` : `live-tool:${messages.length}:${timestamp}`,
    type: 'tool_use',
    content,
    role: 'assistant',
    timestamp,
    toolUse: { ...(id ? { id } : {}), tool, params },
  });
  if (id) toolIndexById.set(id, messages.length - 1);
}

function appendToolResult(
  messages: AgentMessage[],
  toolIndexById: Map<string, number>,
  event: unknown,
  emit: StreamEmitToolResult,
  timestamp: string,
): void {
  const id = emit.idPath ? asString(readPath(event, emit.idPath)) : null;
  const rawOutput = readPath(event, emit.outputPath);
  const result = firstText(rawOutput)
    ?? (rawOutput === undefined ? '' : JSON.stringify(rawOutput));

  if (id) {
    const existing = toolIndexById.get(id);
    if (existing !== undefined && messages[existing]?.toolUse) {
      messages[existing] = {
        ...messages[existing],
        timestamp,
        toolUse: { ...messages[existing].toolUse!, result },
      };
      return;
    }
  }
  messages.push({
    id: id ? `live-tool-result:${id}` : `live-tool-result:${messages.length}:${timestamp}`,
    type: 'tool_result',
    content: result,
    role: 'assistant',
    timestamp,
    toolUse: { ...(id ? { id } : {}), tool: 'Tool', params: {}, result },
  });
}

/**
 * Turn a participant's raw JSONL stream into normalized AgentMessage[] using only
 * the participant-supplied StreamParseSpec data. Knows no agent or format names.
 */
export function interpretStream(
  outputText: string,
  spec: StreamParseSpec,
  fallbackTimestamp: string,
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const textIndexBySourceId = new Map<string, number>();
  const toolIndexById = new Map<string, number>();

  for (const line of outputText.split('\n')) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Raw display bytes may include non-JSON terminal output; skip silently.
      continue;
    }

    const rule = spec.events.find((candidate) => candidate.when.every((cond) => conditionHolds(event, cond)));
    if (!rule) continue;

    const timestamp = eventTimestamp(event, spec, fallbackTimestamp);
    const emit = rule.emit;

    if (emit.kind === 'tool_use') {
      appendToolUse(messages, toolIndexById, event, emit, timestamp);
      continue;
    }
    if (emit.kind === 'tool_result') {
      appendToolResult(messages, toolIndexById, event, emit, timestamp);
      continue;
    }
    // text | thinking | status | error
    const content = readFirstText(event, emit.textPaths);
    if (content && content.trim()) {
      const sourceId = emit.sourceIdPath ? asString(readPath(event, emit.sourceIdPath)) : null;
      upsertText(messages, textIndexBySourceId, emit, content.trim(), timestamp, sourceId);
    }
  }

  return messages;
}
