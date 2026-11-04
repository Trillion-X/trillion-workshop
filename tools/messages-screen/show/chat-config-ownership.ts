// PORTED FROM: bitfield-packages/packages/chat/show/chat-config-ownership.ts @ e99ac5976
// chat-config-ownership.ts
//
// Pure ownership-arbitration policy for the chat provider/participant selection.
//
// PURPOSE
// -------
// A single predicate that answers one question: "is the provider/participant
// selection currently editable by the default-normalizer effect?" It is the ONE
// definition read by BOTH the provider picker UI and the default-participant
// normalizer effect in ChatView, so the two can never disagree about who owns
// `chatConfig` at any moment (SSOT).
//
// WHY THIS EXISTS AS A LEAF (L063 / L055)
// ---------------------------------------
// `chatConfig.participantRef` had two unarbitrated writers inside ChatView:
//   (A) the default-participant normalizer effect, which forces the ref to the
//       first cli-registry participant whenever the current ref is not a member
//       of the registry, and
//   (B) the active-session sync effect, which mirrors an OPEN conversation's
//       route ref into `chatConfig`.
// For a channel-routed conversation (telegram / whatsapp / discord / imessage /
// any future channel) the route ref is never a member of the cli registry, so
// with no ownership boundary the two effects fought every render — (A) reset the
// ref to a cli participant, (B) rewrote the channel ref — and React aborted the
// render loop (minified error #185, "Maximum update depth exceeded").
//
// The fix is ownership by mode: effect (A) is the sole writer ONLY while the
// selection is editable; once a conversation is open / a send is locked / a turn
// is processing, effect (B) (or the locked send) owns `chatConfig`. This policy
// is blind to channel identity — it names no channel and needs zero edits when a
// new channel or account is added as pure DATA.
//
// This module has zero runtime dependencies (pure function of its input) so the
// arbitration policy is independently unit-testable without mounting the 3k-line
// ChatView React tree.

/**
 * Returns true when the provider/participant selection is currently editable,
 * i.e. when the default-participant normalizer effect is allowed to own and
 * write `chatConfig`. Returns false the moment a conversation is open, a send is
 * locked to a pending conversation, or a turn is being processed — in those
 * states the active-session sync effect (or the locked send) owns `chatConfig`.
 */
export function canChangeChatProviderSelection(input: {
  activeSessionId: string | null;
  pendingConversationLedgerId: string | null;
  hasPendingConversation: boolean;
  isProcessing: boolean;
}): boolean {
  if (input.isProcessing) return false;
  if (input.activeSessionId) return false;
  if (input.hasPendingConversation && !input.pendingConversationLedgerId) return false;
  return true;
}

/**
 * Resolves the participant refs owned by an editable composer.
 *
 * An explicit address supplied by a containing surface is authoritative. It
 * either resolves to that exact available participant or fails closed to an
 * empty selection; it never falls through to a remembered/default participant.
 * Without an explicit address, supported current refs win, then the caller's
 * DATA-derived default.
 */
export function resolveEditableParticipantRefs(input: {
  availableParticipantRefs: readonly string[];
  currentParticipantRefs: readonly string[];
  explicitParticipantRef?: string | null;
  defaultParticipantRef?: string | null;
}): string[] {
  const available = new Set(input.availableParticipantRefs.filter(Boolean));
  const explicit = input.explicitParticipantRef?.trim() ?? '';
  if (explicit) return available.has(explicit) ? [explicit] : [];

  const current = Array.from(
    new Set(input.currentParticipantRefs.filter((ref) => available.has(ref))),
  );
  if (current.length > 0) return current;

  const fallback = input.defaultParticipantRef?.trim() ?? '';
  return fallback && available.has(fallback) ? [fallback] : [];
}
