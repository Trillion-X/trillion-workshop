// tools/invite-people-to-a-space-by-link-email-address/do-work/shown-name.mjs
//
// The names an invite may show: a member's name fit to read, and who is in the space as one line.
// Ported from the old source src/space-invitation.mjs at b6ae0ebf81 (shownName, peopleLine); the words are DATA in
// invitation-people-words.json.
import words from './invitation-people-words.json' with { type: 'json' };

const PLACE = /\{(\w+)\}/g;

/** A name fit to show: trimmed, never an email address, never the stand-in a space gives a nameless member. */
export function shownName(name) {
  const value = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!value || /@/.test(value) || /^Member \d+$/.test(value)) return null;
  return value.slice(0, 80);
}

/** Who is in the space, in one line: the names shown, and how many more there are. */
export function peopleLine(names, count) {
  const shown = names.map(shownName).filter(Boolean);
  if (!shown.length) return null;
  const [first, second, third] = shown;
  const named = count === 3 && third ? 3 : Math.min(shown.length, 2);
  const rest = Math.max(count - named, 0);
  const key = named === 3 ? 'three' : `${named === 1 ? 'one' : 'two'}${rest === 0 ? '' : rest === 1 ? '_and_one' : '_and_more'}`;
  return words.people[key].replace(PLACE, (whole, name) => ({ first, second, third, rest }[name] ?? whole));
}
