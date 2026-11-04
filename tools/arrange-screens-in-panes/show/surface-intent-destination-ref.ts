/** One arrangement instance owns one browser-local opaque return address. */
export function createBrowserLocalDestinationRef(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `surface-intent:${crypto.randomUUID()}`
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return `surface-intent:${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  return `surface-intent:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
