// PORTED FROM: bitfield-packages/packages/chat/do-work/read-chat-conversation-page.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';
import { decodeChatSessionsFeed, decodeConversationPageCursor,
  type ChatConversationPageCursor, type ChatConversationRecord,
} from '../read-data/read-chat-sessions';

export interface ChatConversationPage {
  rows: ChatConversationRecord[];
  next_cursor: ChatConversationPageCursor | null;
  has_more: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || (ArrayBuffer.isView(value) && value.constructor.name === 'Uint8Array');
}

export function readChatConversationPageFromReply(reply: unknown): ChatConversationPage {
  const fail = () => new Error('Older conversations could not be loaded. Try again.');
  if (!record(reply) || !bytes(reply.payload) || reply.payload.byteLength > 2 * 1024 * 1024) throw fail();
  const result: unknown = JSON.parse(new TextDecoder().decode(reply.payload));
  if (!record(result) || result.status !== 'completed' || !record(result.output)) throw fail();
  const page = result.output;
  if (!Array.isArray(page.rows) || page.rows.length > 64 || typeof page.has_more !== 'boolean'
    || !Object.prototype.hasOwnProperty.call(page, 'next_cursor')) throw fail();
  const next = decodeConversationPageCursor(page.next_cursor);
  if (page.has_more !== Boolean(next)) throw fail();
  const rows = decodeChatSessionsFeed(page.rows);
  if (rows.length !== page.rows.length) throw fail();
  return { rows, next_cursor: next, has_more: page.has_more };
}

export async function readChatConversationPage(cursor: ChatConversationPageCursor, signal?: AbortSignal): Promise<ChatConversationPage> {
  const validated = decodeConversationPageCursor(cursor);
  if (!validated) throw new Error('Older conversations could not be loaded.');
  const reply = await sendRequestToBitfieldTarget({ target: 'slot::workflow', payload: {
    operation: 'execute_definition', definition_id: 'action:read-chat-conversation-page',
    include_steps: false, include_output: true, input: { cursor: validated, limit: 64 },
  } }, signal);
  return readChatConversationPageFromReply(reply);
}
