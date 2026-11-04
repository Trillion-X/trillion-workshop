// PORTED FROM: bitfield-packages/packages/chat/do-work/read-chat-transcript-page.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';
import type { TranscriptLine } from '../read-data/read-session-transcripts';

const READ_CHAT_TRANSCRIPT_PAGE_ACTION = 'action:read-chat-session-transcript-page';
const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 256;

export interface ChatTranscriptPage {
  version: number;
  start_index: number | null;
  requested_start_index: number | null;
  limit: number;
  total_count: number | null;
  total_count_known: boolean;
  lines: TranscriptLine[];
  has_older: boolean;
  has_newer: boolean;
  older_cursor?: TranscriptRangeCursor | number | null;
  file_path?: string;
  project_path?: string | null;
  file_size_bytes?: number | null;
  file_modified_at?: string | null;
  started_at?: string | null;
  last_activity_at?: string | null;
}

export interface TranscriptRangeCursor {
  version: 1;
  path: string;
  revision: string;
  total_length: number;
  before_offset: number;
}

export interface ReadChatTranscriptPageInput {
  sessionId?: string | null;
  filePath: string;
  startIndex?: number;
  limit?: number;
  beforeByteOffset?: TranscriptRangeCursor | number | null;
  /** Leave a selected historical window and read the current end of its conversation. */
  showLatest?: boolean;
}

const textDecoder = new TextDecoder();

/** The owner published the page; its per-session subscription supplies the data. */
export class TranscriptPagePublishedError extends Error {
  constructor() {
    super('Transcript page was published to its session window');
    this.name = 'TranscriptPagePublishedError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRangeCursor(value: unknown): TranscriptRangeCursor | null {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.path !== 'string' || value.path.length === 0
    || typeof value.revision !== 'string' || value.revision.length === 0
    || !Number.isSafeInteger(value.total_length) || Number(value.total_length) < 0
    || !Number.isSafeInteger(value.before_offset) || Number(value.before_offset) < 0
    || Number(value.before_offset) > Number(value.total_length)) return null;
  return value as unknown as TranscriptRangeCursor;
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
    || (ArrayBuffer.isView(value) && value.constructor.name === 'Uint8Array');
}

function decodeReplyPayload(reply: unknown): Record<string, unknown> {
  if (!isRecord(reply) || !isBytes(reply.payload)) {
    throw new Error('Transcript page reply did not contain envelope payload bytes');
  }
  const text = textDecoder.decode(reply.payload).trim();
  if (!text) throw new Error('Transcript page reply payload was empty');
  const decoded = JSON.parse(text) as unknown;
  if (!isRecord(decoded)) throw new Error('Transcript page reply payload was not an object');
  return decoded;
}

function readTranscriptPageShape(value: unknown): ChatTranscriptPage | null {
  if (!isRecord(value) || !Array.isArray(value.lines)) return null;

  return {
    version: typeof value.version === 'number' ? value.version : 1,
    start_index: typeof value.start_index === 'number' ? value.start_index : null,
    requested_start_index: typeof value.requested_start_index === 'number' ? value.requested_start_index : null,
    limit: typeof value.limit === 'number' ? value.limit : value.lines.length,
    total_count: typeof value.total_count === 'number' ? value.total_count : null,
    total_count_known: value.total_count_known === true,
    lines: value.lines as TranscriptLine[],
    has_older: value.has_older === true,
    has_newer: value.has_newer === true,
    older_cursor: readRangeCursor(value.older_cursor)
      ?? (typeof value.older_cursor === 'number' ? value.older_cursor : null),
    file_path: typeof value.file_path === 'string' ? value.file_path : undefined,
    project_path: typeof value.project_path === 'string' && value.project_path.length > 0 ? value.project_path : null,
    file_size_bytes: typeof value.file_size_bytes === 'number' ? value.file_size_bytes : null,
    file_modified_at: typeof value.file_modified_at === 'string' ? value.file_modified_at : null,
    started_at: typeof value.started_at === 'string' ? value.started_at : null,
    last_activity_at: typeof value.last_activity_at === 'string' ? value.last_activity_at : null,
  };
}

export function readChatTranscriptPageFromReply(reply: unknown): ChatTranscriptPage {
  const decoded = decodeReplyPayload(reply);
  const page = readTranscriptPageShape(decoded.output);
  if (!page) {
    if (decoded.status === 'completed' && isRecord(decoded.output)
      && typeof decoded.output.writes_emitted === 'number' && decoded.output.writes_emitted > 0) {
      throw new TranscriptPagePublishedError();
    }
    throw new Error('Transcript page reply did not contain a transcript page');
  }
  return page;
}

export async function readChatTranscriptPage(
  input: ReadChatTranscriptPageInput,
  signal?: AbortSignal,
): Promise<ChatTranscriptPage> {

  const reply = await sendRequestToBitfieldTarget({
      target: 'slot::workflow',
      payload: {
        operation: 'execute_definition',
        definition_id: READ_CHAT_TRANSCRIPT_PAGE_ACTION,
        include_steps: false,
        include_output: true,
        input: {
          session_id: input.sessionId ?? null,
          file_path: input.filePath,
          start_index: input.startIndex ?? -1,
          limit: input.limit ?? DEFAULT_TRANSCRIPT_PAGE_LIMIT,
          before_byte_offset: input.beforeByteOffset ?? null,
          ...(input.showLatest ? { show_latest: true } : {}),
        },
      },
    },
    signal,
  );

  return readChatTranscriptPageFromReply(reply);
}
