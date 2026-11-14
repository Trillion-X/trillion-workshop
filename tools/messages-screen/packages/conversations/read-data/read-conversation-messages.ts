import {
  decodeGenericMessagePageProjection,
  type GenericMessagePageProjection,
  type ProjectionMessage,
} from './record-projection';

export type ConversationMessage = ProjectionMessage;
export type ConversationMessagePageProjection = GenericMessagePageProjection;

export function decodeConversationMessagePages(raw: unknown): ConversationMessagePageProjection {
  return decodeGenericMessagePageProjection(raw);
}
