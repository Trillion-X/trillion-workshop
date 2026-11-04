// src/consent-fingerprint.mjs
//
// A yes counts for what the person was shown. Whatever asks a person to agree to meet someone shows them an
// introduction (shown) and, beside it, its consent: one BLAKE3 identity (src/typed-operation-contract.mjs identityOf)
// for each part of it, joined. The yes carries the consent back, and the owner of the introduction takes it only while
// the introduction it shows now has that same consent. Used by community introductions (src/community-matching.mjs
// answerMatch) and Network introduction requests (src/network-introduction-expiry.mjs).
//
// Non-negotiable invariants
//   1. The parts of an introduction are its words (text), the people it introduces (recipients), what of the person
//      the yes shares with them (shared), and when it ends unanswered (expires_at). Changing any one changes its consent.
//   2. A consent names its parts separately, so a refused yes says which part changed.
//   3. Key order never changes a consent: values are compared in canonical form.
import { identityOf } from '../../shared-code/src/typed-operation-contract.mjs';

/** The exact action an approval is for: one BLAKE3 identity over the tool, its version and its input. */
export const actionBinding = ({ tool_id, tool_version, input }) => identityOf({ tool_id, tool_version: tool_version ?? null, input: input ?? null });

const PARTS = ['text', 'recipients', 'shared', 'expires_at'];
// Parts an ask may add: `action`, the exact action a yes is for (actionBinding). It counts only when the ask carries it,
// written `name=identity` after the four, so an ask without it keeps exactly the consent it always had.
const OPTIONAL_PARTS = ['action'];
const named = shown => [...PARTS, ...OPTIONAL_PARTS.filter(part => shown[part] !== undefined && shown[part] !== null)];
const partsOf = shown => named(shown).map(part => {
  const identity = identityOf(shown[part] ?? null).slice(0, 32);
  return PARTS.includes(part) ? identity : `${part}=${identity}`;
});

/** The consent of an introduction as shown: { text, recipients, shared, expires_at } and the action it is bound to when it carries one. */
export const consentOf = shown => partsOf(shown).join('.');

/** The parts of the introduction shown now that differ from a consent given earlier; none while it still holds. */
export function changedSince(given, shown) {
  const was = typeof given === 'string' ? given.split('.') : [];
  const names = named(shown);
  const now = partsOf(shown);
  // The four base parts compare by position, the optional ones by name, so which optional parts are present never shifts another.
  const earlier = name => PARTS.includes(name) ? was[PARTS.indexOf(name)] : was.slice(PARTS.length).find(part => part.startsWith(`${name}=`));
  const changed = names.filter((name, index) => now[index] !== earlier(name));
  // An optional part the yes carried that the ask no longer shows is a change too.
  for (const name of OPTIONAL_PARTS) if (!names.includes(name) && earlier(name) !== undefined) changed.push(name);
  return changed;
}

/** Refuses a yes given for anything but the introduction shown now: 409, the parts that changed, and its consent now. */
export function refuseChangedConsent(given, shown, words) {
  const changed = changedSince(given, shown);
  if (changed.length) throw Object.assign(new Error(words), { status: 409, changed, consent: consentOf(shown) });
}
