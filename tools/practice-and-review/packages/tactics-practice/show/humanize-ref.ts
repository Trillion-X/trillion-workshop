// Package-local display helper for tactics-practice show surfaces.
//
// Player/participant records in this package carry reference strings (playerRef,
// voterId, subjectRef, winnerRef) but no separate display-name field. The
// translation-boundary rule forbids dumping a raw technical id into customer
// copy. This helper formats whatever real reference exists into a human label —
// it never fabricates an identity, it only reshapes the real token:
//   "player:ada-lovelace" -> "Ada Lovelace"
//   "person_ben_okri"      -> "Ben Okri"
// When a caller can resolve a true display name (e.g. from a profile), it should
// pass its own resolver; this is the no-fabrication fallback.

const PREFIX = /^[a-z][a-z0-9]*[:#/]/i;
const OPAQUE = /^[0-9a-f]{8,}$/i;

export function humanizeRef(ref: string | undefined | null): string {
  if (!ref) return 'Unknown player';
  const stripped = ref.replace(PREFIX, '');
  const token = stripped.length > 0 ? stripped : ref;
  // A bare opaque hash carries no human meaning; show a stable short tag rather
  // than leaking the full raw id into customer-facing copy.
  if (OPAQUE.test(token)) return `Player ${token.slice(0, 4).toUpperCase()}`;
  const words = token
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)));
  return words.length > 0 ? words.join(' ') : 'Unknown player';
}

export type NameResolver = (ref: string) => string | undefined;

export function displayName(ref: string | undefined | null, resolver?: NameResolver): string {
  if (ref && resolver) {
    const resolved = resolver(ref);
    if (resolved && resolved.trim().length > 0) return resolved.trim();
  }
  return humanizeRef(ref);
}
