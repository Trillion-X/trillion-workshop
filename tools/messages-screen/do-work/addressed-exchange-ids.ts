// parts/chat/do-work/addressed-exchange-ids.ts
// The ids a chat gives a new addressed exchange and each of its turns, made at once (before a send starts), apart from
// the writer (write-addressed-exchange-through-conversations.ts, which re-exports them) so the chat can name a turn
// without carrying the writer until it sends.

function randomId(prefix: string): string {
  const cryptoSource = globalThis.crypto;
  const value = cryptoSource && typeof cryptoSource.randomUUID === 'function'
    ? cryptoSource.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${value}`;
}

export function createChatAddressedExchangeConversationId(): string {
  return randomId('addressed-exchange');
}

export function createChatAddressedExchangeTurnId(): string {
  return randomId('addressed-exchange-turn');
}
