// PORTED FROM: bitfield-packages/packages/chat/show/initial-source-keys.ts @ e99ac5976
// packages/chat/show/initial-source-keys.ts
//
// Pure helper: derive the chat surface's INITIAL selected-source set from the
// host-supplied `surfaceInput` DATA. Extracted to its own leaf module (no React,
// no data hooks) so it is unit-testable without importing the whole ChatView.
//
// GENERIC (L090): `focusSource` is an opaque source key in the same key space
// the sources rail emits. `focusConversation` is an opaque conversation id.
// ChatView never enumerates a vendor or morning-specific conversation. Both are
// DATA carried by the embedding surface. Missing or malformed values fail open
// to the normal all-sources view with no selected conversation.

export function initialSourceKeys(surfaceInput?: Record<string, unknown>): Set<string> {
  const focus = focusSourceKey(surfaceInput);
  return focus ? new Set([focus]) : new Set();
}

/** Stable dependency key for a live embedding that changes its selected source. */
export function focusSourceKey(surfaceInput?: Record<string, unknown>): string {
  const focus = surfaceInput?.focusSource;
  return typeof focus === 'string' ? focus.trim() : '';
}

export function focusConversationKey(surfaceInput?: Record<string, unknown>): string {
  const value = surfaceInput?.focusConversation;
  return typeof value === 'string' ? value.trim() : '';
}
