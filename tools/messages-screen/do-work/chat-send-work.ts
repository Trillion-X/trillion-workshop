// parts/chat/do-work/chat-send-work.ts
// The chat's send road, as one module the chat fetches when the person first sends (and when the chat is idle):
// dispatching an addressed message, writing the exchange through conversations, the agentic tool round, capability
// discovery for it, the producer turn, a participant's setup form and a reaction's intent. Opening a conversation never waits on any of it.

export {
  dispatchAddressedMessage,
  readAddressedMessageDispatch,
  readAnswerFromRoute,
} from './dispatch-addressed-message';
export {
  canonicalChatMessagesToAddressedExchangeTurnDrafts,
  mergeAddressedExchangeTurnDrafts,
  writeAddressedExchangeThroughConversations,
} from './write-addressed-exchange-through-conversations';
export { advanceChatToolRoundWithPolicy } from './advance-chat-tool-round';
export { discoverCapabilitiesForChatWithBinding } from './discover-capabilities';
export { submitChatTurnViaProducer, chatTurnSubmissionForRequest } from './submit-chat-turn-via-producer';
export { submitConnectAction } from './submit-connect-action';
export { submitMessageIntentFromChat, viewerIntentFailure } from './submit-message-intent-from-chat';
