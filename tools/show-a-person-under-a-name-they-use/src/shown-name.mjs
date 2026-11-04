// src/shown-name.mjs
//
// PURPOSE
//   The one answer to "what may a person be called where others see them": a name is words the person uses, never a
//   way to reach them. An email address or a phone number is a contact detail, released only by src/network.mjs's
//   live contact check, so it is never shown as anyone's name, even when it is what an account was named with.
//
// NON-NEGOTIABLE INVARIANTS
//   1. `usableName` answers a trimmed name of at most 80 characters, or null: empty, not words, or a contact detail.
//   2. `CONTACT` is the one pattern for a contact detail in words; nothing else in Trillion keeps its own.
//

/** An email address or a phone number anywhere in the words. */
export const CONTACT = /[^@\s]+@[^@\s]+\.[^@\s]+|\+?\d[\d\s().-]{7,}\d/;

/** A name that may be shown to other people, or null. */
export function usableName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ').slice(0, 80);
  return name && !CONTACT.test(name) ? name : null;
}
