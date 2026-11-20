// Which kept messages can let an AI read the person's saved logins. Pure: a message record in, a refusal key or null
// out. Ported from the older Workshop copy of src/saved-logins.mjs (grantRefusal, capturedByVerifiedRoad; commit b6ae0ebf81).
import settings from './saved-logins.json' with { type: 'json' };

const squeezed = value => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Whether a kept message was captured by a road only the person's own typing can use, never written by an AI.
 * The message store sets captured_road on every message it keeps (src/messages.mjs record), from how the words came in
 * and never from the sender; settings.grant_verified_roads names the roads that count. A message kept before that field
 * existed has none: it counts only when nothing marks it as sent by an AI app (no recorded_by, no recorded_app), which
 * every AI-callable road has always added and the transcript hook's road (/inbound) has never added.
 */
export function capturedByVerifiedRoad(message) {
  if (typeof message?.captured_road === 'string') return settings.grant_verified_roads.includes(message.captured_road);
  return !message?.recorded_by && !message?.recorded_app;
}

/** Whether `message` (a kept message record) is the person's own and holds `quote` word for word. → null or the refusal key. */
export function grantRefusal(message, quote) {
  if (!message || message.speaker !== 'person') return 'grant_not_person';
  if (message.source_provenance?.valid === false) return 'grant_not_person';
  if (!capturedByVerifiedRoad(message)) return 'grant_not_captured';
  const words = squeezed(quote);
  if (words.split(' ').length < settings.grant_quote_min_words) return 'grant_quote_short';
  if (!squeezed(message.text).includes(words)) return 'grant_quote_missing';
  return null;
}
