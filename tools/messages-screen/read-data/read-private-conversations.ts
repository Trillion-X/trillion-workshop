// PORTED FROM: bitfield-packages/packages/chat/read-data/read-private-conversations.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';
import { buildConversationProjections } from '../../conversations/read-data/build-conversation-projections';
import { mapConversationProjectionsToChat } from './map-conversation-projections-to-chat';

type Row = Record<string, unknown>;
type Sender = typeof sendRequestToBitfieldTarget;
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid conversation owner response');
  return value as Row;
}
export async function invokePrivateConversation(payload: Row, sender: Sender = sendRequestToBitfieldTarget): Promise<Row> {
  const response = await sender({ target: 'conversations.exchange', payload });
  let value: unknown = response;
  if (ArrayBuffer.isView(value)) value = JSON.parse(new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
  else if (value instanceof ArrayBuffer) value = JSON.parse(new TextDecoder().decode(value));
  else if (value && typeof value === 'object' && 'payload' in value) {
    const bytes = (value as { payload: unknown }).payload;
    if (ArrayBuffer.isView(bytes)) value = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
    else if (bytes instanceof ArrayBuffer) value = JSON.parse(new TextDecoder().decode(bytes));
  }
  const result = object(value);
  if (result.status !== 'accepted') throw new Error('Conversation owner did not accept the request');
  return result;
}

/** All content passes current session, consent and membership checks at its owner.
 * A scope switch cannot reuse a projection from another subject. */
export async function readPrivateConversations(subjectRef: string, sender: Sender = sendRequestToBitfieldTarget) {
  const listed = await invokePrivateConversation({ operation: 'list', subject_ref: subjectRef }, sender);
  if (!Array.isArray(listed.conversations)) throw new Error('Conversation list is unavailable');
  const conversations = listed.conversations.map(object);
  const turns: Row[] = []; const pages: Row[] = [];
  for (const conversation of conversations) {
    if (conversation.access_scope_ref !== subjectRef || typeof conversation.conversation_ref !== 'string') throw new Error('Conversation scope mismatch');
    let page: number | null = 0;
    const visited = new Set<number>();
    while (page !== null) {
      if (visited.has(page)) throw new Error('Conversation cursor repeated');
      visited.add(page);
      const result = await invokePrivateConversation({ operation: 'read', subject_ref: subjectRef, conversation_ref: conversation.conversation_ref, page }, sender);
      if (!Array.isArray(result.turns)) throw new Error('Conversation messages unavailable');
      const received = result.turns.map(object);
      if (received.some((turn) => turn.conversation_ref !== conversation.conversation_ref)) throw new Error('Conversation turn scope mismatch');
      turns.push(...received);
      const ownerPage = object(result.page);
      if (ownerPage.message_page_ref) pages.push(ownerPage);
      if (result.next_page !== null && (!Number.isSafeInteger(result.next_page) || Number(result.next_page) <= page)) throw new Error('Invalid conversation cursor');
      page = result.next_page as number | null;
    }
  }
  const current = await invokePrivateConversation({ operation: 'list', subject_ref: subjectRef }, sender);
  if (!Array.isArray(current.conversations)) throw new Error('Conversation access could not be rechecked');
  const allowed = new Set(current.conversations.map((entry) => object(entry).conversation_ref));
  if (conversations.some((conversation) => !allowed.has(conversation.conversation_ref))) throw new Error('Conversation access changed during read');
  const projection = buildConversationProjections(conversations, turns, pages);
  return { ...mapConversationProjectionsToChat(projection.recordList, projection.messagePages), ...projection,
    unreadByConversation: Object.fromEntries(conversations.map((conversation) => [String(conversation.conversation_ref), Number(conversation.unread_count ?? 0)])) };
}
