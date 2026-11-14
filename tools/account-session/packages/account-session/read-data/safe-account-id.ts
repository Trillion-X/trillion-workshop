export function safeAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const accountId = value.trim();
  if (!accountId || accountId.length > 240) return null;
  if (!/^[a-zA-Z0-9:._-]+$/.test(accountId)) return null;
  return accountId;
}
