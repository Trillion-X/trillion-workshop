// PORTED FROM: bitfield-packages/packages/chat/read-data/read-chat-sessions.ts @ e99ac5976
// packages/chat/read-data/read-chat-sessions.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Chat-owned session view/configuration contracts. Runtime process truth still
// comes from addressed session feeds; this file reads only the public
// `chat-sessions` addressed feed named in the blind-surface plan.
//
// =============================================================================

const MISSING_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/** Token and cost accounting for a session. */
export interface SessionUsage {
  /** Total input tokens consumed */
  inputTokens: number;
  /** Total output tokens consumed */
  outputTokens: number;
  /** Estimated cost in USD */
  cost: number;
}

/** A live chat session with an addressed exchange participant. */
export interface ChatSession {
  /** Unique session identifier */
  id: string;
  /** Which participant route owns this session */
  participantRef: string;
  /** Current lifecycle status */
  status: 'starting' | 'active' | 'idle' | 'stopped' | 'error';
  /** ISO-8601 timestamp when the session started */
  startedAt: string;
  /** Project this session belongs to */
  projectId: string;
  /** Worktree path if running in isolation */
  worktreePath?: string;
  /** Cumulative token and cost usage */
  usage: SessionUsage;
}

/** Pre-session configuration for chat: selects participant route, account, and model. */
export interface ChatSessionConfig {
  /** Selected participant routes for this session. */
  participantRefs: string[];
  /** First selected participant route, retained for transition/back-compat reads. */
  participantRef: string;
  /** Which account to use. */
  accountId: string;
  /** Which model to use (null = participant route default). */
  model: string | null;
}

/**
 * Self-describing outbound routing object a sendable source declares (e.g.
 * iMessage). The composer forwards it verbatim to the egress front door and
 * NEVER parses the fields. Absent on read-only threads (AI/agent sessions,
 * group threads with no single recipient).
 */
export interface ConversationSendCapability {
  /** Egress action id the composer dispatches (e.g. action:submit-message-egress). */
  frontDoorAction: string;
  /** Channel the transport routes to (e.g. macos-messages). */
  channel: string;
  /** Destination/transport config id the egress spine resolves. */
  destinationId: string;
}

export interface ChatConversationRecord {
  recordId: string;
  sessionId: string;
  agentId?: string | null;
  participantRefs: string[];
  participantRef: string;
  wayRefs: string[];
  serviceConnectionRefs: string[];
  /** Source adapter ref retained for older transcript feeds that still publish adapter-specific names. */
  legacySourceAdapterRef: string;
  model?: string | null;
  slug?: string | null;
  prompt?: string | null;
  accountDir?: string;
  filePath?: string;
  fileModifiedAt?: string;
  projectSlug: string;
  projectName: string | null;
  projectPath?: string;
  title: string | null;
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
  fileSizeBytes?: number;
  sourcePresent?: boolean;
  lastMessagePreview?: string | null;
  lastMessageRole?: 'human' | 'assistant' | null;
  /**
   * Present only when this thread can send an outbound reply: the source
   * declared a send capability AND the decoder resolved a single-recipient
   * handle. The composer treats presence as the sole "sendable" discriminant.
   */
  sendCapability?: ConversationSendCapability | null;
  /** Resolved recipient buddy handle (e.g. iMessage phone/email); opaque. */
  sendRef?: string | null;
  /**
   * Present only when this thread's source declares reactions can EGRESS (a real
   * tapback back to the channel). Absent for text-only sources like iMessage —
   * an authored reaction is then the viewer's OWN durable annotation and never
   * claims delivery (fail-closed egress, parallel to sendCapability). Same
   * {frontDoorAction, channel, destinationId} shape; opaque, never interpreted.
   */
  reactCapability?: ConversationSendCapability | null;
}

export interface ActiveChatSessionWindowPayload {
  version: number;
  window_key: string;
  limit: number;
  total_count: number;
  total_count_known: boolean;
  rows: ChatConversationRecord[];
  has_older: boolean;
  conversation_page_cursor: ChatConversationPageCursor | null;
  conversation_page_error: boolean;
}

export interface ChatConversationPageCursor {
  content_hash: string;
  offset: number;
}

export function decodeConversationPageCursor(raw: unknown): ChatConversationPageCursor | null {
  if (raw == null) return null;
  if (!isRecord(raw) || typeof raw.content_hash !== 'string'
    || !/^1f:[0-9a-f]{64}$/.test(raw.content_hash)
    || !Number.isSafeInteger(raw.offset) || (raw.offset as number) < 0) {
    throw new Error('Older conversations could not be loaded.');
  }
  return { content_hash: raw.content_hash, offset: raw.offset as number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' ? value : undefined;
}

function readNullableString(row: Record<string, unknown>, key: string): string | null {
  return readString(row, key) ?? null;
}

function readStringArray(row: Record<string, unknown>, key: string): string[] {
  const value = row[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }
  return [];
}

function readNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readBoolean(row: Record<string, unknown>, key: string): boolean | undefined {
  const value = row[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

/**
 * Decode the opaque send-capability object (materialize row carries snake_case
 * keys straight from the source's declared send_capability_ref). Returns null
 * unless ALL THREE routing fields are present non-empty strings — a partial
 * capability is not sendable (fail closed). The reader validates shape only; it
 * never interprets the values.
 */
function readSendCapability(row: Record<string, unknown>): ConversationSendCapability | null {
  const value = row['sendCapability'] ?? row['send_capability_ref'] ?? row['send_capability'];
  if (!isRecord(value)) return null;
  const frontDoorAction = readString(value, 'frontDoorAction') ?? readString(value, 'front_door_action');
  const channel = readString(value, 'channel');
  const destinationId = readString(value, 'destinationId') ?? readString(value, 'destination_id');
  if (!frontDoorAction || !channel || !destinationId) return null;
  return { frontDoorAction, channel, destinationId };
}

/**
 * Decode the opaque react-capability object — identical shape/validation to
 * readSendCapability, on the source's declared react_capability_ref. Returns
 * null unless all three routing fields are present (fail closed): a thread with
 * no react capability keeps reactions as local-only durable annotations.
 */
function readReactCapability(row: Record<string, unknown>): ConversationSendCapability | null {
  const value = row['reactCapability'] ?? row['react_capability_ref'] ?? row['react_capability'];
  if (!isRecord(value)) return null;
  const frontDoorAction = readString(value, 'frontDoorAction') ?? readString(value, 'front_door_action');
  const channel = readString(value, 'channel');
  const destinationId = readString(value, 'destinationId') ?? readString(value, 'destination_id');
  if (!frontDoorAction || !channel || !destinationId) return null;
  return { frontDoorAction, channel, destinationId };
}

export function decodeChatSessionsFeed(raw: unknown): ChatConversationRecord[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const recordId = readString(entry, 'recordId');
    if (!recordId) return [];
    const startedAt = readString(entry, 'startedAt') ?? MISSING_TIMESTAMP;
    const participantRefs = [
      ...readStringArray(entry, 'participantRefs'),
      ...readStringArray(entry, 'participant_refs'),
      ...readStringArray(entry, 'participantRef'),
      ...readStringArray(entry, 'participant_ref'),
      // Window rows identify the conversation's route by executor/adapter ref —
      // those ARE participant refs in the unified route model (read routes and
      // write routes address the same subject). Without this, rows render no mark.
      ...readStringArray(entry, 'executorRef'),
      ...readStringArray(entry, 'executor_ref'),
      ...readStringArray(entry, 'sourceAdapterRef'),
      ...readStringArray(entry, 'source_adapter_ref'),
    ].filter((participantRef, index, refs) => refs.indexOf(participantRef) === index);
    const participantRef = participantRefs[0] ?? 'unknown';
    const wayRefs = [
      ...readStringArray(entry, 'wayRefs'),
      ...readStringArray(entry, 'way_refs'),
      ...readStringArray(entry, 'wayRef'),
      ...readStringArray(entry, 'way_ref'),
    ].filter((wayRef, index, refs) => refs.indexOf(wayRef) === index);
    const serviceConnectionRefs = [
      ...readStringArray(entry, 'serviceConnectionRefs'),
      ...readStringArray(entry, 'service_connection_refs'),
      ...readStringArray(entry, 'serviceConnectionRef'),
      ...readStringArray(entry, 'service_connection_ref'),
    ].filter((serviceConnectionRef, index, refs) => refs.indexOf(serviceConnectionRef) === index);
    return [{
      recordId,
      sessionId: readString(entry, 'sessionId') ?? recordId,
      agentId: readNullableString(entry, 'agentId'),
      participantRefs,
      participantRef,
      wayRefs,
      serviceConnectionRefs,
      legacySourceAdapterRef: readString(entry, 'sourceAdapterRef') ?? participantRef,
      model: readNullableString(entry, 'model'),
      slug: readNullableString(entry, 'slug'),
      prompt: readNullableString(entry, 'prompt'),
      accountDir: readString(entry, 'accountDir'),
      filePath: readString(entry, 'filePath'),
      fileModifiedAt: readString(entry, 'fileModifiedAt'),
      projectSlug: readString(entry, 'projectSlug') ?? '',
      projectName: readNullableString(entry, 'projectName'),
      projectPath: readString(entry, 'projectPath'),
      title: readNullableString(entry, 'title'),
      startedAt,
      lastActivityAt: readString(entry, 'lastActivityAt') ?? startedAt,
      messageCount: readNumber(entry, 'messageCount') ?? 0,
      fileSizeBytes: readNumber(entry, 'fileSizeBytes'),
      sourcePresent: readBoolean(entry, 'sourcePresent'),
      // Feed rows carry no transcript tail, but they DO carry the session's
      // opening prompt — use it so untitled sessions show their real ask
      // instead of a placeholder (translation boundary: no raw ids on screen).
      lastMessagePreview: readNullableString(entry, 'lastMessagePreview')
        ?? readNullableString(entry, 'prompt'),
      lastMessageRole: readNullableString(entry, 'lastMessageRole') as ChatConversationRecord['lastMessageRole'] ?? (readNullableString(entry, 'prompt') ? 'human' : null),
      sendCapability: readSendCapability(entry),
      sendRef: readNullableString(entry, 'sendRef') ?? readNullableString(entry, 'send_ref'),
      reactCapability: readReactCapability(entry),
    }];
  });
}

export function decodeActiveChatSessionWindowPayload(raw: unknown): ActiveChatSessionWindowPayload {
  if (!isRecord(raw)) {
    return {
      version: 1,
      window_key: 'latest',
      limit: 0,
      total_count: 0,
      total_count_known: false,
      rows: [],
      has_older: false,
      conversation_page_cursor: null,
      conversation_page_error: false,
    };
  }

  const rows = decodeChatSessionsFeed(Array.isArray(raw.rows) ? raw.rows : []);
  let conversationPageCursor: ChatConversationPageCursor | null = null;
  let conversationPageError = false;
  try { conversationPageCursor = decodeConversationPageCursor(raw.conversation_page_cursor); }
  catch { conversationPageError = true; }
  return {
    version: readNumber(raw, 'version') ?? 1,
    window_key: readString(raw, 'window_key') ?? 'latest',
    limit: readNumber(raw, 'limit') ?? rows.length,
    total_count: readNumber(raw, 'total_count') ?? rows.length,
    total_count_known: readBoolean(raw, 'total_count_known') === true,
    rows,
    has_older: readBoolean(raw, 'has_older') === true,
    conversation_page_cursor: conversationPageCursor,
    conversation_page_error: conversationPageError,
  };
}
