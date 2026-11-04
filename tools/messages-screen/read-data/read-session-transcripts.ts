// PORTED FROM: bitfield-packages/packages/chat/read-data/read-session-transcripts.ts @ e99ac5976
// bitfield-studio/frontends/web/src/packages/chat/read-data/read-session-transcripts.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure transcript decoding for chat surfaces. Owns the canonical conversion
// from scanned transcript JSON into `AgentMessage[]`.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure decode/transform only — no React, no store, no connection access
// 2. Accepts the scanner-owned transcript JSON shape
// 3. Pairs tool_use / tool_result rows by toolUseId when present
// 4. Preserves teammate message derivation from transcript content
//
// =============================================================================

import type { AgentMessage, AgentMessageType, MessageStateEvent, MessageReaction } from './chat-message-types';
import {
  isCompactionSummaryContent,
  isTeammateMessage,
  parseTeammateMessage,
} from './compaction-detection';

export interface ChatConversationTranscriptRecord {
  transcript_id?: string;
  session_id: string;
  transcript_content?: string;
  transcript_content_address?: string;
  transcript_content_hash?: string;
  transcript_content_byte_len?: number;
  transcript_content_storage?: string;
  message_count?: number;
  created_at?: string;
}

export interface TranscriptLine {
  type?: string;
  content?: string;
  timestamp?: string;
  toolName?: string;
  role?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    [key: string]: unknown;
  };
  hookEvent?: string;
  hookName?: string;
  /** Message-state envelope (materialize-transcript.py attaches these). */
  atomRef?: string;
  nativeRef?: string;
  stateEvents?: MessageStateEvent[];
  reactions?: MessageReaction[];
  /** Trillion: what the line names (`{ kind, value, label }`), drawn as live record chips. */
  mentions?: { kind: string; value: string; label: string }[];
  /** Who said the line, when it is someone other than the viewer or the conversation's own AI. */
  author?: string;
  /** Trillion files attached to a kept message, with their private byte route. */
  files?: { key: string; name: string; url: string; contentType: string }[];
  /** The links written in the line, each with its card once read. */
  links?: { url: string; state: 'pending' | 'ready' | 'failed'; card?: Record<string, string> }[];
}

export interface ActiveChatMessageWindowPayload {
  version: number;
  session_id: string | null;
  window_key: string;
  start_index: number | null;
  requested_start_index: number | null;
  limit: number;
  total_count: number | null;
  total_count_known: boolean;
  lines: TranscriptLine[];
  has_older: boolean;
  has_newer: boolean;
  older_cursor?: {version: 1; path: string; revision: string; total_length: number; before_offset: number} | number | null;
  file_path?: string;
  project_path?: string | null;
  file_size_bytes?: number | null;
  file_modified_at?: string | null;
  started_at?: string | null;
  last_activity_at?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function decodeSessionTranscriptsFeed(raw: unknown): ChatConversationTranscriptRecord[] {
  if (!Array.isArray(raw)) return [];

  const grouped = new Map<string, ChatConversationTranscriptRecord>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const row = entry as Record<string, unknown>;
    const subjectId = typeof row.subject_id === 'string' ? row.subject_id : null;
    const propertyId = typeof row.property_id === 'string' ? row.property_id : null;
    if (!subjectId || !propertyId) continue;

    const current = grouped.get(subjectId) ?? { transcript_id: subjectId, session_id: '', message_count: 0 };

    if (propertyId === 'prop:session_transcript:session_id' && typeof row.value === 'string') {
      current.session_id = row.value;
    } else if (propertyId === 'prop:session_transcript:transcript_content' && typeof row.value === 'string') {
      current.transcript_content = row.value;
    } else if (propertyId === 'prop:session_transcript:transcript_content_address' && typeof row.value === 'string') {
      current.transcript_content_address = row.value;
    } else if (propertyId === 'prop:session_transcript:transcript_content_hash' && typeof row.value === 'string') {
      current.transcript_content_hash = row.value;
    } else if (propertyId === 'prop:session_transcript:transcript_content_byte_len') {
      current.transcript_content_byte_len = coerceNumber(row.value);
    } else if (propertyId === 'prop:session_transcript:transcript_content_storage' && typeof row.value === 'string') {
      current.transcript_content_storage = row.value;
    } else if (propertyId === 'prop:session_transcript:message_count') {
      current.message_count = coerceNumber(row.value) ?? 0;
    } else if (propertyId === 'prop:session_transcript:created_at' && typeof row.value === 'string') {
      current.created_at = row.value;
    }

    grouped.set(subjectId, current);
  }

  return Array.from(grouped.values());
}

export function decodeActiveChatMessageWindowPayload(raw: unknown): ActiveChatMessageWindowPayload | null {
  if (!isRecord(raw) || !Array.isArray(raw.lines)) return null;

  return {
    version: coerceNumber(raw.version) ?? 1,
    session_id: typeof raw.session_id === 'string' && raw.session_id.length > 0 ? raw.session_id : null,
    window_key: typeof raw.window_key === 'string' && raw.window_key.length > 0 ? raw.window_key : 'latest',
    start_index: coerceNumber(raw.start_index) ?? null,
    requested_start_index: coerceNumber(raw.requested_start_index) ?? null,
    limit: coerceNumber(raw.limit) ?? raw.lines.length,
    total_count: coerceNumber(raw.total_count) ?? null,
    total_count_known: raw.total_count_known === true,
    lines: raw.lines as TranscriptLine[],
    has_older: raw.has_older === true,
    has_newer: raw.has_newer === true,
    older_cursor: (
      isRecord(raw.older_cursor)
      && raw.older_cursor.version === 1
      && typeof raw.older_cursor.path === 'string' && raw.older_cursor.path.length > 0
      && typeof raw.older_cursor.revision === 'string' && raw.older_cursor.revision.length > 0
      && Number.isSafeInteger(raw.older_cursor.total_length) && Number(raw.older_cursor.total_length) >= 0
      && Number.isSafeInteger(raw.older_cursor.before_offset) && Number(raw.older_cursor.before_offset) >= 0
      && Number(raw.older_cursor.before_offset) <= Number(raw.older_cursor.total_length)
    ) ? raw.older_cursor as ActiveChatMessageWindowPayload['older_cursor'] : coerceNumber(raw.older_cursor) ?? null,
    file_path: typeof raw.file_path === 'string' ? raw.file_path : undefined,
    project_path: typeof raw.project_path === 'string' && raw.project_path.length > 0 ? raw.project_path : null,
    file_size_bytes: coerceNumber(raw.file_size_bytes) ?? null,
    file_modified_at: typeof raw.file_modified_at === 'string' ? raw.file_modified_at : null,
    started_at: typeof raw.started_at === 'string' ? raw.started_at : null,
    last_activity_at: typeof raw.last_activity_at === 'string' ? raw.last_activity_at : null,
  };
}

export function normalizeTranscriptLines(parsed: unknown): TranscriptLine[] {
  if (Array.isArray(parsed)) return parsed as TranscriptLine[];
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)) {
    return (parsed as { data: TranscriptLine[] }).data;
  }
  return [];
}

export function transcriptLinesToAgentMessages(lines: TranscriptLine[]): AgentMessage[] {
  const mapped: AgentMessage[] = [];
  const toolUseIndexById = new Map<string, number>();
  const toolMetaById = new Map<string, { tool: string; params: Record<string, unknown> }>();

  for (const line of lines) {
    const msgType: AgentMessageType =
      line.type === 'tool_use' ? 'tool_use'
        : line.type === 'tool_result' ? 'tool_result'
          : line.type === 'thinking' ? 'thinking'
            : line.type === 'error' ? 'error'
              : line.type === 'status' ? 'status'
                : 'text';

    const content = typeof line.content === 'string' ? line.content : '';
    const isCompactionSummary = isCompactionSummaryContent(content);
    const teammateMsg = (line.role === 'human' || line.type === 'user') && isTeammateMessage(content)
      ? parseTeammateMessage(content)
      : null;

    const role: 'human' | 'assistant' | undefined =
      isCompactionSummary ? 'assistant'
        : teammateMsg ? 'assistant'
          : line.role === 'human' || line.type === 'user' ? 'human'
            : line.role === 'assistant' || line.type === 'assistant' ? 'assistant'
              : msgType === 'tool_use' || msgType === 'tool_result' ? 'assistant'
                : undefined;

    const timestamp = line.timestamp ?? new Date().toISOString();
    const messageId = `${msgType}:${mapped.length}:${timestamp}`;

    // The message-state envelope threaded from the materializer (atom subject id,
    // native subject id, lifecycle stream, current reactions). Blind passthrough —
    // this converter never inspects a key or symbol; the surface maps them via DATA.
    const envelope: Partial<AgentMessage> = {
      ...(line.atomRef !== undefined && { atomRef: line.atomRef }),
      ...(line.nativeRef !== undefined && { nativeRef: line.nativeRef }),
      ...(line.stateEvents && line.stateEvents.length > 0 && { stateEvents: line.stateEvents }),
      ...(line.reactions && line.reactions.length > 0 && { reactions: line.reactions }),
      ...(line.mentions && line.mentions.length > 0 && { mentions: line.mentions }),
      ...(line.author && { author: line.author }),
      ...(line.files && line.files.length > 0 && { files: line.files }),
      ...(line.links && line.links.length > 0 && { links: line.links }),
    };

    if (msgType === 'tool_use') {
      const toolUseId = typeof line.toolUseId === 'string' ? line.toolUseId : undefined;
      const toolName = line.toolName ?? 'Tool';
      const params = line.toolInput ?? {};

      mapped.push({
        id: messageId,
        type: 'tool_use',
        content: content || toolName,
        timestamp,
        role,
        toolUse: {
          ...(toolUseId && { id: toolUseId }),
          tool: toolName,
          params,
        },
      });

      if (toolUseId) {
        toolUseIndexById.set(toolUseId, mapped.length - 1);
        toolMetaById.set(toolUseId, { tool: toolName, params });
      }
      continue;
    }

    if (msgType === 'tool_result') {
      const toolUseId = typeof line.toolUseId === 'string' ? line.toolUseId : undefined;
      const existingIndex = toolUseId ? toolUseIndexById.get(toolUseId) : undefined;

      if (existingIndex !== undefined) {
        const existing = mapped[existingIndex];
        if (existing?.toolUse) {
          mapped[existingIndex] = {
            ...existing,
            timestamp,
            toolUse: {
              ...existing.toolUse,
              result: content,
            },
          };
          continue;
        }
      }

      const linkedMeta = toolUseId ? toolMetaById.get(toolUseId) : undefined;
      const toolName = line.toolName ?? linkedMeta?.tool ?? 'Tool';
      const params = line.toolInput ?? linkedMeta?.params ?? {};

      mapped.push({
        id: messageId,
        type: 'tool_result',
        content,
        timestamp,
        role,
        toolUse: {
          ...(toolUseId && { id: toolUseId }),
          tool: toolName,
          params,
          result: content,
        },
      });
      continue;
    }

    mapped.push({
      id: messageId,
      type: msgType,
      content: teammateMsg ? teammateMsg.content : content,
      timestamp,
      role,
      ...envelope,
      ...(teammateMsg && {
        teammate: {
          id: teammateMsg.id,
          color: teammateMsg.color,
          summary: teammateMsg.summary,
        },
      }),
    });
  }

  return mapped;
}

export function parseTranscriptMessages(rawTranscriptContent: string | undefined): AgentMessage[] {
  if (!rawTranscriptContent) return [];
  try {
    const parsed = JSON.parse(rawTranscriptContent);
    return transcriptLinesToAgentMessages(normalizeTranscriptLines(parsed));
  } catch {
    return [];
  }
}
